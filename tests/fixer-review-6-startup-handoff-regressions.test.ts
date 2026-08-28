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
  installAbortReaping,
  main,
} from "../scripts/orca-no-mistakes.ts";

const RECEIPT = "12345678-1234-4123-8123-123456789abc";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(origin: string, gateId: string): string {
  const digest = createHash("sha256").update(gateId).digest("hex").slice(0, 32);
  return path.join(origin, ".orca", "no-mistakes", `gate-${digest}.json`);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function seedStrandedGate(prefix: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  git(temp, "-c", "init.templateDir=", "init", "-b", "feature", "origin");
  const origin = await realpath(path.join(temp, "origin"));
  git(origin, "config", "user.email", "test@example.com");
  git(origin, "config", "user.name", "Test User");
  git(origin, "config", "commit.gpgsign", "false");
  git(origin, "config", "core.hooksPath", "/dev/null");
  git(origin, "commit", "--allow-empty", "-m", "seed");
  const originHead = git(origin, "rev-parse", "HEAD");
  const gateName = `gate-${path.basename(temp)}`;
  const gatePath = path.join(temp, gateName);
  git(origin, "worktree", "add", "-b", gateName, gatePath);
  const gateHead = git(gatePath, "rev-parse", "HEAD");
  const gateId = `repo::${gatePath}`;
  const originId = `repo::${origin}`;
  const calls = path.join(temp, "calls.jsonl");
  const fakeOrca = path.join(temp, "orca");
  await writeFile(
    fakeOrca,
    `#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") {
  const worktrees = [{ id: ${JSON.stringify(originId)}, path: ${JSON.stringify(origin)}, branch: "refs/heads/feature", head: ${JSON.stringify(originHead)} }]
  if (existsSync(${JSON.stringify(gatePath)})) worktrees.push({ id: ${JSON.stringify(gateId)}, path: ${JSON.stringify(gatePath)}, branch: ${JSON.stringify(`refs/heads/${gateName}`)}, head: ${JSON.stringify(gateHead)}, parentWorktreeId: ${JSON.stringify(originId)} })
  out({ worktrees })
} else if (args[0] === "terminal" && args[1] === "list") {
  out({ terminals: [] })
} else if (args[0] === "terminal" && args[1] === "show") {
  out({ terminal: { connected: true } })
} else if (args[0] === "terminal" && args[1] === "close") {
  out({ closed: true })
} else if (args[0] === "worktree" && args[1] === "rm") {
  execFileSync("git", ["worktree", "remove", "--force", ${JSON.stringify(gatePath)}], { cwd: ${JSON.stringify(origin)} })
  out({ removed: true })
} else {
  out({ ok: true })
}
`,
  );
  await chmod(fakeOrca, 0o755);
  const dead = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(dead.pid !== undefined);
  return {
    calls,
    fakeOrca,
    gate: { branch: gateName, id: gateId, kind: "orca" as const, path: gatePath },
    marker: markerPath(origin, gateId),
    origin,
    pid: dead.pid,
    temp,
  };
}

async function pruneStartupReceipt(
  prefix: string,
  receipt: unknown,
  retained: boolean,
): Promise<void> {
  const seeded = await seedStrandedGate(prefix);
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousOrca = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(seeded.temp, "home");
  process.env.ORCA_CLI_COMMAND = seeded.fakeOrca;
  try {
    await mkdir(path.dirname(seeded.marker), { recursive: true });
    await writeFile(
      seeded.marker,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate: seeded.gate,
        launcherPid: seeded.pid,
        originWorktree: seeded.origin,
        startupReceipt: RECEIPT,
        terminalHandle: "term-idle",
      }),
    );
    if (receipt !== undefined) {
      await writeFile(`${seeded.marker}.startup`, JSON.stringify(receipt));
    }

    await main(["prune", "--stranded", "--repo", seeded.origin]);

    assert.equal(existsSync(seeded.marker), retained);
    assert.equal(existsSync(seeded.gate.path), retained);
    const calls = (await readFile(seeded.calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "worktree" && args[1] === "rm"),
      !retained,
    );
  } finally {
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    restoreEnv("ORCA_CLI_COMMAND", previousOrca);
    await rm(seeded.temp, { force: true, recursive: true });
  }
}

test("startup receipts distinguish idle shells from dispatched coordinators", async () => {
  const source = await readFile(
    new URL("../scripts/orca-no-mistakes.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const coordinatorCommand = `\$\{receiptCommand\} && exec env /u,
  );
  await pruneStartupReceipt("sent-before-receipt", undefined, true);
  await pruneStartupReceipt(
    "live-dispatch",
    { pid: process.pid, token: RECEIPT },
    true,
  );
  const dead = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(dead.pid !== undefined);
  await pruneStartupReceipt(
    "dead-dispatch",
    { pid: dead.pid, token: RECEIPT },
    false,
  );
  await pruneStartupReceipt(
    "receipt-mismatch",
    { pid: dead.pid, token: "different-receipt" },
    true,
  );
  await pruneStartupReceipt("malformed-receipt", RECEIPT, true);

  const origin = await mkdtemp(path.join(tmpdir(), "onm-publish-coordinator-"));
  const gate = {
    branch: "no-mistakes-gate-publish",
    id: `repo::${path.join(origin, "gate")}`,
    kind: "orca" as const,
    path: path.join(origin, "gate"),
  };
  const marker = markerPath(origin, gate.id);
  try {
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(
      marker,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate,
        launcherPid: 1,
        originWorktree: origin,
        startupReceipt: RECEIPT,
        terminalHandle: "term-starting",
      }),
    );
    await writeFile(
      `${marker}.startup`,
      JSON.stringify({ pid: process.pid, token: RECEIPT }),
    );

    await installAbortReaping({ gate, originWorktree: origin, pid: process.pid });

    const published = JSON.parse(await readFile(marker, "utf8")) as {
      launcherPid?: number;
      pid?: number;
      startupReceipt?: string;
    };
    assert.equal(published.pid, process.pid);
    assert.equal(published.launcherPid, undefined);
    assert.equal(published.startupReceipt, undefined);
    assert.equal(existsSync(`${marker}.startup`), false);
  } finally {
    await rm(origin, { force: true, recursive: true });
  }
});
