import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DomainLedger, main } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("post-pass cleanup assigns exact gateCleanupOid with completionAttestation then attestation fallback", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../scripts/orca-no-mistakes.ts", import.meta.url)),
    "utf8",
  );
  const start = source.indexOf("const result = await runPipeline(");
  const end = source.indexOf("await orca.notifyRunResult(", start);
  assert.ok(start >= 0 && end > start);
  const postPassSetup = source.slice(start, end);
  assert.match(
    postPassSetup,
    /gateCleanupOid =\s*result\.completionAttestation\?\.candidateCommitOid \?\?\s*result\.attestation\?\.candidateCommitOid \?\?\s*gateCleanupOid;/u,
  );
  assert.doesNotMatch(postPassSetup, /await git\.head\(\)/u);
});

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

test("fresh runs fail closed on unsupported forge while init remains provider-neutral", async () => {
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

    await assert.rejects(
      () => main(["run", "--repo", repo, "--base", "main", "--intent", "Run on local forge repo"]),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("unsupported forge: new runs require GitHub"),
    );
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});
