import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DomainLedger } from "../scripts/ledger.ts";
import { GitShell } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("custody transfer refuses a reclaimed lease generation before CAS", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-lease-custody-"));
  const repo = path.join(temp, "repo");
  const worker = path.join(temp, "worker");
  const ledger = new DomainLedger(":memory:");
  try {
    git(temp, "init", repo);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "checkout", "-b", "feature");
    await writeFile(path.join(repo, "change.txt"), "submission\n");
    git(repo, "add", "change.txt");
    git(repo, "commit", "-m", "submission");
    const submission = git(repo, "rev-parse", "HEAD");
    git(repo, "worktree", "add", "-b", "worker", worker, "feature");
    await writeFile(path.join(worker, "change.txt"), "terminal\n");
    git(worker, "add", "change.txt");
    git(worker, "commit", "-m", "terminal");
    const terminal = git(worker, "rev-parse", "HEAD");

    for (const runId of ["stale-run", "new-owner"]) {
      ledger.startRun({
        baseBranch: "main",
        branch: "feature",
        intent: "Fence custody transfer.",
        policySha256: "a".repeat(64),
        repoRoot: repo,
        runId,
        submissionCommitOid: submission,
      });
    }
    const generationToken = ledger.acquireLease({
      branch: "feature",
      repoRoot: repo,
      runId: "stale-run",
    });
    let checks = 0;
    const fence = {
      get aborted() {
        checks += 1;
        if (checks === 2) {
          ledger.acquireLease({
            branch: "feature",
            force: true,
            repoRoot: repo,
            runId: "new-owner",
          });
        }
        return !ledger.ownsLease("stale-run", {
          branch: "feature",
          generationToken,
          repoRoot: repo,
        });
      },
    };

    assert.equal(
      await new GitShell({ repo }).applyWorktreeCommits(
        worker,
        submission,
        terminal,
        fence,
      ),
      false,
    );
    assert.equal(git(repo, "rev-parse", "refs/heads/feature"), submission);
    assert.equal(git(repo, "rev-parse", "HEAD"), submission);
    assert.equal(ledger.leaseFor(repo, "feature")?.run_id, "new-owner");
    assert.ok(checks >= 2);
  } finally {
    ledger.close();
    await rm(temp, { force: true, recursive: true });
  }
});
