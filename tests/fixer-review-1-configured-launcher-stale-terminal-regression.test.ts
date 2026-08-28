import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

import { main } from "../scripts/orca-no-mistakes.ts";

test("configured launcher reaps an explicitly stale recorded terminal", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-launcher-stale-terminal-"));
  const repo = path.join(temp, "repo");
  const root = path.join(temp, "runs");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await mkdir(root);
  const canonicalRepo = await realpath(repo);
  const canonicalRoot = await realpath(root);
  const launcherId = "launcher-stale-terminal";
  const terminalHandle = "term-stale";
  const marker = path.join(
    canonicalRepo,
    ".orca",
    "no-mistakes",
    `gate-${createHash("sha256")
      .update(`configured-launcher:${launcherId}`)
      .digest("hex")
      .slice(0, 32)}.json`,
  );
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid !== undefined);
  await writeFile(
    marker,
    JSON.stringify({
      allocationProtocol: "gated-v1",
      createdAt: new Date().toISOString(),
      kind: "configured-launcher",
      launcherId,
      originWorktree: canonicalRepo,
      pid: child.pid,
      root: canonicalRoot,
      runObjective: `[no-mistakes-launcher:${launcherId}] intent`,
      terminalHandle,
      terminalTitle: `no-mistakes-launcher-${launcherId}`,
    }),
  );
  const command = path.join(temp, "orca");
  await writeFile(
    command,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === "terminal" && args[1] === "list") {
  console.log(JSON.stringify({ terminals: [] }))
  process.exit(0)
}
if (args[0] === "terminal" && args[1] === "show") {
  console.log(JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } }))
  process.exit(1)
}
if (args[0] === "orchestration" && args[1] === "run-list") {
  console.log(JSON.stringify({ runs: [] }))
  process.exit(0)
}
process.exit(1)
`,
  );
  await chmod(command, 0o755);
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_CLI_COMMAND = command;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");
  try {
    await main(["prune", "--stranded", "--repo", canonicalRepo]);

    assert.equal(existsSync(marker), false);
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousCommand;
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});
