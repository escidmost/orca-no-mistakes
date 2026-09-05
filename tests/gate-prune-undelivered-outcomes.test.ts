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
  CliOrca,
  DomainLedger,
  GitShell,
  installAbortReaping,
  main,
  reapAbortedRun,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(origin: string, markerId: string): string {
  const digest = createHash("sha256")
    .update(markerId)
    .digest("hex")
    .slice(0, 32);
  return path.join(origin, ".orca", "no-mistakes", `gate-${digest}.json`);
}

async function seedConfigured(prefix: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const origin = path.join(temp, "origin.git");
  const repo = path.join(temp, "repo");
  const root = path.join(temp, "runs");
  git(temp, "-c", "init.templateDir=", "init", "--bare", origin);
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await writeFile(path.join(repo, ".gitignore"), ".orca/no-mistakes/\n");
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "seed");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  git(temp, `--git-dir=${origin}`, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repo, "checkout", "-b", "feature");
  await mkdir(root);
  return { repo: await realpath(repo), root: await realpath(root), temp };
}

async function addGate(
  seeded: Awaited<ReturnType<typeof seedConfigured>>,
  runId: string,
) {
  const gatePath = path.join(seeded.root, runId);
  const branch = `no-mistakes-gate-${runId}`;
  git(
    seeded.repo,
    "worktree",
    "add",
    "-b",
    branch,
    gatePath,
    git(seeded.repo, "rev-parse", "HEAD"),
  );
  return {
    branch,
    intentTaskId: "task-intent",
    kind: "configured" as const,
    path: gatePath,
    root: seeded.root,
    runId,
  };
}

async function seedOrca(prefix: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const origin = path.join(temp, "origin");
  await mkdir(origin);
  git(origin, "-c", "init.templateDir=", "init", "-b", "main");
  git(origin, "config", "user.email", "test@example.com");
  git(origin, "config", "user.name", "Test User");
  git(origin, "commit", "--allow-empty", "-m", "seed");
  const head = git(origin, "rev-parse", "HEAD");
  const gatePath = path.join(temp, "gate");
  git(origin, "worktree", "add", "-b", "gate", gatePath);
  const canonicalOrigin = await realpath(origin);
  const canonicalGate = await realpath(gatePath);
  return {
    gate: {
      branch: "gate",
      id: `repo::${canonicalGate}`,
      kind: "orca" as const,
      path: canonicalGate,
    },
    head,
    origin: canonicalOrigin,
    originId: `repo::${canonicalOrigin}`,
    temp,
  };
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

async function fakeConfiguredOrca(
  temp: string,
  mode: "down" | "up",
): Promise<{ calls: string; command: string }> {
  const calls = path.join(temp, `calls-configured-${mode}.jsonl`);
  const command = path.join(temp, `orca-configured-${mode}`);
  await writeFile(
    command,
    `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
const down = ${JSON.stringify(mode === "down")}
if (args[0] === "orchestration" && args[1] === "send") {
  if (down) {
    console.error("orchestration send unreachable")
    process.exit(1)
  }
  out({ message: { id: "msg-delivered" } })
} else if (args[0] === "terminal" && args[1] === "send") {
  if (down) {
    console.error("terminal send unreachable")
    process.exit(1)
  }
  out({ accepted: true })
} else if (args[0] === "terminal" && args[1] === "show") {
  out({ terminal: { connected: false, handle: "term-configured" } })
} else if (args[0] === "orchestration" && args[1] === "task-list") {
  out({ tasks: [{ id: "task-intent", status: "in_progress" }] })
} else {
  out({ accepted: true })
}
`,
  );
  await chmod(command, 0o755);
  return { calls, command };
}

async function fakeOrcaGate(
  seeded: Awaited<ReturnType<typeof seedOrca>>,
  mode: "down" | "up",
): Promise<{ calls: string; command: string }> {
  const calls = path.join(seeded.temp, `calls-orca-${mode}.jsonl`);
  const command = path.join(seeded.temp, `orca-gate-${mode}`);
  await writeFile(
    command,
    `#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
const down = ${JSON.stringify(mode === "down")}
if (args[0] === "worktree" && args[1] === "list") {
  const worktrees = [{ id: ${JSON.stringify(seeded.originId)}, path: ${JSON.stringify(seeded.origin)}, branch: "refs/heads/main", head: ${JSON.stringify(seeded.head)} }]
  if (fs.existsSync(${JSON.stringify(seeded.gate.path)})) worktrees.push({ id: ${JSON.stringify(seeded.gate.id)}, path: ${JSON.stringify(seeded.gate.path)}, branch: "refs/heads/gate", head: ${JSON.stringify(seeded.head)}, parentWorktreeId: ${JSON.stringify(seeded.originId)} })
  out({ worktrees })
} else if (args[0] === "terminal" && args[1] === "list") {
  out({ terminals: [] })
} else if (args[0] === "orchestration" && args[1] === "send") {
  if (down) {
    console.error("orchestration send unreachable")
    process.exit(1)
  }
  out({ message: { id: "msg-delivered" } })
} else if (args[0] === "terminal" && args[1] === "send") {
  if (down) {
    console.error("terminal send unreachable")
    process.exit(1)
  }
  out({ accepted: true })
} else if (args[0] === "worktree" && args[1] === "rm") {
  execFileSync("git", ["worktree", "remove", "--force", ${JSON.stringify(seeded.gate.path)}], { cwd: ${JSON.stringify(seeded.origin)} })
  out({ removed: true })
} else if (args[0] === "orchestration" && args[1] === "task-list") {
  out({ tasks: [{ id: "task-intent", status: "in_progress" }] })
} else {
  out({ accepted: true })
}
`,
  );
  await chmod(command, 0o755);
  return { calls, command };
}

async function readCalls(calls: string): Promise<string[][]> {
  return (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const GATE_ENV_KEYS = [
  "NO_MISTAKES_DELIVERY_BRANCH",
  "NO_MISTAKES_GATE_BRANCH",
  "NO_MISTAKES_GATE_WORKTREE_ROOT",
  "NO_MISTAKES_ORIGIN_WORKTREE",
  "NO_MISTAKES_RUN_ID",
  "ORCA_CLI_COMMAND",
  "ORCA_NO_MISTAKES_HOME",
  "ORCA_TERMINAL_HANDLE",
] as const;

function snapshotEnv(): Map<string, string | undefined> {
  return new Map(GATE_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreSnapshot(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("failed attached runs persist their undelivered outcome in the gate marker", async () => {
  const seeded = await seedConfigured("onm-undelivered-writer-");
  const gate = await addGate(seeded, "run-undelivered-writer");
  const fake = await fakeConfiguredOrca(seeded.temp, "down");
  await writeFile(path.join(gate.path, "diverge.txt"), "diverge\n");
  git(gate.path, "add", ".");
  git(gate.path, "commit", "-m", "diverge");
  const snapshot = snapshotEnv();
  try {
    process.env.ORCA_CLI_COMMAND = fake.command;
    process.env.ORCA_NO_MISTAKES_HOME = path.join(seeded.temp, "home");
    process.env.ORCA_TERMINAL_HANDLE = "term-configured";
    process.env.NO_MISTAKES_GATE_BRANCH = gate.branch;
    process.env.NO_MISTAKES_ORIGIN_WORKTREE = seeded.repo;
    process.env.NO_MISTAKES_RUN_ID = gate.runId;
    process.env.NO_MISTAKES_GATE_WORKTREE_ROOT = gate.root;
    delete process.env.NO_MISTAKES_DELIVERY_BRANCH;

    await assert.rejects(
      main([
        "run",
        "--attached",
        `--repo=${gate.path}`,
        "--base=main",
        "--intent=Persist the undelivered failed outcome.",
        "--notify",
        "origin-term",
      ]),
      /gate worktree is not based on the initiating checkout/,
    );

    const markerFile = markerPath(seeded.repo, gate.path);
    assert.equal(existsSync(markerFile), true);
    const marker = JSON.parse(await readFile(markerFile, "utf8")) as {
      notifyHandle?: string;
      pendingOutcome?: string;
      pendingSummary?: string;
    };
    assert.equal(marker.pendingOutcome, "failed");
    assert.equal(marker.notifyHandle, "origin-term");
    assert.match(
      marker.pendingSummary ?? "",
      /gate worktree is not based on the initiating checkout/,
    );
  } finally {
    await installAbortReaping({ pid: process.pid });
    restoreSnapshot(snapshot);
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("stranded prune delivers a pending configured-gate outcome before cleanup", async () => {
  const seeded = await seedConfigured("onm-undelivered-configured-");
  const gate = await addGate(seeded, "run-undelivered-configured");
  const down = await fakeConfiguredOrca(seeded.temp, "down");
  const up = await fakeConfiguredOrca(seeded.temp, "up");
  const ledger = new DomainLedger({ repositoryPath: seeded.repo });
  const snapshot = snapshotEnv();
  try {
    process.env.ORCA_NO_MISTAKES_HOME = path.join(seeded.temp, "home");
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "deliver the undelivered cancelled outcome",
      policySha256: "a".repeat(64),
      repoRoot: seeded.repo,
      runId: gate.runId,
      submissionCommitOid: git(seeded.repo, "rev-parse", "HEAD"),
    });
    const generationToken = ledger.acquireLease({
      branch: "feature",
      repoRoot: seeded.repo,
      runId: gate.runId,
    });
    const orca = new CliOrca({
      command: down.command,
      cwd: seeded.repo,
      notifyHandle: "origin-term",
      runId: gate.runId,
    });
    await installAbortReaping({
      deliveryGit: new GitShell({ repo: seeded.repo }),
      gate,
      generationToken,
      git: new GitShell({ repo: gate.path }),
      ledger,
      notify: (summary) => orca.notifyRunResult("cancelled", summary),
      notifyHandle: "origin-term",
      orca,
      orcaCommand: down.command,
      originWorktree: seeded.repo,
      runId: gate.runId,
      terminalHandle: "term-configured",
    });

    await reapAbortedRun("cancel with unreachable origin");

    assert.equal(ledger.runStatus(gate.runId), "cancelled");
    const markerFile = markerPath(seeded.repo, gate.path);
    const marker = JSON.parse(await readFile(markerFile, "utf8")) as {
      notifyHandle?: string;
      pendingOutcome?: string;
      pendingSummary?: string;
    };
    assert.equal(marker.pendingOutcome, "cancelled");
    assert.equal(marker.notifyHandle, "origin-term");
    assert.match(
      marker.pendingSummary ?? "",
      /No-mistakes cancelled: cancel with unreachable origin/,
    );
    assert.equal(existsSync(gate.path), true);
    ledger.close();

    process.env.ORCA_CLI_COMMAND = down.command;
    await main(["prune", "--stranded", "--repo", seeded.repo]);
    assert.equal(existsSync(markerFile), true);
    assert.equal(existsSync(gate.path), true);

    process.env.ORCA_CLI_COMMAND = up.command;
    await main(["prune", "--stranded", "--repo", seeded.repo]);
    assert.equal(existsSync(markerFile), false);
    assert.equal(existsSync(gate.path), false);
    const calls = await readCalls(up.calls);
    const send = calls.find(
      (args) => args[0] === "orchestration" && args[1] === "send",
    );
    assert.ok(send !== undefined);
    assert.equal(flagValue(send, "--to"), "origin-term");
    assert.match(
      flagValue(send, "--body") ?? "",
      /No-mistakes cancelled: cancel with unreachable origin/,
    );
    assert.ok(
      calls.some((args) => args[0] === "terminal" && args[1] === "send"),
    );
  } finally {
    await installAbortReaping({ pid: process.pid });
    restoreSnapshot(snapshot);
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("stranded prune delivers a pending orca-gate outcome before cleanup", async () => {
  const seeded = await seedOrca("onm-undelivered-orca-");
  const down = await fakeOrcaGate(seeded, "down");
  const up = await fakeOrcaGate(seeded, "up");
  const markerFile = markerPath(seeded.origin, seeded.gate.id);
  await mkdir(path.dirname(markerFile), { recursive: true });
  await writeFile(
    markerFile,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      gate: seeded.gate,
      notifyHandle: "origin-term",
      originWorktree: seeded.origin,
      pendingOutcome: "failed",
      pendingSummary: "No-mistakes failed: stranded orca gate",
      pid: deadPid(),
      runId: "run-orca-undelivered",
    }),
  );
  const snapshot = snapshotEnv();
  try {
    process.env.ORCA_NO_MISTAKES_HOME = path.join(seeded.temp, "home");
    process.env.ORCA_CLI_COMMAND = down.command;
    await main(["prune", "--stranded", "--repo", seeded.origin]);
    assert.equal(existsSync(markerFile), true);
    assert.equal(existsSync(seeded.gate.path), true);
    assert.equal(
      (await readCalls(down.calls)).some(
        (args) => args[0] === "worktree" && args[1] === "rm",
      ),
      false,
    );

    process.env.ORCA_CLI_COMMAND = up.command;
    await main(["prune", "--stranded", "--repo", seeded.origin]);
    assert.equal(existsSync(markerFile), false);
    assert.equal(existsSync(seeded.gate.path), false);
    const calls = await readCalls(up.calls);
    const send = calls.find(
      (args) => args[0] === "orchestration" && args[1] === "send",
    );
    assert.ok(send !== undefined);
    assert.equal(flagValue(send, "--to"), "origin-term");
    assert.match(
      flagValue(send, "--body") ?? "",
      /No-mistakes failed: stranded orca gate/,
    );
  } finally {
    restoreSnapshot(snapshot);
    await rm(seeded.temp, { force: true, recursive: true });
  }
});
