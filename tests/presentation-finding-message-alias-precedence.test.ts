import assert from "node:assert/strict";
import { withLivePass } from './live-validation-fixture.ts';
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

test("empty message does not shadow non-empty body alias in evidence and presentation", async () => {
  const git = new FakeGit();
  const runId = "run-empty-message-shadowing";
  const ledger = new DomainLedger(":memory:");
  const orca = new FakeOrca(runId);

  orca.reports.set("review", [
    {
      findings: [
        {
          body: "Substantive rationale that should not be dropped.",
          location: { line: 42, path: "scripts/example.ts" },
          message: "   ",
          severity: "no-op",
          title: "Policy clarification",
        } as unknown as Finding,
      ],
      summary: "one finding with whitespace message and non-empty body",
    },
  ]);
  orca.reports.set("test", [pass("clean test")]);

  await runPipeline(
    { intent: "Verify empty message alias does not shadow substantive body" },
    orca,
    git,
    ledger,
  );

  const evidence = ledger.listEvidence(runId);
  const reviewEvidence = evidence.find((e) => e.stage_id === "review");
  assert.ok(reviewEvidence?.findings_json);
  const findings = JSON.parse(reviewEvidence.findings_json) as Finding[];
  assert.equal(findings.length, 1);
  assert.equal(
    findings[0].description,
    "Policy clarification: Substantive rationale that should not be dropped.",
  );
  assert.equal(findings[0].file, "scripts/example.ts");
  assert.equal(findings[0].line, 42);

  ledger.close();
});

test("empty message falls back to body for actionable findings in presentation", async () => {
  const git = new FakeGit();
  const runId = "run-actionable-empty-message";
  const ledger = new DomainLedger(":memory:");
  const orca = new FakeOrca(runId);

  orca.reports.set("review", [
    {
      findings: [
        {
          action: "ask-user",
          body: "Concrete bug details that must appear in TUI.",
          location: { line: 15, path: "scripts/tui.ts" },
          message: "",
          severity: "error",
          title: "TUI layout defect",
        } as unknown as Finding,
      ],
      summary: "actionable finding with empty message and body",
    },
  ]);
  orca.reports.set("test", [pass("clean test")]);

  let reviewFindings: readonly { description: string; file?: string; line?: number }[] = [];
  await runPipeline(
    {
      intent: "Verify actionable finding includes body in presentation",
      rendererFactory: () => ({
        close() {},
        render(snapshot) {
          if (
            snapshot.transition.kind === "findings-recorded" &&
            snapshot.transition.stage === "review"
          ) {
            reviewFindings = snapshot.transition.findings ?? [];
          }
        },
      }),
    },
    orca,
    git,
    ledger,
  );

  assert.equal(reviewFindings.length, 1);
  assert.equal(
    reviewFindings[0].description,
    "TUI layout defect: Concrete bug details that must appear in TUI.",
  );
  assert.equal(reviewFindings[0].file, "scripts/tui.ts");
  assert.equal(reviewFindings[0].line, 15);

  ledger.close();
});

test("non-empty trimmed message takes precedence over body alias", async () => {
  const git = new FakeGit();
  const runId = "run-message-precedence";
  const ledger = new DomainLedger(":memory:");
  const orca = new FakeOrca(runId);

  orca.reports.set("review", [
    {
      findings: [
        {
          body: "Secondary body that should yield to non-empty message.",
          location: { line: 10, path: "scripts/example.ts" },
          message: "Primary message content.",
          severity: "no-op",
          title: "Notice",
        } as unknown as Finding,
      ],
      summary: "one finding with non-empty message and body",
    },
  ]);
  orca.reports.set("test", [pass("clean test")]);

  await runPipeline(
    { intent: "Verify message takes precedence over body when non-empty" },
    orca,
    git,
    ledger,
  );

  const evidence = ledger.listEvidence(runId);
  const reviewEvidence = evidence.find((e) => e.stage_id === "review");
  assert.ok(reviewEvidence?.findings_json);
  const findings = JSON.parse(reviewEvidence.findings_json) as Finding[];
  assert.equal(findings.length, 1);
  assert.equal(
    findings[0].description,
    "Notice: Primary message content.",
  );

  ledger.close();
});
