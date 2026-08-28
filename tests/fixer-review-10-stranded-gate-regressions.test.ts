import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installAbortReaping,
  main,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(origin: string, gateId: string): string {
  const digest = createHash("sha256").update(gateId).digest("hex").slice(0, 32);
  return path.join(origin, ".orca", "no-mistakes", `gate-${digest}.json`);
}

async function seedGate(prefix: string, deep = false) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const origin = path.join(temp, "origin");
  await mkdir(origin);
  git(origin, "-c", "init.templateDir=", "init", "-b", "main");
  git(origin, "config", "user.email", "test@example.com");
  git(origin, "config", "user.name", "Test User");
  git(origin, "commit", "--allow-empty", "-m", "seed");
  const head = git(origin, "rev-parse", "HEAD");
  const gatePath = deep
    ? path.join(temp, "a".repeat(120), "b".repeat(120), "gate")
    : path.join(temp, "gate");
  await mkdir(path.dirname(gatePath), { recursive: true });
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

async function deadPid(): Promise<number> {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

async function writeMarker(
  seeded: Awaited<ReturnType<typeof seedGate>>,
): Promise<string> {
  const marker = markerPath(seeded.origin, seeded.gate.id);
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(
    marker,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      gate: seeded.gate,
      originWorktree: seeded.origin,
      pid: await deadPid(),
    }),
  );
  return marker;
}

async function fakeOrca(
  seeded: Awaited<ReturnType<typeof seedGate>>,
  mode: "attach" | "refuse" | "remove" | "retain",
): Promise<{ calls: string; command: string }> {
  const command = path.join(seeded.temp, "orca");
  const calls = path.join(seeded.temp, "orca-calls.log");
  const terminalCount = path.join(seeded.temp, "terminal-count");
  await writeFile(
    command,
    `#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") {
  const worktrees = [{ id: ${JSON.stringify(seeded.originId)}, path: ${JSON.stringify(seeded.origin)}, branch: "refs/heads/main", head: ${JSON.stringify(seeded.head)} }]
  if (existsSync(${JSON.stringify(seeded.gate.path)})) worktrees.push({ id: ${JSON.stringify(seeded.gate.id)}, path: ${JSON.stringify(seeded.gate.path)}, branch: "refs/heads/gate", head: ${JSON.stringify(seeded.head)}, parentWorktreeId: ${JSON.stringify(seeded.originId)} })
  out({ worktrees })
} else if (args[0] === "terminal" && args[1] === "list") {
  const count = existsSync(${JSON.stringify(terminalCount)}) ? Number(readFileSync(${JSON.stringify(terminalCount)}, "utf8")) : 0
  writeFileSync(${JSON.stringify(terminalCount)}, String(count + 1))
  out({ terminals: ${JSON.stringify(mode)} === "attach" && count > 0 ? [{ handle: "term-new", connected: true }] : [] })
} else if (args[0] === "worktree" && args[1] === "rm" && ${JSON.stringify(mode)} === "refuse") {
  console.error(JSON.stringify({ ok: false, error: { code: "terminals_connected" } }))
  process.exit(1)
} else if (args[0] === "worktree" && args[1] === "rm" && ${JSON.stringify(mode)} === "remove") {
  execFileSync("git", ["worktree", "remove", "--force", ${JSON.stringify(seeded.gate.path)}], { cwd: ${JSON.stringify(seeded.origin)} })
  out({ removed: true })
} else {
  console.error(JSON.stringify({ ok: false, error: { code: "unexpected" } }))
  process.exit(1)
}
`,
  );
  await chmod(command, 0o755);
  return { calls, command };
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

test("stranded prune retains a gate when a terminal attaches before removal", async () => {
  const seeded = await seedGate("onm-terminal-reprobe-");
  const marker = await writeMarker(seeded);
  const fake = await fakeOrca(seeded, "attach");
  const restore = setEnv(path.join(seeded.temp, "home"), fake.command);
  try {
    await main(["prune", "--stranded", "--repo", seeded.origin]);

    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(seeded.gate.path), true);
    assert.notEqual(git(seeded.origin, "branch", "--list", "gate"), "");
    const calls = (await readFile(fake.calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.filter((args) => args[0] === "terminal" && args[1] === "list").length,
      2,
    );
    assert.equal(
      calls.some((args) => args[0] === "worktree" && args[1] === "rm"),
      false,
    );
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("deep gate paths write and scan fixed-length marker names", async () => {
  const seeded = await seedGate("onm-deep-marker-", true);
  const fake = await fakeOrca(seeded, "retain");
  const restore = setEnv(path.join(seeded.temp, "home"), fake.command);
  try {
    assert.ok(encodeURIComponent(seeded.gate.id).length > 255);
    await installAbortReaping({
      gate: seeded.gate,
      originWorktree: seeded.origin,
      pid: process.pid,
    });
    const names = await readdir(path.join(seeded.origin, ".orca", "no-mistakes"));
    assert.deepEqual(names, [path.basename(markerPath(seeded.origin, seeded.gate.id))]);
    assert.match(names[0]!, /^gate-[0-9a-f]{32}\.json$/u);

    await main(["prune", "--stranded", "--repo", seeded.origin]);

    assert.equal(existsSync(markerPath(seeded.origin, seeded.gate.id)), true);
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("stranded prune removes without --force and retains when Orca refuses", async () => {
  const seeded = await seedGate("onm-graceful-rm-");
  const marker = await writeMarker(seeded);
  const fake = await fakeOrca(seeded, "refuse");
  const restore = setEnv(path.join(seeded.temp, "home"), fake.command);
  try {
    await main(["prune", "--stranded", "--repo", seeded.origin]);

    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(seeded.gate.path), true);
    assert.notEqual(git(seeded.origin, "branch", "--list", "gate"), "");
    const removals = (await readFile(fake.calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args[0] === "worktree" && args[1] === "rm");
    assert.equal(removals.length, 1);
    assert.equal(removals[0]!.includes("--force"), false);
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test(
  "stranded prune retries a marker after gate resources are gone",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
  const seeded = await seedGate("onm-marker-retry-");
  const marker = await writeMarker(seeded);
  const fake = await fakeOrca(seeded, "remove");
  const restore = setEnv(path.join(seeded.temp, "home"), fake.command);
  const markerDirectory = path.dirname(marker);
  try {
    await chmod(markerDirectory, 0o555);
    await main(["prune", "--stranded", "--repo", seeded.origin]);

    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(seeded.gate.path), false);
    assert.equal(git(seeded.origin, "branch", "--list", "gate"), "");

    await chmod(markerDirectory, 0o755);
    await main(["prune", "--stranded", "--repo", seeded.origin]);

    assert.equal(existsSync(marker), false);
  } finally {
    await chmod(markerDirectory, 0o755).catch(() => {});
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
  },
);
