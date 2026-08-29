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

const head = "1".repeat(40);
const base = "0".repeat(40);
const finding: StageReport = {
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

class FailAfterApprovalLedger extends DomainLedger {
  #failReviewCheckpoint = true;

  override recordCheckpoint(
    input: Parameters<DomainLedger["recordCheckpoint"]>[0],
  ): void {
    if (input.stageId === "review" && this.#failReviewCheckpoint) {
      this.#failReviewCheckpoint = false;
      throw new Error("stop after durable approval");
    }
    super.recordCheckpoint(input);
  }
}

test("resume skips approved evidence when its checkpoint write failed", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-approved-resume-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = temp;
  const ledger = new FailAfterApprovalLedger(":memory:");
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
          deliveryId: `delivery-${dispatchId}`,
          dispatchId,
          report:
            launch.stage === "review"
              ? structuredClone(finding)
              : { findings: [], summary: "passed" },
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

  try {
    const first = makeOrca("domain-run");
    await assert.rejects(
      runPipeline(
        { intent: "Resume a previously approved review." },
        first.operations,
        git,
        ledger,
      ),
      /stop after durable approval/,
    );
    assert.equal(first.gateCount(), 1);
    assert.equal(first.reviewDispatches.length, 1);
    assert.equal(ledger.runStatus("domain-run"), "failed");

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
    const reviewEvidence = result.attestation.stageEvidence.filter(
      (entry) => entry.stage === "review",
    );
    assert.equal(reviewEvidence.length, 1);
    assert.equal(
      reviewEvidence[0].workerIdentity,
      `reviewer:${first.reviewDispatches[0]}`,
    );
    assert.equal(
      reviewEvidence[0].waiverOrApproval?.decision,
      "approve",
    );
  } finally {
    await installAbortReaping({ pid: process.pid });
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});
