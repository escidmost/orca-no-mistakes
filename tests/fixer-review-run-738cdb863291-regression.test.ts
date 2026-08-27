import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
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

async function repository(root: string): Promise<{
  feature: string;
  repo: string;
}> {
  await mkdir(path.join(root, "repo"));
  const repo = await realpath(path.join(root, "repo"));
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "core.hooksPath", "/dev/null");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, "README.md"), "main\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "main");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(repo, "checkout", "-b", "feature");
  await writeFile(path.join(repo, "feature.txt"), "feature\n");
  git(repo, "add", "feature.txt");
  git(repo, "commit", "-m", "feature");
  return { feature: git(repo, "rev-parse", "HEAD"), repo };
}

function completedRun(repo: string, runId: string): void {
  const ledger = new DomainLedger();
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
}

test("prune retains unmerged fixer refs and never deletes contained refs", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-prune-fixer-ref-"));
  const home = path.join(temp, "home");
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  try {
    const { feature, repo } = await repository(temp);
    git(repo, "checkout", "-b", "stray");
    await writeFile(path.join(repo, "stray.txt"), "stray\n");
    git(repo, "add", "stray.txt");
    git(repo, "commit", "-m", "stray");
    const stray = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "feature");
    git(repo, "branch", "-D", "stray");

    const runId = "run-fixer-child";
    const parentRef = `refs/no-mistakes/recover/${runId}`;
    const childRef = `${parentRef}-fixer-review-1`;
    completedRun(repo, runId);
    git(repo, "update-ref", parentRef, feature);
    git(repo, "update-ref", childRef, stray);
    const artifacts = path.join(home, "artifacts", runId);
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, "review.log"), "output\n");

    await main(["prune", "--before=2999-01-01", `--repo=${repo}`]);
    let ledger = new DomainLedger();
    assert.equal(ledger.runStatus(runId), "failed");
    ledger.close();
    assert.equal(existsSync(artifacts), true);

    git(repo, "update-ref", childRef, feature);
    await main(["prune", "--before=2999-01-01", `--repo=${repo}`]);
    ledger = new DomainLedger();
    assert.equal(ledger.runStatus(runId), undefined);
    ledger.close();
    assert.equal(existsSync(artifacts), false);
    assert.equal(git(repo, "rev-parse", parentRef), feature);
    assert.equal(git(repo, "rev-parse", childRef), feature);
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});

test("missing repositories require an exact --repo assertion", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-prune-missing-repo-"));
  const home = path.join(temp, "home");
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  try {
    const missingRepo = path.join(temp, "gone");
    const runId = "run-gone";
    completedRun(missingRepo, runId);
    const artifacts = path.join(home, "artifacts", runId);
    await mkdir(artifacts, { recursive: true });

    await main(["prune", "--before=2999-01-01"]);
    let ledger = new DomainLedger();
    assert.equal(ledger.runStatus(runId), "failed");
    ledger.close();
    assert.equal(existsSync(artifacts), true);

    await main([
      "prune",
      "--before=2999-01-01",
      `--repo=${missingRepo}`,
    ]);
    ledger = new DomainLedger();
    assert.equal(ledger.runStatus(runId), undefined);
    ledger.close();
    assert.equal(existsSync(artifacts), false);
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});

test("a feature branch deleted after merge still prunes against its base", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-prune-gone-branch-"));
  const home = path.join(temp, "home");
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  try {
    const { feature, repo } = await repository(temp);
    const runId = "run-merged-branch";
    completedRun(repo, runId);
    git(repo, "update-ref", `refs/no-mistakes/recover/${runId}`, feature);
    // The pull request merged: the feature commits reached the base and the
    // branch itself was deleted, which is the ordinary end state for a run.
    git(repo, "checkout", "main");
    git(repo, "merge", "--ff-only", feature);
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "branch", "-D", "feature");
    const artifacts = path.join(home, "artifacts", runId);
    await mkdir(artifacts, { recursive: true });

    await main(["prune", "--before=2999-01-01"]);

    const ledger = new DomainLedger();
    assert.equal(ledger.runStatus(runId), undefined);
    ledger.close();
    assert.equal(existsSync(artifacts), false);
    // Preserved commits outlive the pruned run: prune reclaims ledger rows and
    // artifact logs, never Git history.
    assert.equal(
      git(repo, "rev-parse", `refs/no-mistakes/recover/${runId}`),
      feature,
    );
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});

test("recovery ref inspection exits 124 and 128 abort prune", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-prune-git-failure-"));
  const home = path.join(temp, "home");
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousPath = process.env.PATH;
  const previousRealGit = process.env.ONM_TEST_REAL_GIT;
  const previousExit = process.env.ONM_TEST_GIT_EXIT;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  try {
    const { feature, repo } = await repository(temp);
    const runId = "run-inspection-failure";
    completedRun(repo, runId);
    git(repo, "update-ref", `refs/no-mistakes/recover/${runId}`, feature);
    const artifacts = path.join(home, "artifacts", runId);
    await mkdir(artifacts, { recursive: true });

    const bin = path.join(temp, "bin");
    await mkdir(bin);
    const wrapper = path.join(bin, "git");
    await writeFile(
      wrapper,
      `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("rev-parse")) process.exit(Number(process.env.ONM_TEST_GIT_EXIT));
const result = spawnSync(process.env.ONM_TEST_REAL_GIT, args, { encoding: "utf8" });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`,
    );
    await chmod(wrapper, 0o755);
    // Resolved by scanning PATH rather than shelling out to `which`, which is
    // absent from minimal CI images.
    const realGit = (previousPath ?? "")
      .split(path.delimiter)
      .map((entry) => path.join(entry, "git"))
      .find((candidate) => existsSync(candidate));
    assert.ok(realGit, "git must be on PATH");
    process.env.ONM_TEST_REAL_GIT = realGit;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;

    for (const code of [124, 128]) {
      process.env.ONM_TEST_GIT_EXIT = String(code);
      await assert.rejects(
        main(["prune", "--before=2999-01-01", `--repo=${repo}`]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(runId));
          assert.match(error.message, new RegExp(`\\(${code}\\)`));
          return true;
        },
      );
    }
    const ledger = new DomainLedger();
    assert.equal(ledger.runStatus(runId), "failed");
    ledger.close();
    assert.equal(existsSync(artifacts), true);
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousRealGit === undefined) delete process.env.ONM_TEST_REAL_GIT;
    else process.env.ONM_TEST_REAL_GIT = previousRealGit;
    if (previousExit === undefined) delete process.env.ONM_TEST_GIT_EXIT;
    else process.env.ONM_TEST_GIT_EXIT = previousExit;
    await rm(temp, { recursive: true, force: true });
  }
});

test("artifact removal failure leaves the ledger row retryable", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-prune-artifact-failure-"));
  const home = path.join(temp, "home");
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  let artifacts: string | undefined;
  try {
    const { feature, repo } = await repository(temp);
    const runId = "run-unwritable-artifacts";
    completedRun(repo, runId);
    git(repo, "update-ref", `refs/no-mistakes/recover/${runId}`, feature);
    artifacts = path.join(home, "artifacts", runId);
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, "review.log"), "output\n");
    await chmod(path.dirname(artifacts), 0o500);

    await assert.rejects(
      main(["prune", "--before=2999-01-01", `--repo=${repo}`]),
    );
    const ledger = new DomainLedger();
    assert.equal(ledger.runStatus(runId), "failed");
    ledger.close();
  } finally {
    if (artifacts) await chmod(path.dirname(artifacts), 0o700);
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});
