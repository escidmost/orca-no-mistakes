import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("configured launcher rejects a run owned by another repository", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-launcher-owner-"));
  const repo = path.join(temp, "repo");
  const otherRepo = path.join(temp, "other-repo");
  const root = path.join(temp, "runs");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await mkdir(otherRepo);
  await mkdir(root);
  const canonicalRepo = await realpath(repo);
  const canonicalOtherRepo = await realpath(otherRepo);
  const canonicalRoot = await realpath(root);
  const runId = "run-mismatch";
  const launcherId = "launcher-mismatch";
  const digest = createHash("sha256")
    .update(`configured-launcher:${launcherId}`)
    .digest("hex")
    .slice(0, 32);
  const marker = path.join(
    canonicalRepo,
    ".orca",
    "no-mistakes",
    `gate-${digest}.json`,
  );
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid !== undefined);
  await writeFile(
    marker,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      kind: "configured-launcher",
      launcherId,
      originWorktree: canonicalRepo,
      pid: child.pid,
      root: canonicalRoot,
      runId,
      runObjective: `[no-mistakes-launcher:${launcherId}] intent`,
      terminalHandle: "term-mismatch",
      terminalTitle: `no-mistakes-launcher-${launcherId}`,
    }),
  );
  const calls = path.join(temp, "calls.jsonl");
  const command = path.join(temp, "orca");
  await writeFile(calls, "");
  await writeFile(
    command,
    `#!/usr/bin/env node
import fs from "node:fs"
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n")
process.exit(1)
`,
  );
  await chmod(command, 0o755);
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_CLI_COMMAND = command;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");
  const ledger = new DomainLedger();
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "other repository run",
    policySha256: "policy",
    repoRoot: canonicalOtherRepo,
    runId,
    submissionCommitOid: "commit",
  });
  ledger.close();
  try {
    await main(["prune", "--stranded", "--repo", canonicalRepo]);

    assert.equal(await readFile(calls, "utf8"), "");
    assert.equal(existsSync(marker), true);
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousCommand;
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});
