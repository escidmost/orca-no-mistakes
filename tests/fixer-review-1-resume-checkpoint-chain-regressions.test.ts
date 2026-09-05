import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  installAbortReaping,
  runPipeline,
  type Finding,
  type FixerChangesVerdict,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";
import type { GithubAuthority } from "../scripts/github.ts";

const oid = (value: number): string => value.toString(16).padStart(40, "0");
const pass = (summary: string): StageReport => ({ findings: [], summary });
const AUTO_FIX_CONFIG =
  "auto_fix:\n  allow_review_autofix: true\n  guardrails: strict\n";
const finding: Finding = {
  action: "auto-fix",
  description: "Repair the implementation.",
  id: "review-finding",
  severity: "error",
};

class ChainGit implements GitOperations {
  readonly baseOid = oid(100);
  headOid: string;
  readonly root: string;
  readonly trustedConfig: string;
  readonly fixerHead?: string;

  constructor(
    root: string,
    headOid: string,
    trustedConfig = "",
    fixerHead?: string,
  ) {
    this.root = root;
    this.headOid = headOid;
    this.trustedConfig = trustedConfig;
    this.fixerHead = fixerHead;
  }

  async assertReady() {
    return {
      base: "main",
      baseOid: this.baseOid,
      branch: "feature",
      head: this.headOid,
      root: this.root,
    };
  }

  async assertClean(): Promise<void> {}

  async assertFixerChangesAllowed(): Promise<FixerChangesVerdict> {
    return { changed: true, guardrailViolations: [] };
  }

  async head(): Promise<string> {
    return this.headOid;
  }

  async diffBase(): Promise<string> {
    return "";
  }

  async rebase(): Promise<StageReport> {
    return { ...pass("rebased"), rebaseUpstreamHead: this.baseOid };
  }

  async resolveRefSha(): Promise<string> {
    return this.baseOid;
  }

  async showFile(): Promise<string | undefined> {
    return this.trustedConfig || undefined;
  }

  async pathExists(): Promise<boolean> {
    return this.trustedConfig.length > 0;
  }

  async policySha256(): Promise<string> {
    return "f".repeat(64);
  }

  async resolveBaseOid(): Promise<string> {
    return this.baseOid;
  }

  async applyWorktreeCommits(
    _sourcePath: string,
    expectedHead: string,
    expectedSourceHead: string,
  ): Promise<boolean> {
    if (this.headOid !== expectedHead) return false;
    this.headOid = expectedSourceHead;
    return true;
  }

  async headOf(): Promise<string> {
    return this.fixerHead ?? this.headOid;
  }

  async worktreeIsReusable(): Promise<boolean> {
    return false;
  }

  async anchorRecoveryRef(): Promise<void> {}
}

class ChainOrca implements OrcaOperations {
  readonly runId: string;
  readonly launches: WorkerLaunch[] = [];
  reviewReports: StageReport[] = [];
  gateDecision = "approve";
  #task = 0;
  #dispatch = 0;

  constructor(runId: string) {
    this.runId = runId;
  }

  async createRun(): Promise<string> {
    return this.runId;
  }

  async createTask(): Promise<string> {
    return `task-${++this.#task}`;
  }

  async startWorker(
    taskId: string,
    launch: WorkerLaunch,
  ): Promise<WorkerResult> {
    this.launches.push(launch);
    const queued =
      launch.role === "reviewer" ? this.reviewReports.shift() : undefined;
    const dispatchId = `dispatch-${++this.#dispatch}`;
    return {
      dispatchId,
      report: queued ?? pass(`${launch.stage} ${launch.role} passed`),
      taskId,
      terminalHandle: `term-${dispatchId}`,
      worktreeId: launch.worktree === "new-child" ? dispatchId : undefined,
      worktreePath:
        launch.worktree === "new-child"
          ? path.join(this.runId, dispatchId)
          : undefined,
    };
  }

  async finishWorker(worker: WorkerResult): Promise<void> {
    worker.shutdownConfirmed = true;
  }

  async removeWorktree(): Promise<void> {}

  async completeTask(): Promise<void> {}

  async createGate(): Promise<string> {
    return "gate-1";
  }

  async waitForGate(): Promise<string> {
    return this.gateDecision;
  }

  async setWorktreeStatus(): Promise<void> {}
}

test("release 2 resume walks the final checkpoint of each stage", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-resume-chain-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  });
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const runId = "resume-checkpoint-chain";
  const intent = "Resume past a committed fixer round.";
  const submission = oid(1);
  const fixed = oid(2);
  const ledger = new DomainLedger(":memory:");
  const authority = {} as GithubAuthority;

  try {
    const git = new ChainGit(root, submission, AUTO_FIX_CONFIG, fixed);
    const first = new ChainOrca(runId);
    first.reviewReports = [
      { findings: [finding], summary: "review found findings" },
    ];
    await assert.rejects(
      runPipeline(
        {
          githubAuthority: authority,
          intent,
          publicationDestination: "https://github.com/owner/repo.git",
        },
        first,
        git,
        ledger,
      ),
      /no publication route/,
    );
    assert.ok(first.launches.some((launch) => launch.role === "fixer"));
    assert.ok(
      first.launches.some(
        (launch) => launch.stage === "review" && launch.role === "reviewer",
      ),
    );

    await installAbortReaping({ pid: process.pid });
    const resumed = new ChainOrca("orchestration-resume");
    await assert.rejects(
      runPipeline(
        {
          githubAuthority: authority,
          intent,
          publicationDestination: "https://github.com/owner/repo.git",
          resumeRunId: runId,
        },
        resumed,
        git,
        ledger,
      ),
      /no publication route/,
    );
    assert.ok(
      resumed.launches.every((launch) => launch.stage !== "review"),
    );
  } finally {
    ledger.close();
  }
});

test("approved fixer-no-change stages bind worker evidence durably", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-no-change-approve-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  });
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const runId = "no-change-approve";
  const intent = "Approve a fixer that produced no change.";
  const submission = oid(1);
  const ledger = new DomainLedger(":memory:");
  const authority = {} as GithubAuthority;

  try {
    const git = new ChainGit(root, submission, AUTO_FIX_CONFIG);
    const first = new ChainOrca(runId);
    first.reviewReports = [
      { findings: [finding], summary: "review found findings" },
    ];
    await assert.rejects(
      runPipeline(
        {
          githubAuthority: authority,
          intent,
          publicationDestination: "https://github.com/owner/repo.git",
        },
        first,
        git,
        ledger,
      ),
      /no publication route/,
    );

    const rows = ledger.listEvidence(runId);
    const reviewerRow = rows.find(
      (row) =>
        row.stage_id === "review" && row.worker_identity.startsWith("reviewer:"),
    );
    const diagnosticRow = rows.find(
      (row) => row.worker_identity === "coordinator:fixer-no-change",
    );
    assert.ok(reviewerRow);
    assert.ok(diagnosticRow);
    const reviewDisposition = ledger
      .stageDispositions(runId)
      .find((row) => row.stage_id === "review");
    assert.ok(reviewDisposition);
    assert.equal(
      reviewDisposition.evidence_sha256,
      reviewerRow.evidence_sha256,
    );
    assert.notEqual(
      reviewDisposition.evidence_sha256,
      diagnosticRow.evidence_sha256,
    );
    assert.ok(
      ledger
        .listGateAudit(runId)
        .some(
          (audit) =>
            audit.decision === "approve" &&
            audit.evidence_sha256 === diagnosticRow.evidence_sha256,
        ),
    );

    await installAbortReaping({ pid: process.pid });
    const resumed = new ChainOrca("orchestration-resume");
    await assert.rejects(
      runPipeline(
        {
          githubAuthority: authority,
          intent,
          publicationDestination: "https://github.com/owner/repo.git",
          resumeRunId: runId,
        },
        resumed,
        git,
        ledger,
      ),
      /no publication route/,
    );
    assert.ok(
      resumed.launches.every((launch) => launch.stage !== "review"),
    );
  } finally {
    ledger.close();
  }
});
