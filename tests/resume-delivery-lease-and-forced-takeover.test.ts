import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  installAbortReaping,
  reapAbortedRun,
  registerAbortRunContext,
  type GitOperations,
} from "../scripts/orca-no-mistakes.ts";

const head = "a".repeat(40);

function startRun(ledger: DomainLedger, repoRoot: string, runId: string): void {
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "resume safely",
    policySha256: "b".repeat(64),
    repoRoot,
    runId,
    submissionCommitOid: head,
  });
}

test("detached abort settles the persisted delivery branch lease", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "onm-abort-domain-branch-"));
  const ledger = new DomainLedger(":memory:");
  const runId = "run-detached-abort";
  startRun(ledger, repoRoot, runId);
  const generationToken = ledger.acquireLease({ branch: "feature", repoRoot, runId });
  const git = {
    async anchorRecoveryRef() {},
    async head() {
      return head;
    },
  } as unknown as GitOperations;
  try {
    await installAbortReaping({
      gate: {
        branch: "no-mistakes-gate-run-detached-abort",
        id: `repo::${path.join(repoRoot, "gate")}`,
        kind: "orca",
        path: path.join(repoRoot, "gate"),
      },
      originWorktree: repoRoot,
      pid: process.pid,
    });
    await registerAbortRunContext({
      deliveryGit: git,
      generationToken,
      git,
      ledger,
      runId,
    });

    await reapAbortedRun("detached abort");

    assert.equal(ledger.runStatus(runId), "cancelled");
    assert.equal(ledger.leaseFor(repoRoot, "feature"), undefined);
  } finally {
    await installAbortReaping({ pid: process.pid });
    ledger.close();
    await rm(repoRoot, { force: true, recursive: true });
  }
});

test("forced takeover advances the generation before same-domain resume", () => {
  const ledger = new DomainLedger(":memory:");
  const repoRoot = "/repo";
  const firstRunId = "run-first-owner";
  const resumedRunId = "run-forced-owner";
  startRun(ledger, repoRoot, firstRunId);
  const firstGeneration = ledger.acquireLease({
    branch: "feature",
    repoRoot,
    runId: firstRunId,
  });
  startRun(ledger, repoRoot, resumedRunId);
  const forcedGeneration = ledger.acquireLease({
    branch: "feature",
    force: true,
    repoRoot,
    runId: resumedRunId,
  });
  ledger.recordCheckpoint({
    inputCommitOid: head,
    outputCommitOid: head,
    roundIndex: 0,
    runId: resumedRunId,
    stageId: "intent",
  });
  assert.ok(forcedGeneration > firstGeneration);
  assert.equal(
    ledger.settleRun(resumedRunId, "failed", {
      branch: "feature",
      generationToken: forcedGeneration,
      repoRoot,
    }),
    true,
  );

  try {
    const claim = ledger.prepareResume({
      baseBranch: "main",
      branch: "feature",
      effectivePolicyHash: "c".repeat(64),
      head,
      intent: "resume safely",
      policySha256: "b".repeat(64),
      repoRoot,
      runId: resumedRunId,
    });
    const resumed = ledger.resumeRun({
      baseBranch: "main",
      branch: "feature",
      claimId: claim.claimId,
      effectivePolicyHash: "c".repeat(64),
      head,
      intent: "resume safely",
      policySha256: "b".repeat(64),
      repoRoot,
      runId: resumedRunId,
    });

    assert.ok(resumed.generationToken > forcedGeneration);
    assert.equal(
      ledger.leaseFor(repoRoot, "feature")?.generation_token,
      resumed.generationToken,
    );
  } finally {
    ledger.close();
  }
});
