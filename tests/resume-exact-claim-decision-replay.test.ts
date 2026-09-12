import assert from "node:assert/strict";
import { withLivePass } from './live-validation-fixture.ts';
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

class ResumeGit implements GitOperations {
  async assertReady() {
    return { base: "main", baseOid: base, branch: "feature", head, root: "/repo" };
  }
  async assertClean() {}
  async assertFixerChangesAllowed() {
    return { changed: false, guardrailViolations: [] };
  }
  async head() {
    return head;
  }
  async diffBase() {
    return "";
  }
  async rebase() {
    return { findings: [], rebaseUpstreamHead: base, summary: "rebased" };
  }
  async resolveRefSha() {
    return base;
  }
  async showFile() {
    return undefined;
  }
  async pathExists() {
    return false;
  }
  async policySha256() {
    return "f".repeat(64);
  }
  async resolveBaseOid() {
    return base;
  }
  async applyWorktreeCommits() {
    return false;
  }
  async headOf() {
    return head;
  }
  async worktreeIsReusable() {
    return false;
  }
  async anchorRecoveryRef() {}
}

class ResumeOrca implements OrcaOperations {
  gates = 0;
  readonly runId: string;
  #dispatch = 0;
  #task = 0;

  constructor(runId: string) {
    this.runId = runId;
  }

  async createRun() {
    return this.runId;
  }
  async createTask() {
    return `task-${++this.#task}`;
  }
  async startWorker(taskId: string, launch: WorkerLaunch): Promise<WorkerResult> {
    const dispatchId = `dispatch-${++this.#dispatch}`;
    return {
      deliveryId: `delivery-${dispatchId}`,
      dispatchId,
      report:
        launch.stage === "review"
          ? structuredClone(finding)
          : withLivePass(launch, { findings: [], summary: "passed" }),
      taskId,
      terminalHandle: `term-${dispatchId}`,
    };
  }
  async finishWorker(worker: WorkerResult) {
    worker.shutdownConfirmed = true;
  }
  async removeWorktree() {}
  async completeTask() {}
  async createGate() {
    this.gates += 1;
    return `gate-${this.gates}`;
  }
  async waitForGate() {
    return "approve";
  }
  async setWorktreeStatus() {}
}

class ResumeLedger extends DomainLedger {
  failReviewCheckpoint = true;
  markerPath?: string;
  sawStartupClaim = false;

  override recordCheckpoint(input: Parameters<DomainLedger["recordCheckpoint"]>[0]) {
    if (input.stageId === "review" && this.failReviewCheckpoint) {
      this.failReviewCheckpoint = false;
      throw new Error("stop after durable approval");
    }
    super.recordCheckpoint(input);
  }

  override resumeRun(input: Parameters<DomainLedger["resumeRun"]>[0]) {
    assert.ok(this.markerPath);
    const marker = JSON.parse(readFileSync(this.markerPath, "utf8")) as {
      domainRunId?: string;
      generationToken?: number;
      resumeClaimId?: string;
    };
    assert.equal(marker.domainRunId, input.runId);
    assert.equal(marker.resumeClaimId, input.claimId);
    assert.ok(marker.generationToken);
    assert.equal(this.runStatus(input.runId), "failed");
    assert.equal(this.leaseFor(input.repoRoot, input.branch), undefined);
    assert.equal(
      this.resumeClaimMatches({
        claimId: input.claimId,
        generationToken: marker.generationToken,
        runId: input.runId,
      }),
      true,
    );
    this.sawStartupClaim = true;
    return super.resumeRun(input);
  }
}

test("resume publishes its exact claim and replays an identical approval", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-resume-claim-"));
  const ledger = new ResumeLedger(path.join(temp, "ledger.db"));
  const git = new ResumeGit();
  const firstOrca = new ResumeOrca("domain-run");
  const intent = "Resume a previously approved review.";

  try {
    await assert.rejects(
      runPipeline({ intent }, firstOrca, git, ledger),
      /stop after durable approval/,
    );
    assert.equal(firstOrca.gates, 1);
    assert.equal(ledger.runStatus("domain-run"), "failed");

    const gateId = "resume-gate";
    const markerName = `gate-${createHash("sha256").update(gateId).digest("hex").slice(0, 32)}.json`;
    ledger.markerPath = path.join(temp, ".orca", "no-mistakes", markerName);
    const resumedOrca = new ResumeOrca("orchestration-resume");
    await installAbortReaping({
      gate: {
        branch: "gate",
        id: gateId,
        kind: "orca",
        path: path.join(temp, "gate"),
      },
      git,
      ledger,
      orca: resumedOrca,
      originWorktree: temp,
      pid: process.pid,
    });

    const result = await runPipeline(
      { intent, resumeRunId: "domain-run" },
      resumedOrca,
      git,
      ledger,
    );

    assert.equal(ledger.sawStartupClaim, true);
    assert.equal(resumedOrca.gates, 0);
    assert.ok(result.attestation);
    const reviewEvidence = result.attestation.stageEvidence.filter(
      (entry) => entry.stage === "review",
    );
    assert.equal(reviewEvidence.length, 1);
    assert.equal(reviewEvidence.at(-1)?.waiverOrApproval?.decision, "approve");
    const marker = JSON.parse(await readFile(ledger.markerPath, "utf8")) as {
      domainRunId?: string;
      resumeClaimId?: string;
    };
    assert.equal(marker.domainRunId, "domain-run");
    assert.equal(marker.resumeClaimId, undefined);
  } finally {
    ledger.close();
    await rm(temp, { force: true, recursive: true });
  }
});
