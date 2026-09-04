import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PIPELINE_STEPS } from "../scripts/config.ts";
import { DomainLedger } from "../scripts/ledger.ts";
import {
  runPipeline,
  type FixerChangesVerdict,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";
import { RailTuiRenderer } from "../scripts/tui.ts";

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
  columns = 100;
  isTTY = true;
  rows = 24;
  readonly writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

function cleanScreen(screen: string): string {
  return screen
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, "")
    .replace(/\r/gu, "")
    .replace(/\u0007/gu, "");
}

function nextDraw(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

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
    const report = reports.shift() ?? pass(stage);
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

test("Finding 1: operator-enabled auto-fix is restored on fresh-process resume", async () => {
  const ledger = new DomainLedger(":memory:");
  const git = new FakeGit();
  git.policyDigest = "f".repeat(64);
  const runId = "operator-autofix-resume-run";

  class InterruptedFixerOrca extends FakeOrca {
    override async startWorker(
      taskId: string,
      launch: WorkerLaunch,
    ): Promise<WorkerResult> {
      if (launch.role === "fixer") {
        throw new Error("fixer interrupted");
      }
      return await super.startWorker(taskId, launch);
    }
  }

  const interrupted = new InterruptedFixerOrca(runId);
  interrupted.gateResolution = "fix review-defect";
  interrupted.reports.set("review", [
    {
      findings: [
        {
          action: "ask-user",
          description: "Apply review fix.",
          id: "review-defect",
          severity: "error",
        },
      ],
      summary: "review requires fix",
    },
  ]);

  let toggled = false;

  // Attempt 1: Operator toggles auto-fix OFF then ON, fixer interrupted throws
  await assert.rejects(
    runPipeline(
      {
        intent: "Resume with operator autofix",
        rendererFactory: (
          _artifactsDir,
          _stageLogs,
          _resolveGate,
          setAutoFix,
        ) => ({
          close() {},
          render(snapshot) {
            if (snapshot.transition.kind === "round-started" && !toggled) {
              toggled = true;
              void setAutoFix?.(false);
              void setAutoFix?.(true);
            }
          },
        }),
      },
      interrupted,
      git,
      ledger,
    ),
    /fixer interrupted/,
  );

  // Ledger should have operator event recorded
  const events = ledger.listAutoFixModeEvents(runId);
  assert.ok(events.some((e) => e.source === "operator" && e.enabled === true));

  // Fresh-process resume: fresh TUI renderer created with initial local auto-fix off
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 100;
  output.rows = 24;
  const freshRenderer = new RailTuiRenderer(input, output, "/unused");

  const resumed = new FakeOrca(runId);
  resumed.reports.set("review", [pass("clean review")]);
  resumed.reports.set("test", [pass("clean test")]);

  await runPipeline(
    {
      intent: "Resume with operator autofix",
      rendererFactory: () => freshRenderer,
      resumeRunId: runId,
    },
    resumed,
    git,
    ledger,
  );

  await nextDraw();
  const screen = cleanScreen(output.writes.at(-1) ?? "");
  assert.match(screen, /auto-fix on/iu, `Fresh TUI renderer must restore operator auto-fix on resume: ${screen}`);
  freshRenderer.close();
  ledger.close();
});

test("Finding 2: asymmetric status failure retries even when notification succeeds immediately", async () => {
  let statusAttempts = 0;
  let notifyAttempts = 0;
  let resumeTriggered = false;

  const gitOps = new FakeGit();
  class AsymmetricStatusFailsFirstOrca extends FakeOrca {
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
      if (status === "stopped") {
        statusAttempts++;
        if (statusAttempts === 1) {
          throw new Error("transient status outage on first attempt");
        }
      }
      await super.setWorktreeStatus(comment, status);
    }

    async notifyRunResult(outcome: string, summary: string): Promise<void> {
      if (outcome === "stopped") {
        notifyAttempts++;
        this.notified.push({ outcome, summary });
      }
    }
  }

  const orca = new AsymmetricStatusFailsFirstOrca("asymmetric-status-retry-run");
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
      intent: "Test asymmetric status retry",
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

  assert.equal(notifyAttempts, 1, "notification should succeed immediately on attempt 1");
  assert.equal(statusAttempts, 0, "setWorktreeStatus must not be called with stopped");
  assert.equal(orca.notified[0]?.outcome, "stopped");
  assert.equal(resumeTriggered, true, "resume was triggered");
});
