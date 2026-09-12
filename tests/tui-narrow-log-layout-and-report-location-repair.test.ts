import assert from "node:assert/strict";
import { withLivePass } from './live-validation-fixture.ts';
import { EventEmitter } from "node:events";
import path from "node:path";
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
import { PresentationPublisher } from "../scripts/presentation.ts";
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
  columns = 80;
  isTTY = true;
  rows = 18;

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

test("narrow 80x18 terminal reserves at least two detail rows when logs are focused", async () => {
  const ledger = new DomainLedger(":memory:");
  const runId = "narrow-log-pane-run";
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "Test narrow log pane sizing.",
    policySha256: "0".repeat(64),
    repoRoot: "/repo",
    runId,
    submissionCommitOid: "1".repeat(40),
  });
  const publisher = new PresentationPublisher(ledger, runId);
  publisher.publish("run:started", { kind: "run-started" });
  publisher.publish("stage:intent", { kind: "stage-started", stage: "intent" });
  publisher.publish("stage:rebase", { kind: "stage-started", stage: "rebase" });
  publisher.publish("stage:review", { kind: "stage-started", stage: "review" });
  publisher.publish("round:review-r0", { kind: "round-started", round: 0, stage: "review" });

  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 80;
  output.rows = 18;

  const logPath = path.resolve("/unused", "review_r0.log");
  const stageLogs = new Map([
    [
      logPath,
      {
        tail: () => Buffer.from("first log line for review\nsecond log line for review"),
      },
    ],
  ]);

  const renderer = new RailTuiRenderer(
    input,
    output,
    "/unused",
    stageLogs as any,
  );

  renderer.render(publisher.current);
  await new Promise((resolve) => setImmediate(resolve));

  // Focus logs by sending Enter on the selected stage
  input.emit("data", "\r");
  await new Promise((resolve) => setImmediate(resolve));

  const screen = cleanScreen(output.writes.at(-1) ?? "");
  assert.match(screen, /> REVIEW LOG/);
  assert.match(screen, /second log line for review/);

  // Scroll up with Up arrow
  input.emit("data", "\u001b[A");
  await new Promise((resolve) => setImmediate(resolve));

  const scrolledScreen = cleanScreen(output.writes.at(-1) ?? "");
  assert.match(scrolledScreen, /first log line for review/);

  renderer.close();
  ledger.close();
});

test("validateReport repairs invalid file and line types instead of silently dropping them", async () => {
  const git = new FakeGit();
  const orca = new FakeOrca("run-invalid-location");

  orca.reports.set("review", [
    {
      findings: [
        {
          action: "auto-fix",
          description: "Actionable finding with invalid file type and non-positive line",
          file: 7 as unknown as string,
          id: "invalid-loc-1",
          line: 0,
          severity: "error",
        } as unknown as Finding,
      ],
      summary: "invalid report with bad file and line",
    },
  ]);

  await runPipeline(
    { intent: "Handle report rejection when invalid location fields are rejected" },
    orca,
    git,
  );
  const reviewTasks = orca.tasks.filter((task) => task.spec.startsWith("[review check 1]"));
  assert.equal(reviewTasks.length, 2);
  assert.match(reviewTasks[1].spec, /REPORT REPAIR/);
});
