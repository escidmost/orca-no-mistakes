import assert from "node:assert/strict";
import { withLivePass } from './live-validation-fixture.ts';
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DomainLedger,
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

class LiveSelectiveFixGit implements GitOperations {
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

class LiveSelectiveFixOrca implements OrcaOperations {
  readonly runId: string;
  readonly launches: WorkerLaunch[] = [];
  reviewReports: StageReport[] = [];
  gateDecisions: string[] = [];
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
    return this.gateDecisions.shift() ?? "approve";
  }

  async setWorktreeStatus(): Promise<void> {}
}

test("uninterrupted selective fix invalidates candidate presentation approvals on candidate change", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-selective-fix-live-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const ledger = new DomainLedger(":memory:");
  t.after(async () => {
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  });

  const runId = "selective-fix-live";
  const git = new LiveSelectiveFixGit(root, oid(1), AUTO_FIX_CONFIG, oid(2));
  const options = {
    githubAuthority: {} as GithubAuthority,
    intent: "Verify candidate-bound presentation approvals invalidate across live candidate change.",
    publicationDestination: "https://github.com/owner/repo.git",
  };

  const orca = new LiveSelectiveFixOrca(runId);
  orca.reviewReports = [
    { findings: [f1, f2], summary: "review on A reports f1 and f2" },
    { findings: [f2], summary: "review on B reports unchanged f2" },
  ];
  orca.gateDecisions = [
    JSON.stringify({ action: "fix", findingIds: ["f1"] }),
    "approve",
  ];

  await assert.rejects(
    runPipeline(options, orca, git, ledger),
    /no publication route/,
  );

  assert.equal(git.headOid, oid(2));
  assert.equal(
    orca.gates,
    2,
    "must open a fresh exact-evidence gate for f2 on candidate B rather than suppressing it as a no-op",
  );

  const audits = ledger.listGateAudit(runId);
  assert.equal(audits.length, 2);
  assert.equal(audits[0].decision, "fix");
  assert.equal(audits[0].stage_id, "review");
  assert.equal(audits[1].decision, "approve");
  assert.equal(audits[1].stage_id, "review");

  const preservedAudits = audits.filter(
    (audit) =>
      audit.resolution.includes("preserved approval") ||
      audit.question.includes("preserved approval"),
  );
  assert.equal(preservedAudits.length, 0, "must not manufacture a preserved approval from a fix decision");

  const evidenceRows = ledger.listEvidence(runId).filter((row) => row.stage_id === "review");
  const candidateAEvidence = evidenceRows.find((row) => row.candidate_commit_oid === oid(1));
  const candidateBEvidence = evidenceRows.find((row) => row.candidate_commit_oid === oid(2));

  assert.ok(candidateAEvidence, "must record authoritative evidence for candidate A");
  assert.ok(candidateBEvidence, "must record authoritative evidence for candidate B");
  assert.equal(audits[0].evidence_sha256, candidateAEvidence.evidence_sha256);
  assert.equal(audits[1].evidence_sha256, candidateBEvidence.evidence_sha256);
});

test("a plain fix round moves the candidate without reopening the stage", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-plain-fix-round-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const ledgerPath = path.join(root, "ledger.sqlite");
  const ledger = new DomainLedger(ledgerPath);
  t.after(async () => {
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  });

  const runId = "plain-fix-round";
  const git = new LiveSelectiveFixGit(root, oid(1), AUTO_FIX_CONFIG, oid(2));
  const f1: Finding = { action: "ask-user", description: "issue one", id: "f1", severity: "error" };
  const f2: Finding = { action: "ask-user", description: "issue two", id: "f2", severity: "error" };
  const orca = new LiveSelectiveFixOrca(runId);
  orca.reviewReports = [
    { findings: [f1, f2], summary: "review on A reports f1 and f2" },
    { findings: [], summary: "review on B is clean" },
  ];
  orca.gateDecisions = [JSON.stringify({ action: "fix", findingIds: ["f1", "f2"] })];

  await assert.rejects(
    runPipeline(
      {
        githubAuthority: {} as GithubAuthority,
        intent: "Verify a plain fix round is a new round, not a reopen.",
        publicationDestination: "https://github.com/owner/repo.git",
      },
      orca,
      git,
      ledger,
    ),
    /no publication route/,
  );
  assert.equal(git.headOid, oid(2));

  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  const keys = (db.prepare("SELECT event_key FROM presentation_snapshots WHERE run_id = ? ORDER BY sequence").all(runId) as { event_key: string }[])
    .map((row) => row.event_key);
  db.close();
  assert.ok(keys.some((key) => key.includes(":stage:review:round:1:started")), "fix round must run as review round 1");
  assert.deepEqual(keys.filter((key) => key.includes(":reopened:")), [], "a fix decision must not reopen the stage");
});
