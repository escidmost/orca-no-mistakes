import assert from "node:assert/strict";
import { withLivePass } from './live-validation-fixture.ts';
import test from "node:test";

import {
  runPipeline,
  type FixerChangesVerdict,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";

function pass(stage: string): StageReport {
  return {
    findings: [],
    summary: `${stage} passed`,
  };
}

class FakeGit implements GitOperations {
  readonly calls: string[] = [];
  static #oid(counter: number): string {
    return counter.toString(16).padStart(40, "0");
  }
  #counter = 1;
  #head = FakeGit.#oid(1);
  #baseOid = FakeGit.#oid(0);
  policyDigest?: string;
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

  async headOf(): Promise<string> {
    return FakeGit.#oid(++this.#counter);
  }

  async worktreeIsReusable(): Promise<boolean> {
    return false;
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
    return {
      findings: [],
      rebaseUpstreamHead: this.#baseOid,
      summary: "rebased",
    };
  }

  async policySha256(): Promise<string> {
    return this.policyDigest ?? "f".repeat(64);
  }

  async resolveBaseOid(): Promise<string> {
    return this.#baseOid;
  }

  async applyWorktreeCommits(
    _sourcePath: string,
    _expectedHead: string,
    expectedSourceHead: string,
  ): Promise<boolean> {
    this.#head = expectedSourceHead;
    return true;
  }

  async anchorRecoveryRef(): Promise<void> {}
}

class FakeOrca implements OrcaOperations {
  readonly calls: string[] = [];
  readonly tasks: {
    deps: string[];
    id: string;
    parent?: string;
    spec: string;
  }[] = [];
  readonly reports = new Map<string, StageReport[]>();
  gateResolution = "approve";
  #taskNumber = 0;
  #dispatchNumber = 0;
  readonly #runId: string;

  constructor(runId = "test-run") {
    this.#runId = runId;
  }

  async createRun(objective: string): Promise<string> {
    this.calls.push(`run:${objective}`);
    return this.#runId;
  }

  async createTask(
    spec: string,
    options: { deps?: string[]; parent?: string } = {},
  ): Promise<string> {
    const id = `task-${++this.#taskNumber}`;
    this.tasks.push({
      id,
      spec,
      deps: options.deps ?? [],
      parent: options.parent,
    });
    return id;
  }

  async startWorker(
    taskId: string,
    launch: WorkerLaunch,
  ): Promise<WorkerResult> {
    const dispatchId = `dispatch-${++this.#dispatchNumber}`;
    const stage = launch.stage;
    const reports = this.reports.get(stage) ?? [pass(stage)];
    const report = withLivePass(launch, reports.shift() ?? pass(stage));
    this.reports.set(stage, reports);
    return {
      deliveryId: `delivery-${dispatchId}`,
      dispatchId,
      report,
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

  async completeTask(taskId: string, report: StageReport): Promise<void> {
    this.calls.push(`complete:${taskId}:${report.summary}`);
  }

  #resolveResumeGate?: (resolution: string) => void;

  async createGate(_taskId?: string, _question?: string, options?: readonly string[]): Promise<string> {
    return options?.includes("resume") ? "gate-resume" : "gate-1";
  }

  async waitForGate(gateId?: string): Promise<string> {
    if (gateId === "gate-resume") {
      return await new Promise((resolve) => {
        this.#resolveResumeGate = resolve;
      });
    }
    return this.gateResolution;
  }

  async resolveGate(gateId: string, resolution: string): Promise<void> {
    if (gateId === "gate-resume") {
      this.#resolveResumeGate?.(resolution);
      return;
    }
    this.gateResolution = resolution;
  }

  async setWorktreeStatus(comment: string, status?: string): Promise<void> {
    this.calls.push(`status:${status ?? ""}:${comment}`);
  }
}

test("Finding 1: stopped notifications delivered via notifyRunResult only without setting invalid worktree status", async () => {
  let notifyAttempts = 0;
  let resumeTriggered = false;
  const statusCalls: { comment: string; status?: string }[] = [];

  const gitOps = new FakeGit();
  class StrictStatusOrca extends FakeOrca {
    notified: { outcome: string; summary: string }[] = [];
    attempts = 0;

    override async startWorker(
      taskId: string,
      launch: WorkerLaunch,
    ): Promise<WorkerResult> {
      const worker = await super.startWorker(taskId, launch);
      if (launch.role === "reviewer") {
        this.attempts += 1;
        if (this.attempts === 1) {
          worker.failedOutcome = true;
        }
      }
      return worker;
    }

    override async setWorktreeStatus(comment: string, status?: string): Promise<void> {
      statusCalls.push({ comment, status });
      const validStatuses = new Set(["todo", "in-progress", "in-review", "completed", undefined]);
      if (!validStatuses.has(status)) {
        throw new Error(`Unsupported workspace status: ${status}`);
      }
      await super.setWorktreeStatus(comment, status);
    }

    async notifyRunResult(outcome: string, summary: string): Promise<void> {
      if (outcome === "stopped") {
        notifyAttempts++;
        if (notifyAttempts === 1) {
          throw new Error("transient notification outage on first attempt");
        }
        this.notified.push({ outcome, summary });
      }
    }
  }

  const orca = new StrictStatusOrca("stopped-notify-only-run");
  orca.reports.set("review", [
    {
      findings: [
        {
          action: "auto-fix",
          description: "Crash finding",
          id: "crash-finding",
          severity: "error",
        },
      ],
      summary: "one finding",
    },
    pass("clean review"),
  ]);

  await runPipeline(
    {
      intent: "Test stopped notification delivery via notifyRunResult only",
      rendererFactory: (
        _artifactsDir,
        _stageLogs,
        _resolveGate,
        _setAutoFix,
        requestResume,
        onResumeAvailable,
      ) => {
        onResumeAvailable?.();
        setTimeout(() => {
          if (!resumeTriggered) {
            resumeTriggered = true;
            requestResume?.();
          }
        }, 1200);
        return {
          close() {},
          render() {},
        };
      },
    },
    orca,
    gitOps,
  );

  assert.equal(notifyAttempts, 2, "notifyRunResult should retry and succeed on attempt 2");
  assert.equal(orca.notified[0]?.outcome, "stopped");
  assert.ok(
    statusCalls.every((call) => call.status !== "stopped"),
    "setWorktreeStatus must not be called with status 'stopped'",
  );
  assert.equal(resumeTriggered, true, "resume was triggered");
});
