import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DomainLedger, GitShell, main } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(origin: string, gateId: string): string {
  const digest = createHash("sha256").update(gateId).digest("hex").slice(0, 32);
  return path.join(origin, ".orca", "no-mistakes", `gate-${digest}.json`);
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("stale terminal cleanup cannot replace newer resume recovery custody", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-stale-resume-cleanup-"));
  const repoPath = path.join(temp, "repo");
  const gatePath = path.join(temp, "gate");
  const home = path.join(temp, "home");
  const orcaCommand = path.join(temp, "orca");
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousOrca = process.env.ORCA_CLI_COMMAND;
  try {
    await mkdir(path.join(repoPath, ".orca", "no-mistakes"), { recursive: true });
    git(repoPath, "-c", "init.templateDir=", "init", "-b", "feature");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test User");
    git(repoPath, "commit", "--allow-empty", "-m", "checkpoint");
    const repo = await realpath(repoPath);
    const checkpoint = git(repo, "rev-parse", "HEAD");
    git(repo, "worktree", "add", "-b", "gate", gatePath);
    await writeFile(path.join(gatePath, "stale.txt"), "stale generation\n");
    git(gatePath, "add", "stale.txt");
    git(gatePath, "commit", "-m", "stale generation");
    const staleTip = git(gatePath, "rev-parse", "HEAD");
    const canonicalGate = await realpath(gatePath);
    const gateId = `repo::${canonicalGate}`;
    const originId = `repo::${repo}`;
    const runId = "run-stale-resume-cleanup";
    const marker = markerPath(repo, gateId);

    process.env.ORCA_NO_MISTAKES_HOME = home;
    const ledger = new DomainLedger();
    try {
      ledger.startRun({
        baseBranch: "main",
        branch: "feature",
        intent: "Fence stale cleanup generations.",
        policySha256: "a".repeat(64),
        repoRoot: repo,
        runId,
        submissionCommitOid: checkpoint,
      });
      const firstGeneration = ledger.acquireLease({
        branch: "feature",
        repoRoot: repo,
        runId,
      });
      ledger.recordCheckpoint({
        inputCommitOid: checkpoint,
        outputCommitOid: checkpoint,
        roundIndex: 0,
        runId,
        stageId: "intent",
      });
      assert.equal(
        ledger.settleRun(runId, "failed", {
          branch: "feature",
          generationToken: firstGeneration,
          repoRoot: repo,
        }),
        true,
      );
      const claim = ledger.prepareResume({
        baseBranch: "main",
        branch: "feature",
        effectivePolicyHash: "b".repeat(64),
        head: checkpoint,
        intent: "Fence stale cleanup generations.",
        policySha256: "a".repeat(64),
        repoRoot: repo,
        runId,
      });
      const resumed = ledger.resumeRun({
        baseBranch: "main",
        branch: "feature",
        claimId: claim.claimId,
        effectivePolicyHash: "b".repeat(64),
        head: checkpoint,
        intent: "Fence stale cleanup generations.",
        policySha256: "a".repeat(64),
        repoRoot: repo,
        runId,
      });
      await new GitShell({ repo }).anchorRecoveryRef(
        runId,
        checkpoint,
        resumed.generationToken,
      );
      assert.equal(
        ledger.settleRun(runId, "failed", {
          branch: "feature",
          generationToken: resumed.generationToken,
          repoRoot: repo,
        }),
        true,
      );
      await writeFile(
        marker,
        JSON.stringify({
          createdAt: new Date().toISOString(),
          domainRunId: runId,
          gate: { branch: "gate", id: gateId, kind: "orca", path: canonicalGate },
          generationToken: firstGeneration,
          originWorktree: repo,
          pid: deadPid(),
          runId,
          terminalHandle: "term-stale",
        }),
      );
    } finally {
      ledger.close();
    }

    await writeFile(
      orcaCommand,
      `#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") {
  const worktrees = [{ id: ${JSON.stringify(originId)}, path: ${JSON.stringify(repo)}, branch: "refs/heads/feature", head: ${JSON.stringify(checkpoint)} }]
  if (existsSync(${JSON.stringify(canonicalGate)})) worktrees.push({ id: ${JSON.stringify(gateId)}, path: ${JSON.stringify(canonicalGate)}, branch: "refs/heads/gate", head: ${JSON.stringify(staleTip)}, parentWorktreeId: ${JSON.stringify(originId)} })
  out({ worktrees })
} else if (args[0] === "terminal" && args[1] === "list") out({ terminals: [{ connected: false, handle: "term-stale" }] })
else if (args[0] === "terminal" && args[1] === "close") out({ closed: true })
else if (args[0] === "orchestration" && args[1] === "task-list") out({ tasks: [{ id: "task-stale", status: "in_progress" }] })
else if (args[0] === "orchestration" && args[1] === "task-update") out({ task: { id: "task-stale", status: "failed" } })
else if (args[0] === "worktree" && args[1] === "rm") {
  execFileSync("git", ["worktree", "remove", "--force", ${JSON.stringify(canonicalGate)}], { cwd: ${JSON.stringify(repo)} })
  out({ removed: true })
} else { console.error(JSON.stringify({ error: { code: "unexpected", args } })); process.exit(1) }
`,
    );
    await chmod(orcaCommand, 0o755);
    process.env.ORCA_CLI_COMMAND = orcaCommand;

    await main(["prune", "--stranded", "--repo", repo]);

    assert.equal(
      git(repo, "rev-parse", `refs/no-mistakes/recover/${runId}`),
      checkpoint,
    );
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(canonicalGate), true);
  } finally {
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    restoreEnv("ORCA_CLI_COMMAND", previousOrca);
    await rm(temp, { force: true, recursive: true });
  }
});
