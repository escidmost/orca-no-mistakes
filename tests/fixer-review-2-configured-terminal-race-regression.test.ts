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

import { main } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(origin: string, gatePath: string): string {
  const digest = createHash("sha256")
    .update(gatePath)
    .digest("hex")
    .slice(0, 32);
  return path.join(origin, ".orca", "no-mistakes", `gate-${digest}.json`);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("configured cleanup retains a terminal attached after coordinator death", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-configured-terminal-race-"));
  const repo = path.join(temp, "repo");
  const root = path.join(temp, "runs");
  const orcaCommand = path.join(temp, "orca");
  const callsFile = path.join(temp, "calls.jsonl");
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  try {
    await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
    await mkdir(root);
    git(repo, "-c", "init.templateDir=", "init", "-b", "feature");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "commit", "--allow-empty", "-m", "seed");
    const runId = "run-terminal-race";
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
    const origin = await realpath(repo);
    const marker = markerPath(origin, gate.path);
    const deadCoordinator = spawnSync(process.execPath, ["-e", ""]);
    assert.ok(deadCoordinator.pid !== undefined);
    await writeFile(
      marker,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate,
        originWorktree: origin,
        pid: deadCoordinator.pid,
        runId,
      }),
    );
    await writeFile(
      orcaCommand,
      `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "orchestration" && args[1] === "task-list") {
  out({ tasks: [{ id: "task-intent", status: "in_progress" }] })
} else if (args[0] === "worktree" && args[1] === "rm") {
  console.log(JSON.stringify({ ok: false, error: { code: "terminals_connected" } }))
  process.exit(1)
} else {
  out({ accepted: true })
}
`,
    );
    await chmod(orcaCommand, 0o755);
    process.env.ORCA_CLI_COMMAND = orcaCommand;
    process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");

    await main(["prune", "--stranded", "--repo", origin]);

    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(gate.path), true);
    assert.notEqual(git(origin, "branch", "--list", gate.branch), "");
    const calls = (await readFile(callsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(
      calls.filter((args) => args[0] === "worktree" && args[1] === "rm"),
      [["worktree", "rm", "--worktree", `path:${gate.path}`, "--json"]],
    );
  } finally {
    restoreEnv("ORCA_CLI_COMMAND", previousCommand);
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    await rm(temp, { force: true, recursive: true });
  }
});
