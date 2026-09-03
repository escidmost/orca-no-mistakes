import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

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
import { DomainLedger } from "../scripts/ledger.ts";
import { RailTuiRenderer, type TerminalInput, type TerminalOutput } from "../scripts/tui.ts";

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

  async finishWorker(): Promise<void> {}
  async releaseWorker(): Promise<void> {}
  async removeWorktree(): Promise<void> {}
  async createGate(): Promise<string> {
    return "gate-1";
  }
  async waitForGate(): Promise<string> {
    return this.gateResolution;
  }
  async completeTask(): Promise<void> {}
  async setWorktreeStatus(): Promise<void> {}
}

class FakeInput extends EventEmitter implements TerminalInput {
  isRaw = false;
  paused = false;

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

class FakeOutput extends EventEmitter implements TerminalOutput {
  readonly writes: string[] = [];
  columns = 100;
  isTTY = true;
  rows = 30;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

function cleanScreen(text: string): string {
  const screen = text.split("\u001b[H\u001b[2J").at(-1) ?? text;
  return screen
    .replaceAll(new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "gu"), "")
    .replaceAll("\r", "");
}

test("validateReport rejects contradictory severity no-op with explicit action auto-fix and retries report", async () => {
  const git = new FakeGit();
  const orca = new FakeOrca("run-contradictory-report");
  orca.reports.set("review", [
    {
      findings: [
        {
          action: "auto-fix",
          description: "Contradictory finding with auto-fix action and no-op severity",
          id: "contradictory-1",
          severity: "no-op",
        } as unknown as Finding,
      ],
      summary: "first invalid report with contradictory finding",
    },
    {
      findings: [
        {
          action: "auto-fix",
          description: "Repaired finding with valid error severity",
          id: "valid-1",
          severity: "error",
        },
      ],
      summary: "repaired report with valid finding",
    },
  ]);
  orca.reports.set("fix", [
    {
      findings: [],
      summary: "fixed the issue",
    },
  ]);
  orca.reports.set("test", [pass("clean test")]);

  await runPipeline(
    { intent: "Handle report retry when contradictory finding is rejected" },
    orca,
    git,
  );

  const reviewDispatches = orca.calls.filter((c) => c.startsWith("run:") || orca.tasks.some((t) => t.spec.includes("review")));
  assert.ok(reviewDispatches.length > 0);
  assert.equal(orca.reports.get("review")?.length, 0);
});

test("validateReport rejects unsupported action or severity enum values and retries report", async () => {
  const git = new FakeGit();
  const orca = new FakeOrca("run-unsupported-enum-report");
  orca.reports.set("review", [
    {
      findings: [
        {
          action: "unsupported-action",
          description: "Finding with unsupported action enum",
          id: "unsupported-1",
          severity: "error",
        } as unknown as Finding,
      ],
      summary: "first invalid report with unsupported action",
    },
    {
      findings: [
        {
          action: "ask-user",
          description: "Finding with unsupported severity enum",
          id: "unsupported-2",
          severity: "critical",
        } as unknown as Finding,
      ],
      summary: "second invalid report with unsupported severity",
    },
    {
      findings: [
        {
          body: "A valid non-blocking note.",
          location: { line: 5, path: "file.ts" },
          severity: "no-op",
          title: "Valid no-op note",
        } as unknown as Finding,
      ],
      summary: "repaired report with valid no-op alias",
    },
  ]);
  orca.reports.set("test", [pass("clean test")]);

  await runPipeline(
    { intent: "Handle report retry when unsupported enums are rejected" },
    orca,
    git,
  );

  assert.equal(orca.reports.get("review")?.length, 0);
});

test("matching auto-fix mode toggle persists operator event and restores on resume", async () => {
  const git = new FakeGit();
  git.policyDigest = "f".repeat(64);
  const runId = "run-matching-mode-toggle";
  const ledger = new DomainLedger(":memory:");

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
  interrupted.gateResolution = "fix finding-needs-fix";
  interrupted.reports.set("review", [
    {
      findings: [
        {
          action: "ask-user",
          description: "Needs fix",
          id: "finding-needs-fix",
          severity: "error",
        },
      ],
      summary: "found issue",
    },
  ]);
  let setAutoFixFn: ((enabled: boolean) => void) | undefined;
  let toggled = false;

  await assert.rejects(
    runPipeline(
      {
        intent: "Resume with persisted operator auto-fix",
        rendererFactory: (
          _artifactsDir,
          _stageLogs,
          _resolveGate,
          setAutoFix,
        ) => {
          setAutoFixFn = setAutoFix;
          return {
            close() {},
            render(snapshot) {
              if (snapshot.transition.kind === "round-started" && !toggled) {
                toggled = true;
                setAutoFix?.(true);
              }
            },
          };
        },
      },
      interrupted,
      git,
      ledger,
    ),
    /fixer interrupted/,
  );

  const events = ledger.listAutoFixModeEvents(runId);
  assert.ok(
    events.some((e) => e.source === "operator" && e.enabled === true),
    `Expected operator event in ledger: ${JSON.stringify(events)}`,
  );

  const eventsCountBefore = ledger.listAutoFixModeEvents(runId).length;
  setAutoFixFn?.(true);
  assert.equal(
    ledger.listAutoFixModeEvents(runId).length,
    eventsCountBefore,
    "Calling setAutoFix with the same value when latest event is already operator should be deduplicated",
  );

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
      intent: "Resume with persisted operator auto-fix",
      rendererFactory: () => freshRenderer,
      resumeRunId: runId,
    },
    resumed,
    git,
    ledger,
  );

  await new Promise((resolve) => setImmediate(resolve));
  const screen = cleanScreen(output.writes.at(-1) ?? "");
  assert.match(
    screen,
    /auto-fix on/iu,
    `Fresh TUI renderer must restore operator auto-fix on resume: ${screen}`,
  );
  freshRenderer.close();
  ledger.close();
});
