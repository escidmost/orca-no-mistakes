import assert from "node:assert/strict";
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
import type { PresentationSnapshot } from "../scripts/presentation.ts";

const head = "1".repeat(40);
const head2 = "2".repeat(40);
const base = "0".repeat(40);

const twoFindings: StageReport = {
  findings: [
    {
      action: "ask-user",
      description: "Fix this issue",
      id: "review-fix-1",
      severity: "error",
    },
    {
      action: "ask-user",
      description: "Approve this issue",
      id: "review-approve-2",
      severity: "error",
    },
  ],
  summary: "two findings reported",
};

class FailAfterGateAuditLedger extends DomainLedger {
  #failFixAudit = true;

  override recordGateAudit(
    audit: Parameters<DomainLedger["recordGateAudit"]>[0],
  ): void {
    super.recordGateAudit(audit);
    if (audit.decision === "fix" && this.#failFixAudit) {
      this.#failFixAudit = false;
      throw new Error("stop after durable gate audit");
    }
  }
}

test("resume restores selective approvals before candidate revalidation invalidates them", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-selective-audit-reconcile-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = temp;
  const ledger = new FailAfterGateAuditLedger(":memory:");
  let dispatch = 0;
  let currentHead = head;

  const makeOrca = (runId: string) => {
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
        let report: StageReport;
        if (launch.stage === "review" && launch.role === "reviewer") {
          report = currentHead === head ? structuredClone(twoFindings) : { findings: [], summary: "passed" };
        } else if (launch.role === "fixer") {
          report = { findings: [], summary: "fix committed" };
        } else {
          report = { findings: [], summary: "passed" };
        }
        return {
          dispatchId,
          report,
          taskId,
          terminalHandle: `term-${dispatchId}`,
          worktreeId: `wt-${dispatchId}`,
          worktreePath: temp,
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
        return JSON.stringify({ action: "fix", findingIds: ["review-fix-1"] });
      },
      async setWorktreeStatus() {},
    };
    return {
      operations,
      gateCount: () => gates,
    };
  };

  const git: GitOperations = {
    async assertReady() {
      return {
        base: "main",
        baseOid: base,
        branch: "feature",
        head: currentHead,
        root: temp,
      };
    },
    async assertClean() {},
    async assertFixerChangesAllowed() {
      return { changed: true, guardrailViolations: [] };
    },
    async head() {
      return currentHead;
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
      currentHead = head2;
      return true;
    },
    async headOf() {
      return head2;
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
        { intent: "Resume a selective fix review." },
        first.operations,
        git,
        ledger,
      ),
      /stop after durable gate audit/,
    );
    assert.equal(first.gateCount(), 1);
    assert.equal(ledger.runStatus("domain-run"), "failed");

    await installAbortReaping({ pid: process.pid });
    const resumed = makeOrca("orchestration-resume");
    const result = await runPipeline(
      {
        intent: "Resume a selective fix review.",
        resumeRunId: "domain-run",
      },
      resumed.operations,
      git,
      ledger,
    );

    assert.equal(resumed.gateCount(), 0);
    assert.ok(result.attestation);
    const snapshots = ledger.listPresentationSnapshots("domain-run");
    const restoredApproval = snapshots.find((snapshot) =>
      snapshot.transition.kind === "gate-resolved" &&
      snapshot.transition.decision === "fix"
    );
    assert.ok(restoredApproval);
    assert.equal(stageOf(restoredApproval, "review").approvedFindings, 1);
    assert.equal(stageOf(restoredApproval, "review").openFindings, 1);
    const reopened = snapshots.find((snapshot) =>
      snapshot.transition.kind === "stage-reopened" &&
      snapshot.transition.stage === "review"
    );
    assert.ok(reopened);
    assert.ok(reopened.sequence > restoredApproval.sequence);
    assert.equal(stageOf(reopened, "review").approvedFindings, 0);
    const finalSnapshot = snapshots.at(-1)!;
    assert.equal(finalSnapshot.status, "passed");
    const review = stageOf(finalSnapshot, "review");
    assert.equal(review.status, "passed");
    assert.equal(review.approvedFindings, 0);
    assert.equal(review.fixedFindings, 2);
    assert.equal(review.openFindings, 0);
    assert.equal(
      review.findings?.find((f) => f.id === "review-fix-1")?.disposition,
      "fixed",
    );
    assert.equal(
      review.findings?.find((f) => f.id === "review-approve-2")?.disposition,
      "fixed",
    );
  } finally {
    await installAbortReaping({ pid: process.pid });
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});
