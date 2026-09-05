import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DomainLedger } from "../scripts/ledger.ts";
import { GitShell } from "../scripts/orca-no-mistakes.ts";

const oid = (value: number): string => value.toString(16).padStart(40, "0");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("stale resume generations cannot settle the current run", () => {
  const ledger = new DomainLedger(":memory:");
  const repoRoot = "/repo";
  const branch = "feature";
  const runId = "resume-generation-run";
  const head = oid(1);
  const policySha256 = "a".repeat(64);
  const effectivePolicyHash = "b".repeat(64);
  ledger.startRun({
    baseBranch: "main",
    branch,
    intent: "Fence resume generations.",
    policySha256,
    repoRoot,
    runId,
    submissionCommitOid: head,
  });
  const firstGeneration = ledger.acquireLease({ branch, repoRoot, runId });
  ledger.recordCheckpoint({
    inputCommitOid: head,
    outputCommitOid: head,
    roundIndex: 0,
    runId,
    stageId: "intent",
  });
  assert.equal(
    ledger.settleRun(runId, "failed", {
      branch,
      generationToken: firstGeneration,
      repoRoot,
    }),
    true,
  );

  try {
    const claim = ledger.prepareResume({
      baseBranch: "main",
      branch,
      effectivePolicyHash,
      head,
      intent: "Fence resume generations.",
      policySha256,
      repoRoot,
      runId,
    });
    const resumed = ledger.resumeRun({
      baseBranch: "main",
      branch,
      claimId: claim.claimId,
      effectivePolicyHash,
      head,
      intent: "Fence resume generations.",
      policySha256,
      repoRoot,
      runId,
    });
    assert.notEqual(resumed.generationToken, firstGeneration);
    assert.equal(
      ledger.settleRun(runId, "cancelled", {
        branch,
        generationToken: firstGeneration,
        repoRoot,
      }),
      false,
    );
    assert.equal(ledger.runStatus(runId), "in-progress");
    assert.equal(
      ledger.leaseFor(repoRoot, branch)?.generation_token,
      resumed.generationToken,
    );
  } finally {
    ledger.close();
  }
});

test("resume recovery preserves the old lineage by generation", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "onm-resume-recovery-"));
  try {
    git(repo, "-c", "init.templateDir=", "init", "-b", "feature");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "commit.gpgsign", "false");
    await writeFile(path.join(repo, "state.txt"), "checkpoint\n");
    git(repo, "add", "state.txt");
    git(repo, "commit", "-m", "checkpoint");
    const checkpoint = git(repo, "rev-parse", "HEAD");
    await writeFile(path.join(repo, "state.txt"), "old recovery\n");
    git(repo, "commit", "-am", "old recovery");
    const oldRecovery = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/no-mistakes/recover/resume-run", oldRecovery);
    git(repo, "checkout", "--detach", checkpoint);
    await writeFile(path.join(repo, "state.txt"), "resumed lineage\n");
    git(repo, "commit", "-am", "resumed lineage");
    const resumedTip = git(repo, "rev-parse", "HEAD");

    await new GitShell({ repo }).anchorRecoveryRef("resume-run", resumedTip, 2);

    assert.equal(
      git(repo, "rev-parse", "refs/no-mistakes/recover/resume-run"),
      resumedTip,
    );
    assert.equal(
      git(repo, "rev-parse", "refs/no-mistakes/recover-generations/resume-run/2"),
      oldRecovery,
    );
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
});
