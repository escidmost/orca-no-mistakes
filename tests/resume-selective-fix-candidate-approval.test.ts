import assert from "node:assert/strict";
import { withLivePass } from './live-validation-fixture.ts';
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
  "auto_fix:\n  allow_review_autofix: false\n  guardrails: strict\n";

const f1: Finding = {
  action: "auto-fix",
  description: "Fix finding 1",
  id: "f1",
  severity: "error",
};
const f2: Finding = {
  action: "auto-fix",
  description: "Unchanged finding 2",
  id: "f2",
  severity: "error",
};

class SelectiveFixGit implements GitOperations {
  readonly baseOid = oid(100);
  headOid: string;
  readonly root: string;
  readonly trustedConfig: string;
  fixerHead?: string;

  constructor(root: string, headOid: string, trustedConfig = "", fixerHead?: string) {
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

class SelectiveFixOrca implements OrcaOperations {
  readonly runId: string;
  readonly launches: WorkerLaunch[] = [];
  reviewReports: StageReport[] = [];
  gateDecision = "approve";
  gates = 0;
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
    if (
      launch.stage === "review" &&
      launch.role === "reviewer" &&
      this.launches.filter((l) => l.stage === "review" && l.role === "reviewer").length === 2 &&
      this.runId === "selective-fix-initial"
    ) {
      throw new Error("fixture interrupted after selective fix before reviewer evidence");
    }
    const queued =
      launch.role === "reviewer" ? this.reviewReports.shift() : undefined;
    const dispatchId = `dispatch-${++this.#dispatch}`;
    return {
      dispatchId,
      report: withLivePass(launch, queued ?? pass(`${launch.stage} ${launch.role} passed`)),
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
    return `${this.runId}-gate-${++this.gates}`;
  }

  async waitForGate(): Promise<string> {
    return this.gateDecision;
  }

  async setWorktreeStatus(): Promise<void> {}
}

test("interrupted selective fix invalidates candidate presentation approvals on resume", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-selective-fix-resume-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const ledger = new DomainLedger(":memory:");
  t.after(async () => {
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  });

  const runId = "selective-fix-initial";
  const git = new SelectiveFixGit(root, oid(1), AUTO_FIX_CONFIG, oid(2));
  const options = {
    githubAuthority: {} as GithubAuthority,
    intent: "Verify candidate-bound presentation approvals invalidate on resume.",
    publicationDestination: "https://github.com/owner/repo.git",
  };

  const first = new SelectiveFixOrca(runId);
  first.reviewReports = [
    { findings: [f1, f2], summary: "review on A reports f1 and f2" },
  ];
  first.gateDecision = JSON.stringify({ action: "fix", findingIds: ["f1"] });

  await assert.rejects(
    runPipeline(options, first, git, ledger),
    /fixture interrupted after selective fix before reviewer evidence/,
  );

  assert.equal(git.headOid, oid(2));
  const stageDispositions = ledger.stageDispositions(runId);
  assert.equal(
    stageDispositions.find((row) => row.stage_id === "review"),
    undefined,
    "review stage must be unsettled",
  );
  const initialAudits = ledger.listGateAudit(runId);
  assert.equal(initialAudits.length, 1);
  assert.equal(initialAudits[0].decision, "fix");

  await installAbortReaping({ pid: process.pid });
  const resumed = new SelectiveFixOrca("selective-fix-resume");
  resumed.gateDecision = "approve";
  resumed.reviewReports = [
    { findings: [f2], summary: "review on B reports unchanged f2" },
  ];

  await assert.rejects(
    runPipeline({ ...options, resumeRunId: runId }, resumed, git, ledger),
    /no publication route/,
  );

  assert.equal(
    resumed.gates,
    1,
    "resumed run must open a fresh exact-evidence gate rather than suppressing f2 as a no-op",
  );

  const freshAudits = ledger
    .listGateAudit(runId)
    .filter((audit) => audit.gate_id.startsWith("selective-fix-resume-gate"));
  assert.equal(freshAudits.length, 1);
  assert.equal(freshAudits[0].decision, "approve");
  assert.equal(freshAudits[0].stage_id, "review");

  const latestEvidence = ledger.listEvidence(runId).filter((row) => row.stage_id === "review");
  const round1Evidence = latestEvidence.find((row) => row.candidate_commit_oid === oid(2));
  assert.ok(round1Evidence, "must record authoritative evidence for candidate B");
  assert.equal(freshAudits[0].evidence_sha256, round1Evidence.evidence_sha256);
});
