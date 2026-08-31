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

function markerPath(repo: string, identity: string): string {
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 32);
  return path.join(repo, ".orca", "no-mistakes", `gate-${digest}.json`);
}

async function deadPid(): Promise<number> {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

async function seed(prefix: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const repo = path.join(temp, "repo");
  const root = path.join(temp, "runs");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await mkdir(root);
  git(repo, "-c", "init.templateDir=", "init", "-b", "feature");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  return { repo: await realpath(repo), root: await realpath(root), temp };
}

async function addConfiguredGate(
  seeded: Awaited<ReturnType<typeof seed>>,
  runId: string,
) {
  const gate = {
    branch: `no-mistakes-gate-${runId}`,
    intentTaskId: "task-intent",
    kind: "configured" as const,
    path: path.join(seeded.root, runId),
    root: seeded.root,
    runId,
  };
  git(seeded.repo, "worktree", "add", "-b", gate.branch, gate.path, "HEAD");
  gate.path = await realpath(gate.path);
  return gate;
}

function setEnv(home: string, orcaCommand: string): () => void {
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousOrca = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  process.env.ORCA_CLI_COMMAND = orcaCommand;
  return () => {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    if (previousOrca === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousOrca;
  };
}

async function refusingOrca(temp: string, calls?: string): Promise<string> {
  const command = path.join(temp, "orca-refuse");
  await writeFile(
    command,
    calls === undefined
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nexit 1\n`,
  );
  await chmod(command, 0o755);
  return command;
}

async function settlingOrca(temp: string): Promise<string> {
  const command = path.join(temp, "orca-settle");
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
  return command;
}

test("cleanup-pending configured gates retain a live coordinator", async () => {
  const seeded = await seed("onm-live-cleanup-pending-");
  const gate = await addConfiguredGate(seeded, "run-live");
  const marker = markerPath(seeded.repo, gate.path);
  const calls = path.join(seeded.temp, "calls");
  const restore = setEnv(
    path.join(seeded.temp, "home"),
    await refusingOrca(seeded.temp, calls),
  );
  try {
    await writeFile(
      marker,
      JSON.stringify({
        cleanupPending: true,
        createdAt: new Date().toISOString(),
        gate,
        originWorktree: seeded.repo,
        pid: process.pid,
        runId: gate.runId,
      }),
    );

    await main(["prune", "--stranded", "--repo", seeded.repo]);

    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(gate.path), true);
    assert.notEqual(git(seeded.repo, "branch", "--list", gate.branch), "");
    assert.equal(existsSync(calls), false);
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("configured cleanup retains a registered worktree without its branch", async () => {
  const seeded = await seed("onm-missing-configured-branch-");
  const gate = await addConfiguredGate(seeded, "run-missing-branch");
  const marker = markerPath(seeded.repo, gate.path);
  const restore = setEnv(
    path.join(seeded.temp, "home"),
    await settlingOrca(seeded.temp),
  );
  try {
    await writeFile(
      marker,
      JSON.stringify({
        cleanupPending: true,
        createdAt: new Date().toISOString(),
        gate,
        originWorktree: seeded.repo,
        pid: await deadPid(),
        runId: gate.runId,
      }),
    );
    git(seeded.repo, "update-ref", "-d", `refs/heads/${gate.branch}`);

    await main(["prune", "--stranded", "--repo", seeded.repo]);

    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(gate.path), true);
    assert.ok(
      git(seeded.repo, "worktree", "list", "--porcelain").includes(gate.path),
    );
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("failed generic runs retry external settlement before cleanup", async () => {
  const seeded = await seed("onm-failed-settlement-retry-");
  const branch = "no-mistakes-gate-failed-retry";
  const gatePath = path.join(seeded.temp, branch);
  git(seeded.repo, "worktree", "add", "-b", branch, gatePath, "HEAD");
  const gate = {
    branch,
    id: `repo::${await realpath(gatePath)}`,
    kind: "orca" as const,
    path: await realpath(gatePath),
  };
  const runId = "run-failed-retry";
  const head = git(seeded.repo, "rev-parse", "HEAD");
  const calls = path.join(seeded.temp, "calls.jsonl");
  const orcaCommand = path.join(seeded.temp, "orca");
  await writeFile(
    orcaCommand,
    `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [
  { id: ${JSON.stringify(`repo::${seeded.repo}`)}, path: ${JSON.stringify(seeded.repo)}, branch: "refs/heads/feature", head: ${JSON.stringify(head)} },
  { id: ${JSON.stringify(gate.id)}, path: ${JSON.stringify(gate.path)}, branch: ${JSON.stringify(`refs/heads/${branch}`)}, head: ${JSON.stringify(head)}, parentWorktreeId: ${JSON.stringify(`repo::${seeded.repo}`)} }
] })
else if (args[0] === "terminal" && args[1] === "list") out({ terminals: [] })
else if (args[0] === "orchestration" && args[1] === "task-list") process.exit(1)
else out({ accepted: true })
`,
  );
  await chmod(orcaCommand, 0o755);
  const restore = setEnv(path.join(seeded.temp, "home"), orcaCommand);
  const marker = markerPath(seeded.repo, gate.id);
  try {
    const ledger = new DomainLedger({ repositoryPath: seeded.repo });
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "retry failed external settlement",
      policySha256: "a".repeat(64),
      repoRoot: seeded.repo,
      runId,
      submissionCommitOid: head,
    });
    assert.equal(ledger.finishRun(runId, "failed", head), true);
    ledger.close();
    git(seeded.repo, "update-ref", `refs/no-mistakes/recover/${runId}`, head);
    await writeFile(
      marker,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate,
        originWorktree: seeded.repo,
        pid: await deadPid(),
        runId,
      }),
    );

    await main(["prune", "--stranded", "--repo", seeded.repo]);

    assert.match(
      await readFile(calls, "utf8"),
      /\["orchestration","task-list"/u,
    );
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(gate.path), true);
    const reopened = new DomainLedger({ repositoryPath: seeded.repo });
    try {
      assert.equal(reopened.runStatus(runId), "failed");
    } finally {
      reopened.close();
    }
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("attached settlement failure retains every gate kind", async () => {
  const source = await readFile(
    new URL("../scripts/orca-no-mistakes.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const retainedOutcome =");
  const end = source.indexOf("} finally {", start);
  assert.ok(start >= 0 && end > start);
  const settlementCatch = source.slice(start, end);
  assert.match(settlementCatch, /error instanceof RunSettlementError/u);
  assert.match(settlementCatch, /retainGate = retainedOutcome !== undefined;/u);
  assert.match(settlementCatch, /retainGate = true;/u);
  assert.match(settlementCatch, /await markGateCleanupPending\(\)/u);
  assert.doesNotMatch(settlementCatch, /gate\.kind === "configured"/u);
});
