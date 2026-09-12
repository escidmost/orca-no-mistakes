import assert from "node:assert/strict";
import { withLivePass } from './live-validation-fixture.ts';
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  installAbortReaping,
  runPipeline,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";
import {
  PresentationPublisher,
  type PresentationSnapshot,
  type PresentationStore,
} from "../scripts/presentation.ts";

const head = "1".repeat(40);
const base = "0".repeat(40);
const approvalFinding: StageReport = {
  findings: [
    {
      action: "ask-user",
      description: "Needs a durable approval",
      id: "review-approval",
      severity: "error",
    },
  ],
  summary: "approval required",
};

class FailAfterGateAuditLedger extends DomainLedger {
  #failApproveAudit = true;

  override recordGateAudit(
    audit: Parameters<DomainLedger["recordGateAudit"]>[0],
  ): void {
    super.recordGateAudit(audit);
    if (audit.decision === "approve" && this.#failApproveAudit) {
      this.#failApproveAudit = false;
      throw new Error("stop after durable gate audit");
    }
  }
}

test("resume reconciles approved gate audits into presentation", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-audit-reconcile-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = temp;
  const ledger = new FailAfterGateAuditLedger(":memory:");
  let dispatch = 0;

  const makeOrca = (runId: string) => {
    const reviewDispatches: string[] = [];
    let gates = 0;
    let task = 0;
    const operations: OrcaOperations = {
      async createRun() {
        return runId;
      },
      async createTask() {
        return `task-${++task}`;
      },
      async startWorker(
        taskId: string,
        launch: WorkerLaunch,
      ): Promise<WorkerResult> {
        const dispatchId = `dispatch-${++dispatch}`;
        if (launch.stage === "review") reviewDispatches.push(dispatchId);
        return {
          dispatchId,
          report:
            launch.stage === "review"
              ? structuredClone(approvalFinding)
              : withLivePass(launch, { findings: [], summary: "passed" }),
          taskId,
          terminalHandle: `term-${dispatchId}`,
        };
      },
      async finishWorker(worker) {
        worker.shutdownConfirmed = true;
      },
      async removeWorktree() {},
      async completeTask() {},
      async createGate() {
        gates += 1;
        return `gate-${gates}`;
      },
      async waitForGate() {
        return "approve";
      },
      async setWorktreeStatus() {},
    };
    return {
      operations,
      reviewDispatches,
      gateCount: () => gates,
    };
  };

  const git: GitOperations = {
    async assertReady() {
      return {
        base: "main",
        baseOid: base,
        branch: "feature",
        head,
        root: temp,
      };
    },
    async assertClean() {},
    async assertFixerChangesAllowed() {
      return { changed: false, guardrailViolations: [] };
    },
    async head() {
      return head;
    },
    async diffBase() {
      return "";
    },
    async rebase() {
      return { findings: [], rebaseUpstreamHead: base, summary: "rebased" };
    },
    async resolveRefSha() {
      return base;
    },
    async showFile() {
      return undefined;
    },
    async pathExists() {
      return false;
    },
    async policySha256() {
      return "f".repeat(64);
    },
    async resolveBaseOid() {
      return base;
    },
    async applyWorktreeCommits() {
      return false;
    },
    async headOf() {
      return head;
    },
    async worktreeIsReusable() {
      return false;
    },
    async anchorRecoveryRef() {},
  };

  const stageOf = (snapshot: PresentationSnapshot, id: string) =>
    snapshot.stages.find((stage) => stage.id === id)!;

  try {
    const first = makeOrca("domain-run");
    await assert.rejects(
      runPipeline(
        { intent: "Resume a previously approved review." },
        first.operations,
        git,
        ledger,
      ),
      /stop after durable gate audit/,
    );
    assert.equal(first.gateCount(), 1);
    assert.equal(ledger.runStatus("domain-run"), "failed");
    const beforeResume = ledger.listPresentationSnapshots("domain-run");
    assert.ok(
      !beforeResume.some((snapshot) =>
        stageOf(snapshot, "review")
          .findings?.some((finding) => finding.disposition === "approved"),
      ),
    );
    assert.ok(
      !beforeResume.some(
        (snapshot) => stageOf(snapshot, "review").status === "passed",
      ),
    );

    await installAbortReaping({ pid: process.pid });
    const resumed = makeOrca("orchestration-resume");
    const result = await runPipeline(
      {
        intent: "Resume a previously approved review.",
        resumeRunId: "domain-run",
      },
      resumed.operations,
      git,
      ledger,
    );

    assert.deepEqual(resumed.reviewDispatches, []);
    assert.equal(resumed.gateCount(), 0);
    assert.ok(result.attestation);
    const finalSnapshot = ledger
      .listPresentationSnapshots("domain-run")
      .at(-1)!;
    assert.equal(finalSnapshot.status, "passed");
    const review = stageOf(finalSnapshot, "review");
    assert.equal(review.status, "passed");
    assert.equal(review.approvedFindings, 1);
    assert.equal(review.openFindings, 0);
    assert.equal(review.findings?.[0]?.disposition, "approved");
  } finally {
    await installAbortReaping({ pid: process.pid });
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});

class MemoryPresentationStore implements PresentationStore {
  readonly snapshots: PresentationSnapshot[] = [];

  listPresentationSnapshots(): PresentationSnapshot[] {
    return this.snapshots;
  }

  recordPresentationSnapshot(
    _runId: string,
    _eventKey: string,
    snapshot: PresentationSnapshot,
  ): boolean {
    this.snapshots.push(snapshot);
    return true;
  }
}

test("retained fixer markers move and clear across stages", () => {
  const store = new MemoryPresentationStore();
  const publisher = new PresentationPublisher(store, "run-retained-fixer");
  const stageOf = (id: string) =>
    publisher.current.stages.find((stage) => stage.id === id)!;

  publisher.publish("review-findings", {
    actionable: 1,
    findings: [
      {
        description: "Repair the implementation.",
        id: "review-finding",
        severity: "error",
      },
    ],
    kind: "findings-recorded",
    retainedFixer: true,
    round: 1,
    stage: "review",
    total: 1,
  });
  assert.equal(stageOf("review").retainedFixer, true);

  publisher.publish("test-findings", {
    actionable: 0,
    kind: "findings-recorded",
    retainedFixer: false,
    round: 1,
    stage: "test",
    total: 0,
  });
  assert.equal(stageOf("review").retainedFixer, false);
  assert.equal(stageOf("test").retainedFixer, false);

  publisher.publish("review-retained-again", {
    actionable: 0,
    kind: "findings-recorded",
    retainedFixer: true,
    round: 2,
    stage: "review",
    total: 0,
  });
  assert.equal(stageOf("review").retainedFixer, true);

  publisher.publish("test-retained-move", {
    actionable: 0,
    kind: "findings-recorded",
    retainedFixer: true,
    round: 2,
    stage: "test",
    total: 0,
  });
  assert.equal(stageOf("review").retainedFixer, false);
  assert.equal(stageOf("test").retainedFixer, true);

  publisher.publish("test-gate", {
    gateId: "gate-test",
    kind: "gate-opened",
    options: ["approve", "skip", "stop"],
    question: "Resolve the findings.",
    round: 2,
    stage: "test",
  });
  assert.equal(stageOf("review").retainedFixer, false);
  assert.equal(stageOf("test").retainedFixer, false);
  assert.equal(stageOf("test").status, "blocked");
});
