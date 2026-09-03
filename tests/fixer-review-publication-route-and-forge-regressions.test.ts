import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DomainLedger, main } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("startRun does not snapshot publication route when head or base branch mismatches", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-branch-mismatch-"));
  const dbPath = path.join(temp, "ledger.sqlite");
  const ledger = new DomainLedger(dbPath);
  try {
    ledger.setRepositoryPublicationRoute({
      actorId: "U_1",
      actorLogin: "operator",
      actorNodeId: "U_node_1",
      backend: "gh" as const,
      backendVersion: "2.97.0",
      baseBranch: "main",
      baseRepositoryId: "1",
      baseRepositoryName: "upstream/project",
      baseRepositoryNodeId: "R_base",
      credentialSource: "stored-account" as const,
      forgeHost: "github.com" as const,
      headBranch: "main",
      headOwner: "upstream",
      headRepositoryId: "1",
      headRepositoryName: "upstream/project",
      headRepositoryNodeId: "R_base",
      networkRootRepositoryId: "1",
      observedAt: new Date().toISOString(),
      repoRoot: "/repo",
    });

    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Feature run.",
      policySha256: "b".repeat(64),
      repoRoot: "/repo",
      runId: "run-mismatched",
      submissionCommitOid: "a".repeat(40),
    });

    assert.equal(ledger.publicationRoute("run-mismatched"), undefined);

    assert.throws(
      () => ledger.recordStoredPublicationRoute("run-mismatched", "/repo"),
      /stored publication route \(main -> main\) does not match run \(feature -> main\)/,
    );
  } finally {
    ledger.close();
    await rm(temp, { force: true, recursive: true });
  }
});

test("init remains provider-neutral for repositories without GitHub remotes", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-unsupported-forge-"));
  const origin = path.join(temp, "origin.git");
  const repo = path.join(temp, "repo");
  try {
    git(temp, "-c", "init.templateDir=", "init", "--bare", origin);
    git(temp, "-c", "init.templateDir=", "init", "-b", "main", repo);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "commit", "--allow-empty", "-m", "initial commit");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-u", "origin", "main");
    git(temp, `--git-dir=${origin}`, "symbolic-ref", "HEAD", "refs/heads/main");
    git(repo, "checkout", "-b", "feature");

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => {
      logs.push(msg);
    };
    try {
      await main(["init", "--repo", repo]);
    } finally {
      console.log = originalLog;
    }
    const initReceipt = JSON.parse(logs.at(-1) ?? "{}");
    assert.equal(initReceipt.route, null);

  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});
