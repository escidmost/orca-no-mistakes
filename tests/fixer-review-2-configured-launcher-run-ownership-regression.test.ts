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
import { legacyLedgerPath } from "../scripts/ledger.ts";

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
  const ledger = new DomainLedger(legacyLedgerPath());
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

test("configured launcher verifies recorded resource identities", async () => {
  for (const mismatch of ["terminal", "run"] as const) {
    const temp = await mkdtemp(path.join(tmpdir(), `onm-launcher-${mismatch}-`));
    const repo = path.join(temp, "repo");
    const root = path.join(temp, "runs");
    await mkdir(path.join(repo, ".orca", "no-mistakes"), {
      recursive: true,
    });
    await mkdir(root);
    const canonicalRepo = await realpath(repo);
    const canonicalRoot = await realpath(root);
    const launcherId = `launcher-${mismatch}`;
    const runId = `run-${mismatch}`;
    const terminalHandle = `term-${mismatch}`;
    const terminalTitle = `no-mistakes-launcher-${launcherId}`;
    const runObjective = `[no-mistakes-launcher:${launcherId}] intent`;
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
        runObjective,
        terminalHandle,
        terminalTitle,
      }),
    );
    const calls = path.join(temp, "calls.jsonl");
    const command = path.join(temp, "orca");
    await writeFile(calls, "");
    await writeFile(
      command,
      `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
if (args[0] === "terminal" && args[1] === "list") {
  console.log(JSON.stringify({ terminals: [{ handle: ${JSON.stringify(terminalHandle)}, title: ${JSON.stringify(mismatch === "terminal" ? "unrelated" : terminalTitle)} }] }))
  process.exit(0)
}
if (args[0] === "orchestration" && args[1] === "run-list") {
  console.log(JSON.stringify({ runs: [{ id: ${JSON.stringify(runId)}, objective: ${JSON.stringify(mismatch === "run" ? "unrelated" : runObjective)} }] }))
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
    const ledger = new DomainLedger(legacyLedgerPath());
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "same repository run",
      policySha256: "policy",
      repoRoot: canonicalRepo,
      runId,
      submissionCommitOid: "commit",
    });
    ledger.close();
    try {
      await main(["prune", "--stranded", "--repo", canonicalRepo]);

      const recorded = (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(existsSync(marker), true);
      assert.equal(
        recorded.some(
          (args) =>
            args[0] === "orchestration" && args[1] === "task-update",
        ),
        false,
      );
      assert.equal(
        recorded.some(
          (args) => args[0] === "terminal" && args[1] === "close",
        ),
        false,
      );
    } finally {
      if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
      else process.env.ORCA_CLI_COMMAND = previousCommand;
      if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
      else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
      await rm(temp, { force: true, recursive: true });
    }
  }
});
