import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  DomainLedger,
  type RecordEvidenceInput,
} from "../scripts/ledger.ts";
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

const pass = (summary = "passed"): StageReport => ({ findings: [], summary });

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

class DurableResumeOrca extends FakeOrca {
  #pendingResolution: string | undefined;
  #resolveGate: ((resolution: string) => void) | undefined;

  override async createGate(): Promise<string> {
    return "gate-resume";
  }

  override async waitForGate(): Promise<string> {
    if (this.#pendingResolution !== undefined) {
      const resolution = this.#pendingResolution;
      this.#pendingResolution = undefined;
      return resolution;
    }
    return await new Promise((resolve) => {
      this.#resolveGate = resolve;
    });
  }

  override async resolveGate(
    _gateId?: string,
    resolution?: string,
  ): Promise<void> {
    if (resolution === undefined) return;
    if (this.#resolveGate) {
      const resolve = this.#resolveGate;
      this.#resolveGate = undefined;
      resolve(resolution);
    } else {
      this.#pendingResolution = resolution;
    }
  }
}

class EvidencePersistenceFailsLedger extends DomainLedger {
  override recordEvidence(input: RecordEvidenceInput): string {
    if (input.stageId === "test") throw new Error("evidence persistence failed");
    return super.recordEvidence(input);
  }
}

function resumeRendererFactory(
  requestResumeRef: { current?: () => void },
): NonNullable<
  Parameters<typeof runPipeline>[0]["rendererFactory"]
> {
  return (
    _artifactsDir,
    _stageLogs,
    _resolveGate,
    _setAutoFix,
    requestResume?: () => void,
    onResumeAvailable?: () => void,
  ) => {
    requestResumeRef.current = requestResume;
    onResumeAvailable?.();
    return {
      render(snapshot: {
        error?: { resumable: boolean };
        transition: { kind: string };
      }): void {
        if (
          snapshot.transition.kind === "error-recorded" &&
          snapshot.error?.resumable
        ) {
          requestResume?.();
        }
      },
    };
  };
}

test("worker cleanup failure settles the run as non-resumable", async () => {
  const git = new FakeGit();
  git.policyDigest = "f".repeat(64);
  const deliveryGit = new FakeGit("/origin", "feature");
  const runId = `cleanup-nonresumable-${randomUUID()}`;
  class OrphanCleanupFailureOrca extends FakeOrca {
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

    override async finishWorker(
      worker: WorkerResult,
      disposition: "release" | "retain",
    ): Promise<void> {
      if (
        disposition === "release" &&
        this.orphanDispatchIds.includes(worker.dispatchId)
      ) {
        throw new Error("worker shutdown cannot be verified");
      }
      await super.finishWorker(worker, disposition);
    }
  }
  const orca = new OrphanCleanupFailureOrca(runId);
  const ledger = new DomainLedger(":memory:");
  const requestResumeRef: { current?: () => void; requested?: boolean } = {};

  try {
    await assert.rejects(
      runPipeline(
        {
          deliveryGit,
          intent: "Fail cleanup before resume.",
          rendererFactory: (_artifactsDir, _stageLogs, _resolveGate, _setAutoFix, requestResume, onResumeAvailable) => {
            requestResumeRef.current = requestResume;
            onResumeAvailable?.();
            return {
              render(snapshot: {
                error?: { resumable: boolean };
                transition: { kind: string };
              }): void {
                if (
                  snapshot.transition.kind === "error-recorded" &&
                  snapshot.error?.resumable
                ) {
                  requestResumeRef.requested = true;
                  requestResume?.();
                }
              },
            };
          },
        },
        orca,
        git,
        ledger,
      ),
      /failed-attempt worker cleanup failed/,
    );
    assert.equal(ledger.runStatus(runId), "failed");
    const snapshots = ledger.listPresentationSnapshots(runId);
    const errorSnapshots = snapshots.filter(
      (snapshot) => snapshot.transition.kind === "error-recorded",
    );
    assert.equal(errorSnapshots.length, 1);
    assert.equal(errorSnapshots[0]?.transition.kind, "error-recorded");
    assert.equal(
      errorSnapshots[0]?.error?.resumable ?? undefined,
      false,
    );
    assert.equal(requestResumeRef.requested, undefined);
  } finally {
    ledger.close();
  }
});

test("resumed attempt setup failure settles the run before propagating", async () => {
  const git = new FakeGit();
  git.policyDigest = "f".repeat(64);
  const deliveryGit = new FakeGit("/origin", "feature");
  const runId = `resume-setup-strand-${randomUUID()}`;
  class SecondStartAttemptFailsLedger extends DomainLedger {
    #startAttemptCalls = 0;

    override startAttempt(input: {
      actorIdentity: string;
      attemptId: string;
      coordinatorIdentity: string;
      generationToken: number;
      runId: string;
      startedAt: string;
    }): void {
      this.#startAttemptCalls += 1;
      if (this.#startAttemptCalls === 2) {
        throw new Error("startAttempt sabotaged");
      }
      super.startAttempt(input);
    }
  }
  class InterruptedOrca extends DurableResumeOrca {
    #testFailures = 0;

    override async startWorker(
      taskId: string,
      launch: WorkerLaunch,
    ): Promise<WorkerResult> {
      if (launch.stage === "test" && this.#testFailures++ === 0) {
        this.launches.push(launch);
        throw new Error("test worker interrupted");
      }
      return await super.startWorker(taskId, launch);
    }
  }
  const orca = new InterruptedOrca(runId);
  const ledger = new SecondStartAttemptFailsLedger(":memory:");
  const requestResumeRef: { current?: () => void } = {};

  try {
    await assert.rejects(
      runPipeline(
        {
          deliveryGit,
          intent: "Fail during resumed attempt setup.",
          rendererFactory: resumeRendererFactory(requestResumeRef),
        },
        orca,
        git,
        ledger,
      ),
      /startAttempt sabotaged/,
    );
    assert.equal(ledger.runStatus(runId), "failed");
    assert.equal(
      ledger.leaseFor(deliveryGit === git ? "/repo" : "/origin", "feature"),
      undefined,
    );
    const snapshots = ledger.listPresentationSnapshots(runId);
    const last = snapshots.at(-1);
    assert.equal(last?.transition.kind, "run-completed");
    assert.equal(last?.status, "failed");
    assert.ok(
      snapshots.some(
        (snapshot) => snapshot.transition.kind === "error-recorded",
      ),
    );
    assert.equal(ledger.listAttemptOutcomes(runId).length, 1);
  } finally {
    ledger.close();
  }
});

test("resumed attempt setup failure after startAttempt records its outcome", async () => {
  const git = new FakeGit();
  git.policyDigest = "f".repeat(64);
  const deliveryGit = new FakeGit("/origin", "feature");
  const runId = `resume-setup-outcome-${randomUUID()}`;
  class ClearResumeClaimFailsLedger extends DomainLedger {
    override clearResumeClaim(): void {
      throw new Error("clearResumeClaim sabotaged");
    }
  }
  class InterruptedOrca extends DurableResumeOrca {
    #testFailures = 0;

    override async startWorker(
      taskId: string,
      launch: WorkerLaunch,
    ): Promise<WorkerResult> {
      if (launch.stage === "test" && this.#testFailures++ === 0) {
        this.launches.push(launch);
        throw new Error("test worker interrupted");
      }
      return await super.startWorker(taskId, launch);
    }
  }
  const orca = new InterruptedOrca(runId);
  const ledger = new ClearResumeClaimFailsLedger(":memory:");
  const requestResumeRef: { current?: () => void } = {};

  try {
    await assert.rejects(
      runPipeline(
        {
          deliveryGit,
          intent: "Fail after the resumed attempt starts.",
          rendererFactory: resumeRendererFactory(requestResumeRef),
        },
        orca,
        git,
        ledger,
      ),
      /clearResumeClaim sabotaged/,
    );
    assert.equal(ledger.runStatus(runId), "failed");
    assert.equal(
      ledger.leaseFor("/origin", "feature"),
      undefined,
    );
    assert.equal(ledger.listAttemptOutcomes(runId).length, 2);
    const snapshots = ledger.listPresentationSnapshots(runId);
    assert.ok(
      snapshots.some(
        (snapshot) =>
          snapshot.transition.kind === "error-recorded" &&
          snapshot.error?.resumable === false,
      ),
    );
    assert.equal(snapshots.at(-1)?.transition.kind, "run-completed");
  } finally {
    ledger.close();
  }
});

test("evidence persistence failures are never declared resumable", async () => {
  const git = new FakeGit();
  git.policyDigest = "f".repeat(64);
  const deliveryGit = new FakeGit("/origin", "feature");
  const runId = `evidence-nonresumable-${randomUUID()}`;
  const orca = new FakeOrca(runId);
  const ledger = new EvidencePersistenceFailsLedger(":memory:");
  const snapshots: PresentationSnapshot[] = [];

  try {
    await assert.rejects(
      runPipeline(
        {
          deliveryGit,
          intent: "Reject unsafe evidence failures.",
          rendererFactory: () => ({
            render(snapshot): void {
              snapshots.push(snapshot);
            },
          }),
        },
        orca,
        git,
        ledger,
      ),
      /evidence persistence failed/,
    );
    assert.equal(ledger.runStatus(runId), "failed");
    assert.equal(
      snapshots.findLast(
        (snapshot) => snapshot.transition.kind === "error-recorded",
      )?.error?.resumable,
      false,
    );
  } finally {
    ledger.close();
  }
});
