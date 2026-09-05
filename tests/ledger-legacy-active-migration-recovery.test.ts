import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  LegacyActiveMigrationError,
  legacyLedgerPath,
} from "../scripts/ledger.ts";
import { main } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(repo: string, gatePath: string): string {
  const digest = createHash("sha256").update(gatePath).digest("hex").slice(0, 32);
  return path.join(repo, ".orca", "no-mistakes", `gate-${digest}.json`);
}

test("stranded cleanup unlocks legacy migration and repository resume", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-legacy-stranded-"));
  const home = path.join(temp, "home");
  const repoPath = path.join(temp, "repo");
  const runsPath = path.join(temp, "runs");
  const command = path.join(temp, "orca");
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
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
    const runId = "legacy-stranded-run";
    const resumeRunId = "legacy-resume-run";
    const intent = "Resume migrated legacy evidence.";
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
    const legacy = new DomainLedger(legacyLedgerPath());
    legacy.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Recover the stranded legacy run.",
      policySha256: policy,
      repoRoot: repo,
      runId,
      submissionCommitOid: head,
    });
    const generationToken = legacy.acquireLease({
      branch: "feature",
      repoRoot: repo,
      runId,
    });
    legacy.startRun({
      baseBranch: "main",
      branch: "feature",
      intent,
      policySha256: policy,
      repoRoot: repo,
      runId: resumeRunId,
      submissionCommitOid: head,
    });
    legacy.recordCheckpoint({
      inputCommitOid: head,
      outputCommitOid: head,
      roundIndex: 0,
      runId: resumeRunId,
      stageId: "lint",
    });
    legacy.finishRun(resumeRunId, "failed");
    legacy.close();

    assert.throws(
      () => new DomainLedger({ repositoryPath: repo }),
      (error: unknown) =>
        error instanceof LegacyActiveMigrationError &&
        /orca-no-mistakes prune --stranded --repo <repo>/u.test(error.message),
    );

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

    const cleaned = new DomainLedger(legacyLedgerPath());
    assert.equal(cleaned.runStatus(runId), "cancelled");
    assert.equal(cleaned.leaseFor(repo, "feature"), undefined);
    cleaned.close();

    const migrated = new DomainLedger({ repositoryPath: repo });
    assert.equal(
      migrated.prepareResume({
        baseBranch: "main",
        branch: "feature",
        effectivePolicyHash: policy,
        head,
        intent,
        policySha256: policy,
        repoRoot: repo,
        runId: resumeRunId,
      }).checkpoint.stage_id,
      "lint",
    );
    migrated.close();
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousCommand;
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});
