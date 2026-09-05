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
  readonly tasks: { id: string; spec: string }[] = [];
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
    };
  }

  async finishWorker(): Promise<void> {}
  async releaseWorker(): Promise<void> {}
  async removeWorktree(): Promise<void> {}
  async createGate(): Promise<string> {
    return "gate-1";
  }
  async waitForGate(): Promise<string> {
    return "approve";
  }
  async completeTask(): Promise<void> {}
  async setWorktreeStatus(): Promise<void> {}
}

test("reviewer report with unsupported severity critical receives bounded REPORT REPAIR and succeeds with valid report", async () => {
  const git = new FakeGit();
  const runId = "run-unsupported-severity-repair";
  const orca = new FakeOrca(runId);
  const ledger = new DomainLedger(":memory:");
  try {
    const invalidReport = {
      findings: [
        {
          action: "auto-fix",
          description: "Actionable finding with unsupported critical severity",
          id: "unsupported-sev-1",
          severity: "critical",
        } as unknown as Finding,
      ],
      summary: "invalid reviewer report with unsupported severity",
    };
    orca.reports.set("review", [invalidReport, pass("review")]);

    await runPipeline(
      { intent: "Handle report repair when unsupported severity is rejected" },
      orca,
      git,
      ledger,
    );

    const reviewTasks = orca.tasks.filter((task) =>
      task.spec.startsWith("[review check 1]"),
    );
    assert.equal(reviewTasks.length, 2);
    assert.match(reviewTasks[1].spec, /REPORT REPAIR/);

    const evidenceList = ledger.listEvidence(runId);
    const reviewEvidence = evidenceList.filter((entry) => entry.stage_id === "review");
    assert.equal(reviewEvidence.length, 1);
    assert.equal(reviewEvidence[0].summary, "review passed");
    assert.equal(reviewEvidence[0].findings_json, "[]");
    assert.ok(!reviewEvidence[0].findings_json.includes("unsupported-sev-1"));
    assert.ok(!reviewEvidence[0].findings_json.includes("critical"));
  } finally {
    ledger.close();
  }
});

test("repeated invalid severity exhausts bounded repair and fails closed with structural diagnostic", async () => {
  const git = new FakeGit();
  const runId = "run-repeated-unsupported-severity";
  const orca = new FakeOrca(runId);
  const ledger = new DomainLedger(":memory:");
  try {
    const invalidReport = {
      findings: [
        {
          action: "auto-fix",
          description: "Repeated finding with unsupported critical severity",
          id: "unsupported-sev-repeated",
          severity: "critical",
        } as unknown as Finding,
      ],
      summary: "repeated invalid reviewer report with unsupported severity",
    };
    orca.reports.set("review", [invalidReport, invalidReport, invalidReport]);

    await assert.rejects(
      runPipeline(
        { intent: "Fail closed when unsupported severity repair exhausts" },
        orca,
        git,
        ledger,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /review worker returned an invalid finding: index 0/u,
        );
        assert.match(error.message, /invalid fields: severity/u);
        assert.match(
          error.message,
          /Allowed severities: error, warning, info, no-op/u,
        );
        return true;
      },
    );

    const reviewTasks = orca.tasks.filter((task) =>
      task.spec.startsWith("[review check 1]"),
    );
    assert.equal(reviewTasks.length, 3);
    assert.match(reviewTasks[1].spec, /REPORT REPAIR/);
    assert.match(reviewTasks[2].spec, /REPORT REPAIR/);

    const evidenceList = ledger.listEvidence(runId);
    const reviewEvidence = evidenceList.filter((entry) => entry.stage_id === "review");
    assert.equal(reviewEvidence.length, 0);
  } finally {
    ledger.close();
  }
});
