import assert from "node:assert/strict";
import { withLivePass } from './live-validation-fixture.ts';
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

const oid = (value: number): string => value.toString(16).padStart(40, "0");
const pass = (summary: string): StageReport => ({ findings: [], summary });

class ResumeGit implements GitOperations {
  headOid = oid(1);
  readonly baseOid = oid(100);
  guardrailViolations: string[] = [];
  readonly root: string;
  readonly trustedConfig: string;
  #workerOid = 1;

  constructor(root: string, trustedConfig = "") {
    this.root = root;
    this.trustedConfig = trustedConfig;
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
    return { changed: true, guardrailViolations: this.guardrailViolations };
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
    this.#workerOid += 1;
    return oid(this.#workerOid);
  }

  async worktreeIsReusable(): Promise<boolean> {
    return false;
  }

  async anchorRecoveryRef(): Promise<void> {}
}

class ResumeOrca implements OrcaOperations {
  readonly completed: string[] = [];
  readonly createdTasks: { deps: string[]; id: string; spec: string }[] = [];
  readonly launches: WorkerLaunch[] = [];
  readonly runId: string;
  interruptStage?: string;
  reviewReports: StageReport[] = [];
  #task = 0;
  #dispatch = 0;

  constructor(runId: string) {
    this.runId = runId;
  }

  async createRun(): Promise<string> {
    return this.runId;
  }

  async createTask(
    spec: string,
    options: { deps?: string[] } = {},
  ): Promise<string> {
    const id = `task-${++this.#task}`;
    this.createdTasks.push({ deps: options.deps ?? [], id, spec });
    return id;
  }

  async startWorker(
    taskId: string,
    launch: WorkerLaunch,
  ): Promise<WorkerResult> {
    this.launches.push(launch);
    const queuedReviewReport =
      launch.stage === "review" && launch.role === "reviewer"
        ? this.reviewReports.shift()
        : undefined;
    if (
      launch.stage === this.interruptStage &&
      launch.role === "reviewer" &&
      queuedReviewReport === undefined
    ) {
      throw new Error(`${launch.stage} worker interrupted`);
    }
    const dispatchId = `dispatch-${++this.#dispatch}`;
    const report =
      queuedReviewReport ?? pass(`${launch.stage} ${launch.role} passed`);
    return {
      dispatchId,
      report: withLivePass(launch, report),
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

  async completeTask(taskId: string): Promise<void> {
    this.completed.push(taskId);
  }

  async createGate(): Promise<string> {
    throw new Error("unexpected gate");
  }

  async waitForGate(): Promise<string> {
    throw new Error("unexpected gate wait");
  }

  async setWorktreeStatus(): Promise<void> {}
}

test("resume reruns review after advisory fixer evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-resume-advisory-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const runId = "resume-advisory-evidence";
  const intent = "Resume an advisory fixer interruption.";
  const git = new ResumeGit(
    root,
    "auto_fix:\n  allow_review_autofix: true\n  guardrails: advisory\n",
  );
  git.guardrailViolations = ["fixer changed guarded validation"];
  const ledger = new DomainLedger(":memory:");
  const first = new ResumeOrca(runId);
  first.interruptStage = "review";
  const finding: Finding = {
    action: "auto-fix",
    description: "Repair the implementation.",
    id: "review-finding",
    severity: "error",
  };
  first.reviewReports = [{ findings: [finding], summary: "review failed" }];

  try {
    await assert.rejects(
      runPipeline({ intent }, first, git, ledger),
      /review worker interrupted/,
    );
    assert.equal(ledger.runStatus(runId), "failed");
    assert.ok(
      ledger
        .listEvidence(runId)
        .some(
          ({ worker_identity }) =>
            worker_identity === "coordinator:fixer-guardrail-advisory",
        ),
    );

    const resumed = new ResumeOrca("new-orchestration-run");
    resumed.reviewReports = [pass("review passed after fix")];
    await runPipeline({ intent, resumeRunId: runId }, resumed, git, ledger);

    assert.equal(resumed.launches[0]?.stage, "review");
    assert.equal(resumed.launches[0]?.role, "reviewer");
    assert.equal(ledger.runStatus(runId), "passed");
  } finally {
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  }
});

test("configured resume settles and depends on reused intent task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-resume-intent-task-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const runId = "resume-intent-task";
  const intent = "Resume after the intent stage.";
  const git = new ResumeGit(root);
  const ledger = new DomainLedger(":memory:");
  const first = new ResumeOrca(runId);
  first.interruptStage = "test";

  try {
    await assert.rejects(
      runPipeline({ intent }, first, git, ledger),
      /test worker interrupted/,
    );

    const resumed = new ResumeOrca("new-orchestration-run");
    await runPipeline(
      {
        intent,
        intentTaskId: "resume-intent-placeholder",
        resumeRunId: runId,
      },
      resumed,
      git,
      ledger,
    );

    assert.ok(resumed.completed.includes("resume-intent-placeholder"));
    assert.deepEqual(resumed.createdTasks[0]?.deps, [
      "resume-intent-placeholder",
    ]);
  } finally {
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  }
});
