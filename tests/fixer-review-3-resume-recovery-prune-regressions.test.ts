import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DomainLedger } from "../scripts/ledger.ts";
import { GitShell, main } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function seedRepo(prefix: string): Promise<{ repo: string; temp: string }> {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const repo = path.join(temp, "repo");
  git(temp, "-c", "init.templateDir=", "init", "-b", "main", repo);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, "state.txt"), "main\n");
  git(repo, "add", "state.txt");
  git(repo, "commit", "-m", "main");
  git(repo, "checkout", "-b", "feature");
  await writeFile(path.join(repo, "state.txt"), "checkpoint\n");
  git(repo, "commit", "-am", "checkpoint");
  return { repo: await realpath(repo), temp };
}

test("the current resume generation can replace lineage while stale generations cannot", async () => {
  const { repo, temp } = await seedRepo("onm-resume-generation-fence-");
  try {
    const shell = new GitShell({ repo });
    const runId = "resume-generation-fence";
    const checkpoint = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", `refs/no-mistakes/recover/${runId}`, checkpoint);
    await shell.anchorRecoveryRef(runId, checkpoint, 1);

    await writeFile(path.join(repo, "state.txt"), "failed lineage\n");
    git(repo, "commit", "-am", "failed lineage");
    const failedTip = git(repo, "rev-parse", "HEAD");
    await shell.anchorRecoveryRef(runId, failedTip, 1);

    await shell.anchorRecoveryRef(runId, checkpoint, 2);
    await assert.rejects(
      shell.anchorRecoveryRef(runId, checkpoint, 1),
      /recovery generation 1 is stale/,
    );
    git(repo, "reset", "--hard", checkpoint);
    await writeFile(path.join(repo, "state.txt"), "resumed lineage\n");
    git(repo, "commit", "-am", "resumed lineage");
    const resumedTip = git(repo, "rev-parse", "HEAD");
    await shell.anchorRecoveryRef(runId, resumedTip, 2);

    assert.equal(
      git(repo, "rev-parse", `refs/no-mistakes/recover/${runId}`),
      resumedTip,
    );
    assert.equal(
      git(repo, "rev-parse", `refs/no-mistakes/recover-generations/${runId}/2`),
      failedTip,
    );
    await assert.rejects(
      shell.anchorRecoveryRef(runId, checkpoint, 1),
      /recovery generation 1 is stale/,
    );
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test("prune retains unmerged resume-generation custody", async () => {
  const { repo, temp } = await seedRepo("onm-prune-resume-generation-");
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const home = path.join(temp, "home");
  process.env.ORCA_NO_MISTAKES_HOME = home;
  try {
    const contained = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "--detach", contained);
    await writeFile(path.join(repo, "stray.txt"), "unmerged\n");
    git(repo, "add", "stray.txt");
    git(repo, "commit", "-m", "unmerged generation");
    const unmerged = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "feature");

    const runId = "prune-resume-generation";
    const ledger = new DomainLedger();
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Preserve resume generation custody.",
      policySha256: "f".repeat(64),
      repoRoot: repo,
      runId,
      submissionCommitOid: contained,
    });
    ledger.finishRun(runId, "passed", contained);
    ledger.close();
    git(repo, "update-ref", `refs/no-mistakes/recover/${runId}`, contained);
    git(
      repo,
      "update-ref",
      `refs/no-mistakes/recover-generations/${runId}/2`,
      unmerged,
    );
    const artifacts = path.join(home, "artifacts", runId);
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, "review.log"), "evidence\n");

    await main(["prune", "--before=2999-01-01", `--repo=${repo}`]);
    let reopened = new DomainLedger();
    assert.equal(reopened.runStatus(runId), "passed");
    reopened.close();
    assert.equal(existsSync(artifacts), true);

    git(repo, "merge", "--ff-only", unmerged);
    await main(["prune", "--before=2999-01-01", `--repo=${repo}`]);
    reopened = new DomainLedger();
    assert.equal(reopened.runStatus(runId), undefined);
    reopened.close();
    assert.equal(existsSync(artifacts), false);
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});
