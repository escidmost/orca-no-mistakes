import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildAttestation, DomainLedger } from "../scripts/ledger.ts";
import {
  installAbortReaping,
  RunSettlementError,
  runPipeline,
  type GitOperations,
  type OrcaOperations,
} from "../scripts/orca-no-mistakes.ts";

const commit = "a".repeat(40);
const policySha256 = "b".repeat(64);

test("passed finalization rejects a replaced branch lease", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    for (const runId of ["stale-run", "new-owner"]) {
      ledger.startRun({
        baseBranch: "main",
        branch: "feature",
        intent: "Fence passed finalization.",
        policySha256,
        repoRoot: "/repo",
        runId,
        submissionCommitOid: commit,
      });
    }
    const generationToken = ledger.acquireLease({
      branch: "feature",
      repoRoot: "/repo",
      runId: "stale-run",
    });
    ledger.releaseLease("stale-run");
    ledger.acquireLease({
      branch: "feature",
      repoRoot: "/repo",
      runId: "new-owner",
    });
    const manifest = buildAttestation([], {
      baseCommitOid: commit,
      candidateCommitOid: commit,
      guardrailMode: "strict",
      intent: "Fence passed finalization.",
      policySha256,
      runId: "stale-run",
    });

    assert.throws(
      () =>
        ledger.finalizePassedRun(manifest, commit, {
          branch: "feature",
          generationToken,
          repoRoot: "/repo",
        }),
      /no longer owns its branch lease/,
    );
    assert.equal(ledger.runStatus("stale-run"), "in-progress");
    assert.equal(ledger.findAttestation("stale-run"), undefined);
    assert.equal(ledger.leaseFor("/repo", "feature")?.run_id, "new-owner");
  } finally {
    ledger.close();
  }
});

class RejectingSettlementLedger extends DomainLedger {
  private readonly failDuringAcquire: boolean;

  constructor(failDuringAcquire: boolean) {
    super(":memory:");
    this.failDuringAcquire = failDuringAcquire;
  }

  override acquireLease(
    ...args: Parameters<DomainLedger["acquireLease"]>
  ): number {
    const generationToken = super.acquireLease(...args);
    if (this.failDuringAcquire) throw new Error("injected startup failure");
    return generationToken;
  }

  override settleRun(
    ..._args: Parameters<DomainLedger["settleRun"]>
  ): boolean {
    return false;
  }

  override settleRunWithAttemptOutcome(
    ..._args: Parameters<DomainLedger["settleRunWithAttemptOutcome"]>
  ): boolean {
    return false;
  }
}

test("rejected settlements retain startup and pipeline recovery custody", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-rejected-settlement-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = temp;
  try {
    for (const failDuringAcquire of [true, false]) {
      const runId = failDuringAcquire ? "startup-rejection" : "pipeline-rejection";
      const ledger = new RejectingSettlementLedger(failDuringAcquire);
      let anchored = false;
      const git = {
        async anchorRecoveryRef() {
          anchored = true;
        },
        async assertReady() {
          return {
            base: "main",
            baseOid: commit,
            branch: "feature",
            head: commit,
            root: temp,
          };
        },
        async head() {
          return commit;
        },
        async policySha256() {
          return policySha256;
        },
        async rebase() {
          throw new Error("injected pipeline failure");
        },
      } as unknown as GitOperations;
      let task = 0;
      const orca = {
        async completeTask() {},
        async createRun() {
          return runId;
        },
        async createTask() {
          return `task-${++task}`;
        },
        async setWorktreeStatus() {},
      } as unknown as OrcaOperations;
      try {
        await assert.rejects(
          runPipeline(
            { allowLocalConfig: true, intent: "Retain rejected settlement custody." },
            orca,
            git,
            ledger,
          ),
          (error) =>
            error instanceof RunSettlementError && error.outcome === "failed",
        );
        assert.equal(anchored, !failDuringAcquire);
        assert.equal(ledger.runStatus(runId), "in-progress");
        assert.equal(ledger.leaseFor(temp, "feature")?.run_id, runId);
      } finally {
        await installAbortReaping({ pid: process.pid });
        ledger.close();
      }
    }
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});
