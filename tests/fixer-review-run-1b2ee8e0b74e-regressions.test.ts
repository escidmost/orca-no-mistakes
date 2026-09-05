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
import { PresentationPublisher } from "../scripts/presentation.ts";
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

test("no-op-only reviewer report produces zero exit code and passes final attestation", async () => {
  const git = new FakeGit();
  const orca = new FakeOrca("run-noop-attestation");
  orca.reports.set("review", [
    {
      findings: [
        {
          body: "Intentional validation note.",
          location: { line: 10, path: "file.ts" },
          severity: "no-op",
          title: "Policy note",
        } as unknown as Finding,
      ],
      summary: "one no-op policy note",
    },
  ]);

  const result = await runPipeline(
    { intent: "Accept no-op review findings" },
    orca,
    git,
  );

  assert.ok(result);
  assert.ok(result.attestation);
  const reviewEvidence = result.attestation.stageEvidence.find(
    (entry) => entry.stage === "review",
  );
  assert.ok(reviewEvidence);
  assert.equal(reviewEvidence.exitCode, 0);
  assert.equal(reviewEvidence.waiverOrApproval, undefined);
});

test("invalid finding error message is structural and does not disclose payload secrets", async () => {
  const git = new FakeGit();
  const orca = new FakeOrca("run-invalid-finding-secret");
  const secret = "SUPER_SECRET_PAYLOAD_TOKEN";
  const invalidReport = {
    findings: [
      {
        description: "",
        id: "bad-finding",
        privateData: secret,
      } as unknown as Finding,
    ],
    summary: "malformed finding report",
  };
  orca.reports.set("review", [invalidReport, invalidReport, invalidReport]);

  await assert.rejects(
    runPipeline({ intent: "Test secret rejection" }, orca, git),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /review worker returned an invalid finding: index 0/);
      assert.match(error.message, /invalid fields: description/);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});

test("selective fixes distinguish targeted fixes from approved findings", async (t) => {
  const ledger = new DomainLedger(":memory:");
  t.after(() => ledger.close());
  const runId = "selective-fix-glyphs";
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "Test selective fix glyphs.",
    policySha256: "0".repeat(64),
    repoRoot: "/repo",
    runId,
    submissionCommitOid: "1".repeat(40),
  });
  const publisher = new PresentationPublisher(ledger, runId);

  const findingA = {
    description: "Fix this issue",
    id: "finding-fix",
    severity: "error" as const,
  };
  const findingB = {
    description: "Leave this issue for now",
    id: "finding-leave",
    severity: "warning" as const,
  };

  publisher.publish("findings:initial", {
    actionable: 2,
    findings: [findingA, findingB],
    kind: "findings-recorded",
    round: 0,
    stage: "review",
    total: 2,
  });

  publisher.publish("gate:opened", {
    gateId: "gate-1",
    kind: "gate-opened",
    options: ["approve", "fix", "skip", "stop"],
    question: "Review findings",
    round: 0,
    stage: "review",
  });

  publisher.publish("gate:resolved", {
    decision: "fix",
    gateId: "gate-1",
    kind: "gate-resolved",
    round: 0,
    stage: "review",
    targetFindingIds: ["finding-fix"],
  });

  publisher.publish("round:fix-started", {
    kind: "round-started",
    round: 1,
    stage: "review",
    targetFindingIds: ["finding-fix"],
  });

  const previousLocale = process.env.LC_ALL;
  t.after(() => {
    if (previousLocale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previousLocale;
  });
  for (const [locale, fixing, approved] of [
    ["C.UTF-8", /F\s+finding-fix/, /~\s+finding-leave/],
    ["C", /\[F\]\s+finding-fix/, /\[approved\]\s+finding-leave/],
  ] as const) {
    process.env.LC_ALL = locale;
    const input = new FakeInput();
    const output = new FakeOutput();
    const renderer = new RailTuiRenderer(input, output, "/unused");
    t.after(() => renderer.close());

    renderer.render(publisher.current);
    await new Promise((resolve) => setImmediate(resolve));

    const screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, fixing);
    assert.match(screen, approved);
  }
});
