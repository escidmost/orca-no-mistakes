import assert from "node:assert/strict";
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
  readonly #head = "1".repeat(40);
  readonly #baseOid = "0".repeat(40);

  async assertReady(): Promise<{
    base: string;
    baseOid: string;
    branch: string;
    head: string;
    root: string;
  }> {
    return {
      base: "main",
      baseOid: this.#baseOid,
      branch: "feature",
      head: this.#head,
      root: "/repo",
    };
  }

  async assertClean(): Promise<void> {}

  async assertFixerChangesAllowed(): Promise<FixerChangesVerdict> {
    return { changed: true, guardrailViolations: [] };
  }

  async head(): Promise<string> {
    return this.#head;
  }

  async diffBase(): Promise<string> {
    return "";
  }

  async headOf(): Promise<string> {
    return "2".repeat(40);
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

  async rebase(): Promise<StageReport> {
    return {
      findings: [],
      rebaseUpstreamHead: this.#baseOid,
      summary: "rebased",
    };
  }

  async policySha256(): Promise<string> {
    return "f".repeat(64);
  }

  async resolveBaseOid(): Promise<string> {
    return this.#baseOid;
  }

  async applyWorktreeCommits(): Promise<boolean> {
    return true;
  }

  async anchorRecoveryRef(): Promise<void> {}
}

class FakeOrca implements OrcaOperations {
  readonly calls: string[] = [];
  readonly tasks: { id: string; spec: string }[] = [];
  readonly launches: WorkerLaunch[] = [];
  readonly removedWorktrees: string[] = [];
  readonly startedWorkers: WorkerResult[] = [];
  readonly reports = new Map<string, StageReport[]>();
  #taskNumber = 0;
  #dispatchNumber = 0;
  readonly #runId: string;

  constructor(runId = "test-run") {
    this.#runId = runId;
  }

  async createRun(): Promise<string> {
    return this.#runId;
  }

  async createTask(spec: string): Promise<string> {
    const id = `task-${++this.#taskNumber}`;
    this.tasks.push({ id, spec });
    return id;
  }

  async startWorker(
    taskId: string,
    launch: WorkerLaunch,
  ): Promise<WorkerResult> {
    this.launches.push(launch);
    const dispatchId = `dispatch-${++this.#dispatchNumber}`;
    const stage = launch.stage;
    const reports = this.reports.get(stage) ?? [pass(stage)];
    const report = reports.shift() ?? pass(stage);
    this.reports.set(stage, reports);
    const result: WorkerResult = {
      deliveryId: `delivery-${dispatchId}`,
      dispatchId,
      report,
      taskId,
      terminalHandle:
        launch.role === "fixer" ? "term-fixer" : `term-${dispatchId}`,
      worktreeId:
        launch.worktree === "new-child" ? `repo::/${dispatchId}` : undefined,
      worktreePath:
        launch.worktree === "new-child"
          ? `/worktrees/${dispatchId}`
          : undefined,
    };
    this.startedWorkers.push(result);
    return result;
  }

  async finishWorker(
    worker: WorkerResult,
    disposition: "release" | "retain",
  ): Promise<void> {
    this.calls.push(`${disposition}:${worker.dispatchId}`);
    if (disposition === "release") worker.shutdownConfirmed = true;
  }

  async removeWorktree(worktreeId: string): Promise<void> {
    this.removedWorktrees.push(worktreeId);
  }

  async createGate(): Promise<string> {
    return "gate-1";
  }

  async waitForGate(): Promise<string> {
    return "approve";
  }

  async completeTask(): Promise<void> {}
  async setWorktreeStatus(): Promise<void> {}
}

test("malformed reviewer finding values clean up rejected worker worktree and release worker by identity before contract-repair retry", async () => {
  const git = new FakeGit();
  const orca = new FakeOrca("run-malformed-finding-cleanup");
  const ledger = new DomainLedger(":memory:");

  try {
    const malformedReport = {
      findings: [
        {
          id: "bad-action",
          severity: "error",
          action: "fix",
          description: "This report is outside the schema.",
        } as unknown as Finding,
      ],
      summary: "malformed",
    };
    orca.reports.set("review", [malformedReport, pass("review repaired")]);

    const result = await runPipeline(
      { intent: "Validate malformed reviewer finding cleanup." },
      orca,
      git,
      ledger,
    );

    const reviewLaunches = orca.launches.filter(
      (launch) => launch.role === "reviewer" && launch.stage === "review",
    );
    assert.equal(reviewLaunches.length, 2);
    assert.match(reviewLaunches[1].prompt, /REPORT REPAIR/);
    assert.match(reviewLaunches[1].prompt, /auto-fix\|ask-user\|no-op/);

    const malformedWorker = orca.startedWorkers.find(
      (worker) => worker.report.summary === "malformed",
    );
    assert.ok(malformedWorker);
    const malformedDispatchId = malformedWorker.dispatchId;
    const malformedWorktreeId = malformedWorker.worktreeId;
    assert.ok(malformedWorktreeId);

    assert.ok(orca.removedWorktrees.includes(malformedWorktreeId));
    assert.ok(orca.calls.includes(`release:${malformedDispatchId}`));
    assert.equal(result.verdict, "passed");

    const laterWorktrees = orca.removedWorktrees.filter((w) => w !== malformedWorktreeId);
    assert.ok(laterWorktrees.length >= 1);
  } finally {
    ledger.close();
  }
});

test("regression fails if rejected malformed reviewer worktree removal is suppressed despite later worker cleanup", async () => {
  const git = new FakeGit();
  const orca = new FakeOrca("run-suppressed-malformed-cleanup");
  const ledger = new DomainLedger(":memory:");

  try {
    let firstWorkerWorktreeId: string | undefined;
    const removalRequests: string[] = [];
    const originalRemoveWorktree = orca.removeWorktree.bind(orca);
    orca.removeWorktree = async (worktreeId: string) => {
      removalRequests.push(worktreeId);
      if (worktreeId === firstWorkerWorktreeId) {
        return;
      }
      await originalRemoveWorktree(worktreeId);
    };

    const malformedReport = {
      findings: [
        {
          id: "bad-action",
          severity: "error",
          action: "fix",
          description: "This report is outside the schema.",
        } as unknown as Finding,
      ],
      summary: "malformed",
    };
    orca.reports.set("review", [malformedReport, pass("review repaired")]);

    const originalStartWorker = orca.startWorker.bind(orca);
    orca.startWorker = async (taskId, launch) => {
      const worker = await originalStartWorker(taskId, launch);
      if (!firstWorkerWorktreeId && worker.worktreeId) {
        firstWorkerWorktreeId = worker.worktreeId;
      }
      return worker;
    };

    await runPipeline(
      { intent: "Demonstrate identity-specific cleanup verification." },
      orca,
      git,
      ledger,
    );

    assert.ok(firstWorkerWorktreeId);
    assert.ok(removalRequests.includes(firstWorkerWorktreeId));
    assert.ok(orca.removedWorktrees.length >= 1);
    assert.equal(orca.removedWorktrees.includes(firstWorkerWorktreeId), false);
  } finally {
    ledger.close();
  }
});

test("schema-invalid reviewer report with empty summary cleans up rejected worker worktree and releases worker before contract repair", async () => {
  const git = new FakeGit();
  const orca = new FakeOrca("run-schema-invalid-report-cleanup");
  const ledger = new DomainLedger(":memory:");

  try {
    const schemaInvalidReport = {
      findings: [],
      summary: "",
    };
    orca.reports.set("review", [schemaInvalidReport, pass("review repaired")]);

    const result = await runPipeline(
      { intent: "Validate schema-invalid reviewer report cleanup." },
      orca,
      git,
      ledger,
    );

    const reviewLaunches = orca.launches.filter(
      (launch) => launch.role === "reviewer" && launch.stage === "review",
    );
    assert.equal(reviewLaunches.length, 2);
    assert.match(reviewLaunches[1].prompt, /REPORT REPAIR/);

    const invalidWorker = orca.startedWorkers.find(
      (worker) => worker.report.summary === "",
    );
    assert.ok(invalidWorker);
    const invalidDispatchId = invalidWorker.dispatchId;
    const invalidWorktreeId = invalidWorker.worktreeId;
    assert.ok(invalidWorktreeId);

    assert.ok(orca.removedWorktrees.includes(invalidWorktreeId));
    assert.ok(orca.calls.includes(`release:${invalidDispatchId}`));
    assert.equal(result.verdict, "passed");
  } finally {
    ledger.close();
  }
});
