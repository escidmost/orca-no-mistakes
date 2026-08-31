import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DestinationActiveMigrationError,
  DomainLedger,
  legacyLedgerPath,
  repositoryLedgerPath,
} from "../scripts/ledger.ts";
import { main } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(repo: string, gatePath: string): string {
  const digest = createHash("sha256").update(gatePath).digest("hex").slice(0, 32);
  return path.join(repo, ".orca", "no-mistakes", `gate-${digest}.json`);
}

test("stranded cleanup unlocks destination-active migration", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-destination-stranded-"));
  const home = path.join(temp, "home");
  const repoPath = path.join(temp, "repo");
  const runsPath = path.join(temp, "runs");
  const command = path.join(temp, "orca");
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousCwd = process.cwd();
  try {
    await mkdir(path.join(repoPath, ".orca", "no-mistakes"), { recursive: true });
    await mkdir(runsPath);
    git(repoPath, "-c", "init.templateDir=", "init", "-b", "feature");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test User");
    git(repoPath, "commit", "--allow-empty", "-m", "seed");
    const repo = await realpath(repoPath);
    const root = await realpath(runsPath);
    const head = git(repo, "rev-parse", "HEAD");
    const runId = "destination-stranded-run";
    const legacyRunId = "late-legacy-run";
    const policy = "f".repeat(64);
    const gate = {
      branch: `no-mistakes-gate-${runId}`,
      intentTaskId: "task-intent",
      kind: "configured" as const,
      path: path.join(root, runId),
      root,
      runId,
    };
    git(repo, "worktree", "add", "-b", gate.branch, gate.path, "HEAD");
    gate.path = await realpath(gate.path);

    process.env.ORCA_NO_MISTAKES_HOME = home;
    new DomainLedger({ repositoryPath: repo }).close();
    const destination = new DomainLedger(repositoryLedgerPath(repo));
    destination.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Recover the stranded destination run.",
      policySha256: policy,
      repoRoot: repo,
      runId,
      submissionCommitOid: head,
    });
    const generationToken = destination.acquireLease({
      branch: "feature",
      repoRoot: repo,
      runId,
    });
    destination.close();

    const legacy = new DomainLedger(legacyLedgerPath());
    legacy.startRun({
      baseBranch: "main",
      branch: "legacy-feature",
      intent: "Preserve late legacy evidence.",
      policySha256: policy,
      repoRoot: repo,
      runId: legacyRunId,
      submissionCommitOid: head,
    });
    legacy.finishRun(legacyRunId, "failed");
    legacy.close();

    assert.throws(
      () => new DomainLedger({ repositoryPath: repo }),
      DestinationActiveMigrationError,
    );

    process.chdir(repo);
    await main(["prune", "--repo", path.join(temp, "missing-repo")]);
    process.chdir(previousCwd);

    await writeFile(
      markerPath(repo, gate.path),
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate,
        generationToken,
        originWorktree: repo,
        pid: spawnSync(process.execPath, ["-e", ""]).pid,
        runId,
      }),
    );
    await writeFile(
      command,
      `#!/usr/bin/env node
const args = process.argv.slice(2)
const result = args[0] === "orchestration" && args[1] === "task-list"
  ? { tasks: [{ id: "task-intent", status: "in_progress" }] }
  : { accepted: true }
console.log(JSON.stringify({ result }))
`,
    );
    await chmod(command, 0o755);
    process.env.ORCA_CLI_COMMAND = command;

    await main(["prune", "--stranded", "--repo", repo]);

    const migrated = new DomainLedger({ repositoryPath: repo });
    assert.equal(migrated.runStatus(runId), "cancelled");
    assert.equal(migrated.leaseFor(repo, "feature"), undefined);
    assert.equal(migrated.runStatus(legacyRunId), "failed");
    migrated.close();
  } finally {
    process.chdir(previousCwd);
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousCommand;
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});
