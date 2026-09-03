import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { DomainLedger, type StageLog } from "../scripts/ledger.ts";
import {
  runPipeline,
  type FixerChangesVerdict,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";
import type { PresentationSnapshot } from "../scripts/presentation.ts";

const commit = "a".repeat(40);
const policy = "b".repeat(64);

const pass = (summary = "passed"): StageReport => ({ findings: [], summary });

function errorSnapshot(runId: string): PresentationSnapshot {
  return {
    attempt: 1,
    mode: { autoFix: false },
    runId,
    sequence: 1,
    stages: [],
    status: "failed",
    transition: { kind: "error-recorded", resumable: true },
    updatedAt: "2026-09-01T00:00:00.000Z",
    version: 1,
  };
}

test("attempt outcome settlement stays atomic with run settlement", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    const repoRoot = "/repo";
    const runId = "run-atomic-outcome";
    const attemptId = "attempt-atomic-1";
    const identity = { actorIdentity: "coordinator", coordinatorIdentity: "coordinator" };
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "settle atomically",
      policySha256: policy,
      repoRoot,
      runId,
      submissionCommitOid: commit,
    });
    const generation = ledger.acquireLease({ branch: "feature", repoRoot, runId });
    ledger.startAttempt({
      ...identity,
      attemptId,
      generationToken: generation,
      runId,
      startedAt: "2026-09-01T00:00:00.000Z",
    });
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "steal the lease",
      policySha256: policy,
      repoRoot,
      runId: "run-lease-thief",
      submissionCommitOid: commit,
    });
    ledger.acquireLease({ branch: "feature", force: true, repoRoot, runId: "run-lease-thief" });

    const outcome = {
      ...identity,
      attemptId,
      candidateCommitOid: commit,
      completedAt: "2026-09-01T00:01:00.000Z",
      custody: {},
      reason: "test worker interrupted",
      receiptDigests: [],
      resumeEligible: true,
      runId,
      stoppingFact: "failed during pipeline execution",
      verdict: "failed" as const,
    };

    assert.equal(
      ledger.settleRunWithAttemptOutcome(
        outcome,
        runId,
        "failed",
        { branch: "feature", generationToken: generation, repoRoot },
        { eventKey: "attempt:1:error", snapshot: errorSnapshot(runId) },
      ),
      false,
    );
    assert.deepEqual(ledger.listAttemptOutcomes(runId), []);
    assert.equal(ledger.runStatus(runId), "in-progress");
    assert.deepEqual(ledger.listPresentationSnapshots(runId), []);

    const settledRun = "run-atomic-settled";
    ledger.startRun({
      baseBranch: "main",
      branch: "atomic",
      intent: "settle atomically",
      policySha256: policy,
      repoRoot,
      runId: settledRun,
      submissionCommitOid: commit,
    });
    const settledGeneration = ledger.acquireLease({
      branch: "atomic",
      repoRoot,
      runId: settledRun,
    });
    ledger.startAttempt({
      ...identity,
      attemptId: "attempt-atomic-2",
      generationToken: settledGeneration,
      runId: settledRun,
      startedAt: "2026-09-01T00:00:00.000Z",
    });
    assert.equal(
      ledger.settleRunWithAttemptOutcome(
        { ...outcome, attemptId: "attempt-atomic-2", runId: settledRun },
        settledRun,
        "failed",
        { branch: "atomic", generationToken: settledGeneration, repoRoot },
        { eventKey: "attempt:1:error", snapshot: errorSnapshot(settledRun) },
      ),
      true,
    );
    assert.equal(ledger.listAttemptOutcomes(settledRun).length, 1);
    assert.equal(ledger.runStatus(settledRun), "failed");
    assert.equal(ledger.leaseFor(repoRoot, "atomic"), undefined);
    assert.equal(ledger.listPresentationSnapshots(settledRun).length, 1);
  } finally {
    ledger.close();
  }
});

class FakeGit implements GitOperations {
  readonly calls: string[] = [];
  static #oid(counter: number): string {
    return counter.toString(16).padStart(40, "0");
  }
  #counter = 1;
  #head = FakeGit.#oid(1);
  #baseOid = FakeGit.#oid(0);
  policyDigest?: string;
  #workerHeads = new Map<string, string>();
  readonly #branch: string;
  readonly #root: string;

  constructor(root = "/repo", branch = "feature") {
    this.#root = root;
    this.#branch = branch;
  }

  async assertReady(): Promise<{
    base: string;
    baseOid: string;
    branch: string;
    head: string;
    root: string;
  }> {
    this.calls.push("assert-ready");
    return {
      base: "main",
      baseOid: this.#baseOid,
      branch: this.#branch,
      head: this.#head,
      root: this.#root,
    };
  }

  async assertClean(): Promise<void> {
    this.calls.push("assert-clean");
  }

  async assertFixerChangesAllowed(): Promise<FixerChangesVerdict> {
    return { changed: true, guardrailViolations: [] };
  }

  async head(): Promise<string> {
    return this.#head;
  }

  async diffBase(base: string): Promise<string> {
    this.calls.push(`diff:${base}`);
    return "";
  }

  async headOf(worktreePath: string): Promise<string> {
    this.calls.push(`headof:${worktreePath}`);
    const oid = FakeGit.#oid(++this.#counter);
    this.#workerHeads.set(worktreePath, oid);
    return oid;
  }

  async worktreeIsReusable(
    worktreePath: string,
    expectedHead: string,
  ): Promise<boolean> {
    this.calls.push(`worktree-reusable:${worktreePath}:${expectedHead}`);
    return this.#workerHeads.get(worktreePath) === expectedHead;
  }

  async resolveRefSha(ref: string): Promise<string | undefined> {
    return `sha-${ref.replaceAll("/", "-")}`;
  }

  async showFile(): Promise<string | undefined> {
    return undefined;
  }

  async pathExists(): Promise<boolean> {
    return false;
  }

  async rebase(base: string): Promise<StageReport> {
    this.calls.push(`rebase:${base}`);
    this.#baseOid = "b".repeat(40);
    this.#head = FakeGit.#oid(++this.#counter);
    return {
      findings: [],
      rebaseUpstreamHead: this.#baseOid,
      summary: "rebased",
    };
  }

  async policySha256(): Promise<string> {
    this.calls.push("policy");
    return this.policyDigest ?? "f".repeat(64);
  }

  async resolveBaseOid(): Promise<string> {
    this.calls.push("resolve-base");
    return this.#baseOid;
  }

  async applyWorktreeCommits(
    sourcePath: string,
    expectedHead: string,
    expectedSourceHead: string,
    fence?: { readonly aborted: boolean },
  ): Promise<boolean> {
    this.calls.push(
      `apply:${sourcePath}:${expectedHead}:${fence?.aborted ? "fenced" : "open"}`,
    );
    if (this.#head !== expectedHead || fence?.aborted) return false;
    const sourceHead = this.#workerHeads.get(sourcePath) ?? expectedSourceHead;
    if (sourceHead !== expectedSourceHead) return false;
    this.#head = sourceHead;
    return true;
  }

  async anchorRecoveryRef(runId: string, oid: string): Promise<void> {
    this.calls.push(`recover:${runId}:${oid}`);
  }
}

class FakeOrca implements OrcaOperations {
  readonly calls: string[] = [];
  readonly launches: WorkerLaunch[] = [];
  #taskNumber = 0;
  #dispatchNumber = 0;
  readonly #runId: string;

  constructor(runId: string) {
    this.#runId = runId;
  }

  async createRun(): Promise<string> {
    return this.#runId;
  }

  async createTask(): Promise<string> {
    return `task-${++this.#taskNumber}`;
  }

  async startWorker(
    taskId: string,
    launch: WorkerLaunch,
  ): Promise<WorkerResult> {
    this.launches.push(launch);
    const dispatchId = `dispatch-${++this.#dispatchNumber}`;
    return {
      deliveryId: `delivery-${dispatchId}`,
      dispatchId,
      report: pass(launch.stage),
      taskId,
      terminalHandle: `term-${dispatchId}`,
      worktreeId:
        launch.worktree === "new-child" ? `repo::/${dispatchId}` : undefined,
      worktreePath:
        launch.worktree === "new-child"
          ? `/worktrees/${dispatchId}`
          : undefined,
    };
  }

  async finishWorker(
    worker: WorkerResult,
    disposition: "release" | "retain",
  ): Promise<void> {
    this.calls.push(`${disposition}:${worker.dispatchId}`);
    if (disposition === "release") worker.shutdownConfirmed = true;
  }

  async removeWorktree(): Promise<void> {}

  async completeTask(): Promise<void> {}

  async createGate(): Promise<string> {
    throw new Error("unexpected gate");
  }

  async waitForGate(): Promise<string> {
    throw new Error("unexpected gate wait");
  }

  async resolveGate(): Promise<void> {}

  async setWorktreeStatus(): Promise<void> {}
}

class OrphanAllocationOrca extends FakeOrca {
  readonly orphanDispatchIds: string[] = [];

  override async startWorker(
    taskId: string,
    launch: WorkerLaunch,
    _fence?: unknown,
    onAllocated?: (worker: WorkerResult) => unknown,
  ): Promise<WorkerResult> {
    const worker = await super.startWorker(taskId, launch);
    if (launch.stage === "test" && this.orphanDispatchIds.length === 0) {
      this.orphanDispatchIds.push(worker.dispatchId);
      onAllocated?.(worker);
      throw new Error("test worker interrupted");
    }
    return worker;
  }
}

test("deferred renderer fallback revokes a pending same-process resume wait", { timeout: 2_000 }, async () => {
  const git = new FakeGit();
  git.policyDigest = "f".repeat(64);
  const deliveryGit = new FakeGit("/origin", "feature");
  const runId = `fallback-resume-${randomUUID()}`;
  class InterruptedOrca extends FakeOrca {
    override async startWorker(
      taskId: string,
      launch: WorkerLaunch,
    ): Promise<WorkerResult> {
      if (launch.stage === "test") {
        this.launches.push(launch);
        throw new Error("test worker interrupted");
      }
      return await super.startWorker(taskId, launch);
    }
  }
  const orca = new InterruptedOrca(runId);
  const ledger = new DomainLedger(":memory:");
  const rendererFactory = (
    _artifactsDir: string,
    _stageLogs: ReadonlyMap<string, StageLog>,
    _resolveGate: unknown,
    _setAutoFix: unknown,
    _requestResume?: () => void,
    onResumeAvailable?: () => void,
    onRendererFailure?: (error: unknown) => void,
  ) => {
    onResumeAvailable?.();
    let failed = false;
    return {
      render(snapshot: {
        error?: { resumable: boolean };
        transition: { kind: string };
      }): void {
        if (
          failed ||
          snapshot.transition.kind !== "error-recorded" ||
          !snapshot.error?.resumable
        ) {
          return;
        }
        failed = true;
        setImmediate(() =>
          onRendererFailure?.(new Error("renderer exploded")),
        );
      },
    };
  };

  try {
    await assert.rejects(
      runPipeline(
        { deliveryGit, intent: "Fail after renderer fallback.", rendererFactory },
        orca,
        git,
        ledger,
      ),
      /test worker interrupted/,
    );
    assert.equal(ledger.runStatus(runId), "failed");
    assert.equal(ledger.listAttemptOutcomes(runId).length, 1);
  } finally {
    ledger.close();
  }
});

test("an undeliverable detached resume notification leaves the run stopped", { timeout: 2_000 }, async () => {
  const git = new FakeGit();
  git.policyDigest = "f".repeat(64);
  const runId = `unreachable-resume-${randomUUID()}`;
  class InterruptedOrca extends FakeOrca {
    notifications = 0;

    override async createGate(): Promise<string> {
      this.notifications += 1;
      throw new Error("origin unavailable");
    }

    override async startWorker(
      taskId: string,
      launch: WorkerLaunch,
    ): Promise<WorkerResult> {
      if (launch.stage === "test") throw new Error("test worker interrupted");
      return await super.startWorker(taskId, launch);
    }
  }
  const orca = new InterruptedOrca(runId);
  const ledger = new DomainLedger(":memory:");
  const rendererFactory = (
    _artifactsDir: string,
    _stageLogs: ReadonlyMap<string, StageLog>,
    _resolveGate: unknown,
    _setAutoFix: unknown,
    _requestResume?: () => void,
    onResumeAvailable?: () => void,
  ) => {
    onResumeAvailable?.();
    return { render(): void {} };
  };

  try {
    await assert.rejects(
      runPipeline(
        { intent: "Stop when the origin cannot be notified.", rendererFactory },
        orca,
        git,
        ledger,
      ),
      /test worker interrupted/,
    );
    assert.equal(orca.notifications, 1);
    assert.equal(ledger.runStatus(runId), "failed");
  } finally {
    ledger.close();
  }
});

test("same-process resume drains registered attempt workers before retrying", async () => {
  const git = new FakeGit();
  git.policyDigest = "f".repeat(64);
  const deliveryGit = new FakeGit("/origin", "feature");
  const runId = `drain-resume-${randomUUID()}`;
  class NotifyingOrca extends OrphanAllocationOrca {
    readonly resumeNotifications: string[] = [];

    override async createGate(
      _taskId?: string,
      question = "",
    ): Promise<string> {
      this.resumeNotifications.push(question);
      return "gate-resume";
    }

    override async waitForGate(gateId = ""): Promise<string> {
      assert.equal(gateId, "gate-resume");
      return "resume";
    }
  }
  const orca = new NotifyingOrca(runId);
  const ledger = new DomainLedger(":memory:");
  const rendererFactory = (
    _artifactsDir: string,
    _stageLogs: ReadonlyMap<string, StageLog>,
    _resolveGate: unknown,
    _setAutoFix: unknown,
    _resume?: () => void,
    onResumeAvailable?: () => void,
  ) => {
    onResumeAvailable?.();
    return {
      render(): void {},
    };
  };

  try {
    const result = await runPipeline(
      { deliveryGit, intent: "Drain orphans before retry.", rendererFactory },
      orca,
      git,
      ledger,
    );

    assert.equal(result.runId, runId);
    assert.equal(ledger.runStatus(runId), "passed");
    assert.equal(orca.orphanDispatchIds.length, 1);
    assert.ok(
      orca.calls.includes(`release:${orca.orphanDispatchIds[0]}`),
      `expected the orphan worker to be released, saw: ${orca.calls.join(",")}`,
    );
    assert.equal(ledger.listAttemptOutcomes(runId).length, 2);
    assert.equal(orca.resumeNotifications.length, 1);
    assert.match(orca.resumeNotifications[0]!, /test worker interrupted/);
  } finally {
    ledger.close();
  }
});

test("a local TUI resume resolves the durable resume gate", async () => {
  const git = new FakeGit();
  git.policyDigest = "f".repeat(64);
  const deliveryGit = new FakeGit("/origin", "feature");
  const runId = `local-resume-${randomUUID()}`;
  let requestResume: (() => void) | undefined;
  let resolveDurableGate: ((resolution: string) => void) | undefined;
  class LocalResumeOrca extends OrphanAllocationOrca {
    readonly durableResolutions: string[] = [];

    override async createGate(): Promise<string> {
      queueMicrotask(() => requestResume?.());
      return "gate-local-resume";
    }

    override async waitForGate(): Promise<string> {
      return await new Promise((resolve) => {
        resolveDurableGate = resolve;
      });
    }

    override async resolveGate(
      _gateId?: string,
      resolution = "",
    ): Promise<void> {
      this.durableResolutions.push(resolution);
      resolveDurableGate?.(resolution);
    }
  }
  const orca = new LocalResumeOrca(runId);
  const ledger = new DomainLedger(":memory:");
  const rendererFactory = (
    _artifactsDir: string,
    _stageLogs: ReadonlyMap<string, StageLog>,
    _resolveGate: unknown,
    _setAutoFix: unknown,
    resume?: () => void,
    onResumeAvailable?: () => void,
  ) => {
    requestResume = resume;
    onResumeAvailable?.();
    return { render(): void {} };
  };

  try {
    const result = await runPipeline(
      { deliveryGit, intent: "Record a local resume durably.", rendererFactory },
      orca,
      git,
      ledger,
    );
    assert.equal(result.runId, runId);
    assert.deepEqual(orca.durableResolutions, ["resume"]);
    assert.equal(ledger.runStatus(runId), "passed");
  } finally {
    ledger.close();
  }
});

test("noninteractive failures also drain registered attempt workers", async () => {
  const git = new FakeGit();
  git.policyDigest = "f".repeat(64);
  const deliveryGit = new FakeGit("/origin", "feature");
  const runId = `drain-plain-${randomUUID()}`;
  const orca = new OrphanAllocationOrca(runId);
  const ledger = new DomainLedger(":memory:");

  try {
    await assert.rejects(
      runPipeline(
        { deliveryGit, intent: "Drain workers without a TUI." },
        orca,
        git,
        ledger,
      ),
      /test worker interrupted/,
    );
    assert.equal(ledger.runStatus(runId), "failed");
    assert.ok(
      orca.calls.includes(`release:${orca.orphanDispatchIds[0]}`),
      `expected the orphan worker to be released, saw: ${orca.calls.join(",")}`,
    );
  } finally {
    ledger.close();
  }
});
