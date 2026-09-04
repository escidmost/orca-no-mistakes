import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PIPELINE_STEPS } from "../scripts/config.ts";
import { DomainLedger } from "../scripts/ledger.ts";
import {
  runPipeline,
  type Finding,
  type FixerChangesVerdict,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";
import {
  PresentationPublisher,
  type PresentationSnapshot,
} from "../scripts/presentation.ts";
import { RailTuiRenderer } from "../scripts/tui.ts";

const commit = "a".repeat(40);
const policy = "b".repeat(64);

function modeSnapshot(
  runId: string,
  enabled: boolean,
  sequence: number,
): PresentationSnapshot {
  return {
    attempt: 1,
    mode: { autoFix: enabled },
    runId,
    sequence,
    stages: [],
    status: "failed",
    transition: { enabled, kind: "mode-changed" },
    updatedAt: "2026-08-31T00:00:00.000Z",
    version: 1,
  };
}

test("repository migration preserves auto-fix mode events without row id collisions", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-mode-event-migration-"));
  const repo = path.join(temp, "repo");
  const legacyPath = path.join(temp, "legacy", "ledger.db");
  try {
    execFileSync("git", ["-c", "init.templateDir=", "init", "-b", "main", repo]);
    const repoRoot = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();

    const destination = new DomainLedger({ legacyPath, repositoryPath: repo });
    destination.startRun({
      baseBranch: "main",
      branch: "local",
      intent: "Hold destination mode history.",
      policySha256: policy,
      repoRoot,
      runId: "local-mode-history",
      submissionCommitOid: commit,
    });
    destination.recordAutoFixMode("local-mode-history", true, "initial");
    destination.recordAutoFixMode("local-mode-history", false, "operator");
    destination.finishRun("local-mode-history", "failed");
    destination.close();

    const legacy = new DomainLedger(legacyPath);
    legacy.startRun({
      baseBranch: "main",
      branch: "legacy",
      intent: "Migrate legacy mode history.",
      policySha256: policy,
      repoRoot,
      runId: "legacy-mode-history",
      submissionCommitOid: commit,
    });
    legacy.recordAutoFixMode("legacy-mode-history", true, "initial");
    legacy.recordAutoFixMode("legacy-mode-history", false, "operator");
    legacy.recordPresentationSnapshot(
      "legacy-mode-history",
      "mode:2:off",
      modeSnapshot("legacy-mode-history", false, 1),
    );
    legacy.finishRun("legacy-mode-history", "failed");
    legacy.close();

    const migrated = new DomainLedger({ legacyPath, repositoryPath: repo });
    assert.deepEqual(
      migrated
        .listAutoFixModeEvents("legacy-mode-history")
        .map(({ enabled, source }) => ({ enabled, source })),
      [
        { enabled: true, source: "initial" },
        { enabled: false, source: "operator" },
      ],
    );
    assert.equal(migrated.latestAutoFixMode("legacy-mode-history"), false);
    assert.equal(migrated.listAutoFixModeEvents("local-mode-history").length, 2);
    assert.equal(
      migrated.recordPresentationSnapshot(
        "legacy-mode-history",
        "mode:3:on",
        modeSnapshot("legacy-mode-history", true, 2),
      ),
      true,
    );
    assert.equal(
      migrated.recordPresentationSnapshot(
        "legacy-mode-history",
        "mode:2:off",
        modeSnapshot("legacy-mode-history", false, 1),
      ),
      false,
    );
    migrated.close();
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

class AdvisoryGit implements GitOperations {
  headOid = commit;
  readonly baseOid = "1".repeat(40);
  guardrailViolations: string[] = [];
  readonly root: string;
  readonly trustedConfig: string;

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
    return { findings: [], summary: "rebased", rebaseUpstreamHead: this.baseOid };
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
    return "2".repeat(40);
  }

  async worktreeIsReusable(): Promise<boolean> {
    return false;
  }

  async anchorRecoveryRef(): Promise<void> {}
}

class AdvisoryOrca implements OrcaOperations {
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
      queuedReviewReport ??
      ({ findings: [], summary: `${launch.stage} ${launch.role} passed` } as StageReport);
    return {
      dispatchId,
      report,
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

test("advisory fixer evidence leaves reviewer findings open in presentation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-advisory-findings-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const runId = "advisory-open-findings";
  const git = new AdvisoryGit(
    root,
    "auto_fix:\n  allow_review_autofix: true\n  guardrails: advisory\n",
  );
  git.guardrailViolations = ["fixer changed guarded validation"];
  const ledger = new DomainLedger(":memory:");
  const first = new AdvisoryOrca(runId);
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
      runPipeline({ intent: "Interrupt after advisory fixer evidence." }, first, git, ledger),
      /review worker interrupted/,
    );
    assert.ok(
      ledger
        .listEvidence(runId)
        .some(
          ({ worker_identity }) =>
            worker_identity === "coordinator:fixer-guardrail-advisory",
        ),
    );
    const snapshots = ledger.listPresentationSnapshots(runId);
    assert.ok(snapshots.length > 0);
    const review = snapshots
      .at(-1)!
      .stages.find((stage) => stage.id === "review");
    assert.equal(review?.openFindings, 1);
    assert.equal(review?.fixedFindings, 0);
    assert.equal(review?.findings?.length, 1);
    assert.equal(review?.findings?.[0]?.id, "review-finding");
    assert.equal(review?.findings?.[0]?.disposition, "open");
  } finally {
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  }
});

test("findings projections preserve duplicate finding id occurrences", () => {
  const publisher = new PresentationPublisher(
    {
      listPresentationSnapshots: () => [],
      recordPresentationSnapshot: () => true,
    },
    "duplicate-finding-ids",
  );
  const occurrence = (description: string) => ({
    description,
    id: "shared-id",
    severity: "error" as const,
  });
  const reviewStage = () =>
    publisher.current.stages.find((stage) => stage.id === "review");

  publisher.publish("findings:round-0", {
    actionable: 2,
    findings: [occurrence("First occurrence"), occurrence("Second occurrence")],
    kind: "findings-recorded",
    round: 0,
    stage: "review",
    total: 2,
  });
  assert.equal(reviewStage()?.openFindings, 2);
  assert.equal(reviewStage()?.fixedFindings, 0);
  assert.equal(reviewStage()?.totalFindings, 2);
  assert.equal(reviewStage()?.findings?.length, 2);

  publisher.publish("findings:round-1", {
    actionable: 2,
    findings: [occurrence("First occurrence"), occurrence("Second occurrence")],
    kind: "findings-recorded",
    round: 1,
    stage: "review",
    total: 2,
  });
  assert.equal(reviewStage()?.openFindings, 2);
  assert.equal(reviewStage()?.fixedFindings, 0);
  assert.equal(reviewStage()?.findings?.length, 2);
  assert.deepEqual(
    reviewStage()?.findings?.map(({ disposition }) => disposition),
    ["open", "open"],
  );

  publisher.publish("findings:round-2", {
    actionable: 1,
    findings: [occurrence("Only one now")],
    kind: "findings-recorded",
    round: 2,
    stage: "review",
    total: 1,
  });
  assert.equal(reviewStage()?.openFindings, 1);
  assert.equal(reviewStage()?.fixedFindings, 1);
  assert.equal(reviewStage()?.findings?.length, 2);
});

test("operator mode events persist atomically with their presentation snapshot", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    const runId = "atomic-mode-toggle";
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Toggle atomically.",
      policySha256: policy,
      repoRoot: "/repo",
      runId,
      submissionCommitOid: commit,
    });
    assert.equal(ledger.recordAutoFixMode(runId, true, "initial"), true);
    const publisher = new PresentationPublisher(ledger, runId);
    const toggle = (eventKey: string, enabled: boolean): boolean => {
      let committed = false;
      publisher.publish(eventKey, { enabled, kind: "mode-changed" }, (snapshot) => {
        committed = ledger.recordAutoFixMode(runId, enabled, "operator", {
          eventKey,
          snapshot,
        });
        return committed;
      });
      return committed;
    };

    assert.equal(toggle("mode:2:off", false), true);
    assert.equal(ledger.latestAutoFixMode(runId), false);
    assert.equal(publisher.current.mode.autoFix, false);

    assert.equal(toggle("mode:2:off", false), false);
    assert.equal(ledger.listAutoFixModeEvents(runId).length, 2);

    assert.equal(
      ledger.recordPresentationSnapshot(
        runId,
        "conflicting-event",
        modeSnapshot(runId, true, publisher.current.sequence + 1),
      ),
      true,
    );
    assert.throws(() => toggle("mode:3:on", true), /presentation sequence/);
    assert.equal(ledger.listAutoFixModeEvents(runId).length, 2);
    assert.equal(ledger.latestAutoFixMode(runId), false);
  } finally {
    ledger.close();
  }
});

class FakeInput extends EventEmitter {
  isRaw = false;
  isTTY = true;
  paused = true;

  isPaused(): boolean {
    return this.paused;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

class FakeOutput extends EventEmitter {
  columns = 160;
  isTTY = true;
  rows = 40;
  readonly writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

function stageSnapshot(sequence: number): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: "review",
    mode: { autoFix: true },
    runId: "run-tui-sync-throw",
    sequence,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      id,
      round: 1,
      status: id === "review" ? "active" : "pending",
      totalFindings: 0,
    })),
    status: "in-progress",
    transition: { kind: "round-started", round: 1, stage: "review" },
    updatedAt: new Date(0).toISOString(),
    version: 1,
  };
}

test("synchronous setAutoFix failures keep the TUI alive", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const failures: boolean[] = [];
  const renderer = new RailTuiRenderer(
    input,
    output,
    "/unused",
    new Map(),
    undefined,
    undefined,
    (enabled) => {
      failures.push(enabled);
      throw new Error("ledger exploded");
    },
    undefined,
    undefined,
    true,
  );

  try {
    renderer.render(stageSnapshot(1));
    input.emit("data", "a");
    await new Promise((resolve) => setImmediate(resolve));
    input.emit("data", "a");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(failures, [false, false]);
    assert.equal(input.paused, false);
    assert.match(output.writes.at(-1) ?? "", /Auto-fix unchanged/);
  } finally {
    renderer.close();
  }
});
