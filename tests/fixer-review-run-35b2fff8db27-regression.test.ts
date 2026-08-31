import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DomainLedger, main } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function repository(repo: string): Promise<string> {
  await mkdir(repo, { recursive: true });
  const root = await realpath(repo);
  git(root, "-c", "init.templateDir=", "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "core.hooksPath", "/dev/null");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "tag.gpgSign", "false");
  await writeFile(path.join(root, "README.md"), "main\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "main");
  return root;
}

async function completedRun(
  home: string,
  repo: string,
  runId: string,
): Promise<string> {
  const ledger = new DomainLedger({ repositoryPath: repo });
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: runId,
    policySha256: "f".repeat(64),
    repoRoot: repo,
    runId,
    submissionCommitOid: "a".repeat(40),
  });
  ledger.finishRun(runId, "failed");
  ledger.close();
  const artifacts = path.join(home, "artifacts", runId);
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "review.log"), "output\n");
  return artifacts;
}

test("prune directly retains in-progress and leased runs", () => {
  const ledger = new DomainLedger(":memory:");
  for (const [runId, repoRoot] of [
    ["run-live", "/repo/live"],
    ["run-leased", "/repo/leased"],
  ]) {
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: runId,
      policySha256: "f".repeat(64),
      repoRoot,
      runId,
      submissionCommitOid: "a".repeat(40),
    });
  }
  ledger.acquireLease({
    branch: "feature",
    repoRoot: "/repo/leased",
    runId: "run-leased",
  });
  ledger.finishRun("run-leased", "failed");

  assert.equal(ledger.prune(["run-live"]), 0);
  assert.equal(ledger.prune(["run-leased"]), 0);
  assert.equal(ledger.runStatus("run-live"), "in-progress");
  assert.equal(ledger.runStatus("run-leased"), "failed");
  ledger.close();
});

test("a same-named tag cannot substitute for a deleted feature branch", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-prune-tag-dwim-"));
  const home = path.join(temp, "home");
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  try {
    const repo = await repository(path.join(temp, "repo"));
    git(repo, "checkout", "-b", "feature");
    await writeFile(path.join(repo, "feature.txt"), "feature\n");
    git(repo, "add", "feature.txt");
    git(repo, "commit", "-m", "feature");
    const recoveryOid = git(repo, "rev-parse", "HEAD");
    git(repo, "tag", "feature", recoveryOid);
    git(repo, "checkout", "main");
    git(repo, "branch", "-D", "feature");

    const runId = "run-tag-collision";
    const artifacts = await completedRun(home, repo, runId);
    git(
      repo,
      "update-ref",
      `refs/no-mistakes/recover/${runId}`,
      recoveryOid,
    );

    await main(["prune", "--before=2999-01-01", `--repo=${repo}`]);

    const ledger = new DomainLedger({ repositoryPath: repo });
    assert.equal(ledger.runStatus(runId), "failed");
    ledger.close();
    assert.equal(existsSync(artifacts), true);
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});

test("an unrelated repository at the recorded path requires --repo", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-prune-reused-path-"));
  const home = path.join(temp, "home");
  const previousCwd = process.cwd();
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  try {
    process.chdir(temp);
    const repo = await repository(path.join(temp, "repo"));
    const recoveryOid = git(repo, "rev-parse", "HEAD");
    const runId = "run-reused-path";
    const recoveryRef = `refs/no-mistakes/recover/${runId}`;
    git(repo, "update-ref", recoveryRef, recoveryOid);

    const movedRepo = path.join(temp, "original-repo");
    await rename(repo, movedRepo);
    await repository(repo);
    const artifacts = await completedRun(home, repo, runId);

    process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "unrelated-home");
    await main(["prune", "--before=2999-01-01"]);
    process.env.ORCA_NO_MISTAKES_HOME = home;
    let ledger = new DomainLedger({ repositoryPath: repo });
    assert.equal(ledger.runStatus(runId), "failed");
    ledger.close();
    assert.equal(existsSync(artifacts), true);

    await main(["prune", "--before=2999-01-01", `--repo=${repo}`]);
    ledger = new DomainLedger({ repositoryPath: repo });
    assert.equal(ledger.runStatus(runId), undefined);
    ledger.close();
    assert.equal(existsSync(artifacts), false);
    assert.equal(git(movedRepo, "rev-parse", recoveryRef), recoveryOid);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});

test("a recovery ref that does not resolve to a commit aborts prune", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-prune-noncommit-ref-"));
  const home = path.join(temp, "home");
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  try {
    const repo = await repository(path.join(temp, "repo"));
    const runId = "run-noncommit-ref";
    const artifacts = await completedRun(home, repo, runId);
    const blob = git(repo, "rev-parse", "HEAD:README.md");
    git(repo, "update-ref", `refs/no-mistakes/recover/${runId}`, blob);

    await assert.rejects(
      main(["prune", "--before=2999-01-01", `--repo=${repo}`]),
      /git rev-parse failed/,
    );

    const ledger = new DomainLedger({ repositoryPath: repo });
    assert.equal(ledger.runStatus(runId), "failed");
    ledger.close();
    assert.equal(existsSync(artifacts), true);
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});
