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

import {
  DomainLedger,
  GitShell,
  installAbortReaping,
  main,
  releaseWorker,
  startWorkerWithFallback,
  type OrcaOperations,
  type WorkerResult,
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

async function deadPid(): Promise<number> {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

async function seed(prefix: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const repo = path.join(temp, "repo");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  const origin = path.join(temp, "origin.git");
  git(temp, "-c", "init.templateDir=", "init", "--bare", origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  git(repo, "checkout", "-b", "feature");
  return { repo: await realpath(repo), temp };
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

test("default launcher intent rediscovers and reaps its gate", async () => {
  const seeded = await seed("onm-default-launcher-");
  const home = path.join(seeded.temp, "home");
  const capture = path.join(seeded.temp, "marker.json");
  const state = path.join(seeded.temp, "gate.json");
  const config = path.join(seeded.temp, "config.json");
  const head = git(seeded.repo, "rev-parse", "HEAD");
  const command = path.join(seeded.temp, "orca");
  await writeFile(
    command,
    `#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
const args = process.argv.slice(2)
const origin = ${JSON.stringify(seeded.repo)}
const head = ${JSON.stringify(head)}
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "create") {
  const dir = path.join(origin, ".orca", "no-mistakes")
  const name = fs.readdirSync(dir).find((entry) => entry.startsWith("gate-") && entry.endsWith(".json"))
  fs.copyFileSync(path.join(dir, name), ${JSON.stringify(capture)})
  process.exit(1)
} else if (args[0] === "worktree" && args[1] === "list") {
  const { branch, gate } = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"))
  const worktrees = [{ id: "repo::" + origin, path: origin, branch: "refs/heads/feature", head }]
  if (fs.existsSync(gate)) worktrees.push({ id: "repo::" + gate, path: gate, branch: "refs/heads/" + branch, head, parentWorktreeId: "repo::" + origin })
  out({ worktrees })
} else if (args[0] === "terminal" && args[1] === "list") out({ terminals: [] })
else if (args[0] === "worktree" && args[1] === "rm") { const { gate } = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8")); execFileSync("git", ["-C", origin, "worktree", "remove", gate]); out({ removed: true }) }
else { console.error(JSON.stringify({ error: { code: "unexpected", args } })); process.exit(1) }
`,
  );
  await chmod(command, 0o755);
  const restore = setEnv(home, command);
  const previousConfig = process.env.ORCA_NO_MISTAKES_USER_CONFIG;
  try {
    await writeFile(config, "{}");
    process.env.ORCA_NO_MISTAKES_USER_CONFIG = config;
    await assert.rejects(
      main([
        "run",
        `--repo=${seeded.repo}`,
        "--base=main",
        "--intent=stop before default allocation",
      ]),
    );
    const launcher = JSON.parse(await readFile(capture, "utf8")) as {
      gateBranch: string;
      kind: string;
      launcherId: string;
      originWorktree: string;
    };
    assert.equal(launcher.kind, "orca-launcher");
    assert.equal(launcher.originWorktree, seeded.repo);
    const actualGateBranch = `evs/${launcher.gateBranch}`;
    const gatePath = path.join(seeded.temp, launcher.gateBranch);
    git(
      seeded.repo,
      "worktree",
      "add",
      "-b",
      actualGateBranch,
      gatePath,
    );
    const gate = await realpath(gatePath);
    const marker = markerPath(
      seeded.repo,
      `orca-launcher:${launcher.launcherId}`,
    );
    await writeFile(
      marker,
      JSON.stringify({ ...launcher, createdAt: new Date().toISOString(), pid: await deadPid() }),
    );
    await writeFile(
      state,
      JSON.stringify({ branch: actualGateBranch, gate }),
    );
    await main(["prune", "--stranded", "--repo", seeded.repo]);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(gate), false);
    assert.equal(
      git(seeded.repo, "branch", "--list", actualGateBranch),
      "",
    );
    assert.equal(
      git(
        seeded.repo,
        "rev-parse",
        `refs/no-mistakes/recover/${launcher.launcherId}`,
      ),
      head,
    );
  } finally {
    restore();
    if (previousConfig === undefined)
      delete process.env.ORCA_NO_MISTAKES_USER_CONFIG;
    else process.env.ORCA_NO_MISTAKES_USER_CONFIG = previousConfig;
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("stranded cleanup durably discovers an unrecorded worker", async () => {
  const seeded = await seed("onm-worker-discovery-");
  const home = path.join(seeded.temp, "home");
  const gatePath = path.join(seeded.temp, "gate");
  const workerPath = path.join(seeded.temp, "worker");
  git(seeded.repo, "worktree", "add", "-b", "gate", gatePath);
  git(seeded.repo, "worktree", "add", "-b", "worker", workerPath);
  const gate = await realpath(gatePath);
  const worker = await realpath(workerPath);
  const head = git(seeded.repo, "rev-parse", "HEAD");
  const gateId = `repo::${gate}`;
  const workerId = `repo::${worker}`;
  const runId = "run-worker-discovery";
  const marker = markerPath(seeded.repo, gateId);
  await writeFile(
    marker,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      gate: { branch: "gate", id: gateId, kind: "orca", path: gate },
      originWorktree: seeded.repo,
      pid: await deadPid(),
      runId,
      workerAllocations: ["allocation-missing"],
    }),
  );
  const ledger = new DomainLedger(path.join(home, "ledger.db"));
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "worker discovery",
    policySha256: "policy",
    repoRoot: seeded.repo,
    runId,
    submissionCommitOid: head,
  });
  ledger.acquireLease({ branch: "feature", repoRoot: seeded.repo, runId });
  ledger.close();
  const command = path.join(seeded.temp, "orca");
  await writeFile(
    command,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const origin = ${JSON.stringify(seeded.repo)}
const gate = ${JSON.stringify(gate)}
const worker = ${JSON.stringify(worker)}
const head = ${JSON.stringify(head)}
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [
  { id: "repo::" + origin, path: origin, branch: "refs/heads/feature", head },
  { id: "repo::" + gate, path: gate, branch: "refs/heads/gate", head, parentWorktreeId: "repo::" + origin },
  { id: "repo::" + worker, path: worker, branch: "refs/heads/worker", head, parentWorktreeId: "repo::" + gate }
] })
else if (args[0] === "terminal" && args[1] === "list") out({ terminals: args.includes("path:" + worker) ? [{ connected: true, handle: "term-worker" }] : [] })
else if (args[0] === "terminal" && args[1] === "close") out({ closed: true })
else if (args[0] === "worktree" && args[1] === "rm") { console.error(JSON.stringify({ error: { code: "busy" } })); process.exit(1) }
else { console.error(JSON.stringify({ error: { code: "unexpected", args } })); process.exit(1) }
`,
  );
  await chmod(command, 0o755);
  const restore = setEnv(home, command);
  try {
    await main(["prune", "--stranded", "--repo", seeded.repo]);
    const retained = JSON.parse(await readFile(marker, "utf8")) as {
      workers?: Array<{ dispatchId: string; worktreeId?: string }>;
    };
    assert.equal(retained.workers?.[0]?.worktreeId, workerId);
    const dispatchId = retained.workers?.[0]?.dispatchId;
    assert.ok(dispatchId);
    const suffix = createHash("sha256")
      .update(dispatchId)
      .digest("hex")
      .slice(0, 16);
    assert.equal(
      git(
        seeded.repo,
        "rev-parse",
        `refs/no-mistakes/recover/${runId}-worker-${suffix}`,
      ),
      head,
    );
  } finally {
    restore();
    git(seeded.repo, "worktree", "remove", "--force", workerPath);
    git(seeded.repo, "worktree", "remove", "--force", gatePath);
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("worker release preserves its worktree when shutdown is uncertain", async () => {
  const seeded = await seed("onm-worker-release-");
  const gatePath = path.join(seeded.temp, "gate");
  const workerPath = path.join(seeded.temp, "worker");
  git(seeded.repo, "worktree", "add", "-b", "gate", gatePath);
  git(seeded.repo, "worktree", "add", "-b", "worker", workerPath);
  const gate = await realpath(gatePath);
  const worker = await realpath(workerPath);
  const gateId = `repo::${gate}`;
  const runId = "run-release-preservation";
  const allocated: WorkerResult = {
    dispatchId: "dispatch-release",
    report: { findings: [], summary: "active" },
    taskId: "task-release",
    terminalHandle: "term-release",
    worktreeBranch: "worker",
    worktreeId: `repo::${worker}`,
    worktreePath: worker,
  };
  let removeCalled = false;
  const orca = {
    async finishWorker() {
      throw new Error("terminal close uncertain");
    },
    async removeWorktree() {
      removeCalled = true;
    },
    async startWorker(_taskId: string, _launch: unknown, _fence: unknown, onAllocated: ((worker: WorkerResult) => { ready?: Promise<void> }) | undefined) {
      const registration = onAllocated?.(allocated);
      await registration?.ready;
      return allocated;
    },
  } as unknown as OrcaOperations;
  try {
    await installAbortReaping({
      deliveryGit: new GitShell({ repo: seeded.repo }),
      gate: { branch: "gate", id: gateId, kind: "orca", path: gate },
      git: new GitShell({ repo: gate }),
      originWorktree: seeded.repo,
      pid: process.pid,
      runId,
    });
    const outcome = await startWorkerWithFallback(
      orca,
      async () => allocated.taskId,
      [
        {
          name: "release",
          prompt: "work",
          role: "reviewer",
          stage: "review",
          worktree: "new-child",
        },
      ],
    );
    await assert.rejects(
      releaseWorker(outcome.worker, orca),
      /terminal close uncertain/,
    );
    assert.equal(removeCalled, false);
    assert.equal(existsSync(worker), true);
    const suffix = createHash("sha256")
      .update(allocated.dispatchId)
      .digest("hex")
      .slice(0, 16);
    assert.equal(
      git(
        seeded.repo,
        "rev-parse",
        `refs/no-mistakes/recover/${runId}-worker-${suffix}`,
      ),
      git(worker, "rev-parse", "HEAD"),
    );
    const persisted = JSON.parse(
      await readFile(markerPath(seeded.repo, gateId), "utf8"),
    ) as { workers?: unknown[] };
    assert.equal(persisted.workers?.length, 1);
  } finally {
    await installAbortReaping({ pid: process.pid });
    git(seeded.repo, "worktree", "remove", "--force", workerPath);
    git(seeded.repo, "worktree", "remove", "--force", gatePath);
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("configured cleanup retains an unregistered directory", async () => {
  const seeded = await seed("onm-configured-directory-");
  const home = path.join(seeded.temp, "home");
  const root = path.join(seeded.temp, "configured");
  const runId = "run-unregistered-path";
  const branch = "no-mistakes-gate-unregistered";
  await mkdir(root, { recursive: true });
  const configuredRoot = await realpath(root);
  const gatePath = path.join(configuredRoot, runId);
  await mkdir(gatePath);
  git(seeded.repo, "branch", branch);
  const head = git(seeded.repo, "rev-parse", "HEAD");
  git(seeded.repo, "update-ref", `refs/no-mistakes/recover/${runId}`, head);
  const marker = markerPath(seeded.repo, gatePath);
  await writeFile(
    marker,
    JSON.stringify({
      cleanupPending: true,
      createdAt: new Date().toISOString(),
      gate: {
        branch,
        intentTaskId: "task-configured",
        kind: "configured",
        path: gatePath,
        root: configuredRoot,
        runId,
      },
      originWorktree: seeded.repo,
      pid: await deadPid(),
      runId,
    }),
  );
  const ledger = new DomainLedger(path.join(home, "ledger.db"));
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "configured cleanup",
    policySha256: "policy",
    repoRoot: seeded.repo,
    runId,
    submissionCommitOid: head,
  });
  ledger.acquireLease({ branch: "feature", repoRoot: seeded.repo, runId });
  assert.equal(
    ledger.settleRun(runId, "cancelled", {
      branch: "feature",
      repoRoot: seeded.repo,
    }),
    true,
  );
  ledger.close();
  const command = path.join(seeded.temp, "orca");
  await writeFile(
    command,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [] })
else if (args[0] === "terminal" && args[1] === "list") out({ terminals: [] })
else { console.error(JSON.stringify({ error: { code: "unexpected", args } })); process.exit(1) }
`,
  );
  await chmod(command, 0o755);
  const restore = setEnv(home, command);
  try {
    await main(["prune", "--stranded", "--repo", seeded.repo]);
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(gatePath), true);
    assert.equal(git(seeded.repo, "branch", "--list", branch), branch);
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});
