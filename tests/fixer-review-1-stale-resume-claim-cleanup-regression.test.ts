import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

function markerPath(repo: string, identity: string): string {
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 32);
  return path.join(repo, ".orca", "no-mistakes", `gate-${digest}.json`);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("stale resume claims release their dead gate resources", async () => {
  for (const kind of ["configured", "orca"] as const) {
    const temp = await mkdtemp(path.join(tmpdir(), `onm-stale-claim-${kind}-`));
    const repoPath = path.join(temp, "repo");
    const rootPath = path.join(temp, "gates");
    const home = path.join(temp, "home");
    const command = path.join(temp, "orca");
    const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
    const previousOrca = process.env.ORCA_CLI_COMMAND;
    try {
      await mkdir(path.join(repoPath, ".orca", "no-mistakes"), {
        recursive: true,
      });
      await mkdir(rootPath);
      git(repoPath, "-c", "init.templateDir=", "init", "-b", "feature");
      git(repoPath, "config", "user.email", "test@example.com");
      git(repoPath, "config", "user.name", "Test User");
      git(repoPath, "commit", "--allow-empty", "-m", "checkpoint");
      const repo = await realpath(repoPath);
      const root = await realpath(rootPath);
      const checkpoint = git(repo, "rev-parse", "HEAD");
      const domainRunId = `domain-${kind}`;
      const orchestrationRunId = `resume-a-${kind}`;
      const branch = `no-mistakes-gate-${orchestrationRunId}`;
      const gatePath = path.join(
        root,
        kind === "configured" ? orchestrationRunId : branch,
      );
      git(repo, "worktree", "add", "-b", branch, gatePath);
      const canonicalGate = await realpath(gatePath);
      const gateId = `repo::${canonicalGate}`;
      const gate =
        kind === "configured"
          ? {
              branch,
              intentTaskId: "task-intent",
              kind,
              path: canonicalGate,
              root,
              runId: orchestrationRunId,
            }
          : { branch, id: gateId, kind, path: canonicalGate };
      const marker = markerPath(
        repo,
        kind === "configured" ? canonicalGate : gateId,
      );

      process.env.ORCA_NO_MISTAKES_HOME = home;
      const ledger = new DomainLedger();
      let currentGeneration: number;
      let currentHead: string;
      try {
        ledger.startRun({
          baseBranch: "main",
          branch: "feature",
          intent: "Clean a superseded startup claim.",
          policySha256: "f".repeat(64),
          repoRoot: repo,
          runId: domainRunId,
          submissionCommitOid: checkpoint,
        });
        const firstGeneration = ledger.acquireLease({
          branch: "feature",
          repoRoot: repo,
          runId: domainRunId,
        });
        ledger.recordCheckpoint({
          inputCommitOid: checkpoint,
          outputCommitOid: checkpoint,
          roundIndex: 0,
          runId: domainRunId,
          stageId: "intent",
        });
        assert.equal(
          ledger.settleRun(domainRunId, "failed", {
            branch: "feature",
            generationToken: firstGeneration,
            repoRoot: repo,
          }),
          true,
        );
        const staleClaim = ledger.prepareResume({
          baseBranch: "main",
          branch: "feature",
          effectivePolicyHash: "e".repeat(64),
          head: checkpoint,
          intent: "Clean a superseded startup claim.",
          policySha256: "f".repeat(64),
          repoRoot: repo,
          runId: domainRunId,
        });
        const currentClaim = ledger.prepareResume({
          baseBranch: "main",
          branch: "feature",
          effectivePolicyHash: "e".repeat(64),
          head: checkpoint,
          intent: "Clean a superseded startup claim.",
          policySha256: "f".repeat(64),
          repoRoot: repo,
          runId: domainRunId,
        });
        const resumed = ledger.resumeRun({
          baseBranch: "main",
          branch: "feature",
          claimId: currentClaim.claimId,
          effectivePolicyHash: "e".repeat(64),
          head: checkpoint,
          intent: "Clean a superseded startup claim.",
          policySha256: "f".repeat(64),
          repoRoot: repo,
          runId: domainRunId,
        });
        currentGeneration = resumed.generationToken;
        git(repo, "commit", "--allow-empty", "-m", "current resume");
        currentHead = git(repo, "rev-parse", "HEAD");
        ledger.clearResumeClaim(domainRunId, currentClaim.claimId);
        git(
          repo,
          "update-ref",
          `refs/no-mistakes/recover/${domainRunId}`,
          currentHead,
        );
        await writeFile(
          marker,
          JSON.stringify({
            createdAt: new Date().toISOString(),
            domainRunId,
            gate,
            generationToken: staleClaim.generationToken,
            originWorktree: repo,
            resumeClaimId: staleClaim.claimId,
            runId: orchestrationRunId,
            terminalHandle: "term-dead",
          }),
        );
      } finally {
        ledger.close();
      }

      const originId = `repo::${repo}`;
      await writeFile(
        command,
        `#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "terminal" && args[1] === "show") {
  console.log(JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } }))
  process.exit(1)
} else if (args[0] === "terminal" && args[1] === "list") out({ terminals: [] })
else if (args[0] === "terminal" && args[1] === "close") out({ closed: true })
else if (args[0] === "worktree" && args[1] === "list") {
  const worktrees = [{ id: ${JSON.stringify(originId)}, path: ${JSON.stringify(repo)}, branch: "refs/heads/feature", head: ${JSON.stringify(currentHead)} }]
  if (existsSync(${JSON.stringify(canonicalGate)})) worktrees.push({ id: ${JSON.stringify(gateId)}, path: ${JSON.stringify(canonicalGate)}, branch: ${JSON.stringify(`refs/heads/${branch}`)}, head: ${JSON.stringify(checkpoint)}, parentWorktreeId: ${JSON.stringify(originId)} })
  out({ worktrees })
} else if (args[0] === "worktree" && args[1] === "rm") {
  execFileSync("git", ["worktree", "remove", ${JSON.stringify(canonicalGate)}], { cwd: ${JSON.stringify(repo)} })
  out({ removed: true })
} else {
  console.error(JSON.stringify({ ok: false, error: { code: "unexpected", args } }))
  process.exit(1)
}
`,
      );
      await chmod(command, 0o755);
      process.env.ORCA_CLI_COMMAND = command;

      await main(["prune", "--stranded", "--repo", repo]);

      const reopened = new DomainLedger();
      try {
        assert.equal(reopened.runStatus(domainRunId), "in-progress");
        const lease = reopened.leaseFor(repo, "feature");
        assert.equal(lease?.generation_token, currentGeneration);
        assert.equal(lease?.run_id, domainRunId);
      } finally {
        reopened.close();
      }
      assert.equal(
        git(repo, "rev-parse", `refs/no-mistakes/recover/${domainRunId}`),
        currentHead,
      );
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(canonicalGate), false);
      assert.equal(git(repo, "branch", "--list", branch), "");
    } finally {
      restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
      restoreEnv("ORCA_CLI_COMMAND", previousOrca);
      await rm(temp, { force: true, recursive: true });
    }
  }
});
