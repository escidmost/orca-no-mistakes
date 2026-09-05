import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
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

function markerPath(repo: string, runId: string): string {
  const digest = createHash("sha256")
    .update(`direct-run:${runId}`)
    .digest("hex")
    .slice(0, 32);
  return path.join(repo, ".orca", "no-mistakes", `gate-${digest}.json`);
}

async function seed(status: "failed" | "passed") {
  const temp = await mkdtemp(path.join(tmpdir(), `onm-direct-${status}-`));
  const repoPath = path.join(temp, "repo");
  await mkdir(path.join(repoPath, ".orca", "no-mistakes"), { recursive: true });
  git(repoPath, "-c", "init.templateDir=", "init", "-b", "feature");
  git(repoPath, "config", "user.email", "test@example.com");
  git(repoPath, "config", "user.name", "Test User");
  git(repoPath, "commit", "--allow-empty", "-m", "seed");
  const repo = await realpath(repoPath);
  const headOid = git(repo, "rev-parse", "HEAD");
  const runId = `run-direct-${status}`;
  const calls = path.join(temp, "calls.jsonl");
  const orcaCommand = path.join(temp, "orca");
  await writeFile(
    orcaCommand,
    `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [{
  id: ${JSON.stringify(`repo::${repo}`)},
  path: ${JSON.stringify(repo)},
  branch: "refs/heads/feature",
  head: ${JSON.stringify(headOid)}
}] })
else if (args[0] === "orchestration" && args[1] === "task-list") out({ tasks: [{ id: "task-open", status: "in_progress" }] })
else if (args[0] === "orchestration" && args[1] === "task-update") out({ task: { id: "task-open", status: "failed" } })
else process.exitCode = 1
`,
  );
  await chmod(orcaCommand, 0o755);

  const ledger = new DomainLedger({ repositoryPath: repo });
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "settled direct force stop",
    policySha256: "f".repeat(64),
    repoRoot: repo,
    runId,
    submissionCommitOid: headOid,
  });
  const generationToken = ledger.acquireLease({
    branch: "feature",
    repoRoot: repo,
    runId,
  });
  assert.equal(ledger.finishRun(runId, status, headOid), true);
  ledger.releaseLease(runId);
  ledger.close();
  git(repo, "update-ref", `refs/no-mistakes/recover/${runId}`, headOid);

  const dead = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(dead.pid !== undefined);
  const marker = markerPath(repo, runId);
  await writeFile(
    marker,
    JSON.stringify({
      cancellationAction: "force-stop",
      cleanupPending: true,
      createdAt: new Date().toISOString(),
      generationToken,
      headOid,
      kind: "direct-run",
      originWorktree: repo,
      pid: dead.pid,
      runId,
    }),
  );
  return { calls, headOid, marker, orcaCommand, repo, runId, status, temp };
}

for (const status of ["failed", "passed"] as const) {
  test(`prune converges a direct force-stop marker after the run ${status}`, async () => {
    const seeded = await seed(status);
    const previousCommand = process.env.ORCA_CLI_COMMAND;
    process.env.ORCA_CLI_COMMAND = seeded.orcaCommand;
    try {
      await main(["prune", "--stranded", "--repo", seeded.repo]);

      const ledger = new DomainLedger({ repositoryPath: seeded.repo });
      try {
        assert.equal(ledger.runStatus(seeded.runId), status);
      } finally {
        ledger.close();
      }
      assert.equal(existsSync(seeded.marker), false);
      assert.equal(
        git(
          seeded.repo,
          "rev-parse",
          `refs/no-mistakes/recover/${seeded.runId}`,
        ),
        seeded.headOid,
      );
      const calls = (await readFile(seeded.calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.ok(
        calls.some(
          (args) =>
            args[0] === "orchestration" && args[1] === "task-update",
        ),
      );
    } finally {
      if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
      else process.env.ORCA_CLI_COMMAND = previousCommand;
      await rm(seeded.temp, { force: true, recursive: true });
    }
  });
}
