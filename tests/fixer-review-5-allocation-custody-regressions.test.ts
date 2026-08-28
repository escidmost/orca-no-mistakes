import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

import { PreflightError } from "../scripts/adapters.ts";
import {
  DomainLedger,
  installAbortReaping,
  main,
  startWorkerWithFallback,
  type OrcaOperations,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(origin: string, identity: string): string {
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 32);
  return path.join(origin, ".orca", "no-mistakes", `gate-${digest}.json`);
}

async function seed(prefix: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const repo = path.join(temp, "repo");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  git(repo, "checkout", "-b", "feature");
  return {
    head: git(repo, "rev-parse", "HEAD"),
    repo: await realpath(repo),
    temp,
  };
}

async function configuredGate(
  seeded: Awaited<ReturnType<typeof seed>>,
  runId: string,
) {
  const root = path.join(seeded.temp, "configured");
  await mkdir(root);
  const branch = `no-mistakes-gate-${runId}`;
  const gatePath = path.join(root, runId);
  git(seeded.repo, "worktree", "add", "-b", branch, gatePath);
  return {
    branch,
    intentTaskId: `intent-${runId}`,
    kind: "configured" as const,
    path: await realpath(gatePath),
    root: await realpath(root),
    runId,
  };
}

function setEnv(home: string, orcaCommand?: string): () => void {
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousOrca = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  if (orcaCommand) process.env.ORCA_CLI_COMMAND = orcaCommand;
  return () => {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    if (previousOrca === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousOrca;
  };
}

test("gate removal retains allocation custody", async () => {
  const source = await readFile(
    new URL("../scripts/orca-no-mistakes.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function removeGateWorktree(");
  const end = source.indexOf("const branchRef =", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const boundary = source.slice(start, end);
  assert.match(boundary, /"workerAllocations" in marker/);
  assert.match(boundary, /!Array\.isArray\(marker\.workerAllocations\)/);
  assert.match(boundary, /marker\.workerAllocations\.length > 0/);
  assert.match(boundary, /"workerAllocationPids" in marker/);
  assert.match(boundary, /Object\.keys\(marker\.workerAllocationPids\)\.length > 0/);
});

test("malformed worker receipts retain allocation custody", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-worker-allocation-receipt-"));
  const origin = path.join(temp, "origin");
  await mkdir(path.join(origin, ".orca", "no-mistakes"), { recursive: true });
  const gate = {
    branch: "gate-allocation-receipt",
    id: `repo::${path.join(temp, "gate")}`,
    kind: "orca" as const,
    path: path.join(temp, "gate"),
  };
  const orca = {
    async completeTask() {},
    async startWorker() {
      throw new PreflightError("unclassified", "terminal create returned an invalid receipt");
    },
  } as unknown as OrcaOperations;
  try {
    await installAbortReaping({ gate, orca, originWorktree: origin, pid: process.pid });
    await assert.rejects(
      startWorkerWithFallback(orca, async () => "task", [
        {
          commitOid: "a".repeat(40),
          name: "allocation-receipt",
          prompt: "work",
          role: "reviewer",
          stage: "review",
          worktree: "new-child",
        },
      ]),
      /invalid receipt/,
    );
    const marker = JSON.parse(
      await readFile(markerPath(origin, gate.id), "utf8"),
    ) as { workerAllocations?: string[] };
    assert.equal(marker.workerAllocations?.length, 1);
  } finally {
    await installAbortReaping({ pid: process.pid });
    await rm(temp, { force: true, recursive: true });
  }
});

test("allocation discovery refreshes snapshots after PID quiescence", async () => {
  const seeded = await seed("onm-allocation-snapshot-");
  const gate = await configuredGate(seeded, "run-allocation-snapshot");
  const home = path.join(seeded.temp, "home");
  const command = path.join(seeded.temp, "orca");
  const calls = path.join(seeded.temp, "worktree-list-count");
  const workerPath = path.join(seeded.temp, "late-worker");
  const marker = markerPath(seeded.repo, gate.path);
  await mkdir(home, { recursive: true });
  await writeFile(
    marker,
    JSON.stringify({
      allocationProtocol: "gated-v1",
      createdAt: new Date().toISOString(),
      gate,
      originWorktree: seeded.repo,
      pid: 2_147_483_647,
      runId: gate.runId,
      workerAllocationPids: { pending: [2_147_483_647] },
      workerAllocations: ["pending"],
    }),
  );
  const ledger = new DomainLedger(path.join(home, "ledger.db"));
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "refresh post-quiescence discovery",
    policySha256: "f".repeat(64),
    repoRoot: seeded.repo,
    runId: gate.runId,
    submissionCommitOid: seeded.head,
  });
  ledger.finishRun(gate.runId, "passed", seeded.head);
  ledger.close();
  await writeFile(
    command,
    `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") {
  let count = 0
  try { count = Number(fs.readFileSync(${JSON.stringify(calls)}, "utf8")) } catch {}
  count += 1
  fs.writeFileSync(${JSON.stringify(calls)}, String(count))
  out({ worktrees: count === 1 ? [] : [{
    branch: "refs/heads/late-worker",
    head: "not-a-commit",
    id: "repo::" + ${JSON.stringify(workerPath)},
    parentWorktreeId: "repo::" + ${JSON.stringify(gate.path)},
    path: ${JSON.stringify(workerPath)}
  }] })
} else if (args[0] === "terminal" && args[1] === "list") out({ terminals: [] })
else { console.error(JSON.stringify({ error: { code: "unexpected", args } })); process.exit(1) }
`,
  );
  await chmod(command, 0o755);
  const restore = setEnv(home, command);
  try {
    await main(["prune", "--stranded", "--repo", seeded.repo]);

    assert.equal(await readFile(calls, "utf8"), "2");
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(gate.path), true);
    assert.equal(
      git(seeded.repo, "rev-parse", `refs/heads/${gate.branch}`),
      seeded.head,
    );
  } finally {
    restore();
    if (existsSync(gate.path))
      git(seeded.repo, "worktree", "remove", "--force", gate.path);
    await rm(seeded.temp, { force: true, recursive: true });
  }
});
