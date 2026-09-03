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

const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

test("configured launcher with notifyHandle journals and delivers stranded cancellation", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-launcher-notify-"));
  const repo = path.join(temp, "repo");
  const root = path.join(temp, "runs");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await mkdir(root);
  git(temp, "-c", "init.templateDir=", "init", "-b", "feature", repo);
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, "README.md"), "# Test\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const head = git(repo, "rev-parse", "HEAD");

  const canonicalRepo = await realpath(repo);
  const canonicalRoot = await realpath(root);
  const runId = "run-launcher-notify";
  const launcherId = "launcher-notify";
  const notifyHandle = "term-origin-notify";

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
      allocationProtocol: "gated-v1",
      createdAt: new Date().toISOString(),
      gateAllocated: false,
      kind: "configured-launcher",
      launcherId,
      notifyHandle,
      originWorktree: canonicalRepo,
      pid: child.pid,
      root: canonicalRoot,
      runId,
      runObjective: `[no-mistakes-launcher:${launcherId}] intent`,
      terminalHandle: "term-child",
      terminalTitle: `no-mistakes-launcher-${launcherId}`,
    }),
  );

  const calls = path.join(temp, "calls.jsonl");
  const mockOrca = path.join(temp, "orca");
  await writeFile(calls, "");
  await writeFile(
    mockOrca,
    `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const args = process.argv.slice(2);
if (args[0] === "terminal" && args[1] === "list") {
  console.log(JSON.stringify({ terminals: [] }));
  process.exit(0);
}
if (args[0] === "terminal" && args[1] === "show") {
  console.log(JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } }));
  process.exit(1);
}
if (args[0] === "terminal" && args[1] === "close") {
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "run-list") {
  console.log(JSON.stringify({ runs: [{ id: ${JSON.stringify(runId)}, objective: "[no-mistakes-launcher:" + ${JSON.stringify(launcherId)} + "] intent" }] }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "task-list") {
  console.log(JSON.stringify({ tasks: [{ id: "task-1", status: "in-progress" }] }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "task-update") {
  console.log(JSON.stringify({ task: { id: "task-1", status: "failed" } }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "send") {
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "task-fail") {
  process.exit(0);
}
process.exit(0);
`,
  );
  await chmod(mockOrca, 0o755);

  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_CLI_COMMAND = mockOrca;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");

  const ledger = new DomainLedger({ repositoryPath: canonicalRepo });
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "test launcher notify",
    policySha256: "0".repeat(64),
    repoRoot: canonicalRepo,
    runId,
    submissionCommitOid: head,
  });
  ledger.acquireLease({
    branch: "feature",
    repoRoot: canonicalRepo,
    runId,
  });
  ledger.close();

  try {
    await main(["prune", "--stranded", "--repo", canonicalRepo]);

    const callsText = await readFile(calls, "utf8");
    assert.match(
      callsText,
      /orchestration.*send.*term-origin-notify.*cancelled/u,
    );
    assert.equal(existsSync(marker), false);

    const checkLedger = new DomainLedger({ repositoryPath: canonicalRepo });
    try {
      assert.equal(checkLedger.runStatus(runId), "cancelled");
    } finally {
      checkLedger.close();
    }
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousCommand;
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});

test("configured launcher without notifyHandle cleans up as no-op without notification", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-launcher-nonotify-"));
  const repo = path.join(temp, "repo");
  const root = path.join(temp, "runs");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await mkdir(root);
  git(temp, "-c", "init.templateDir=", "init", "-b", "feature", repo);
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, "README.md"), "# Test\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const head = git(repo, "rev-parse", "HEAD");

  const canonicalRepo = await realpath(repo);
  const canonicalRoot = await realpath(root);
  const runId = "run-launcher-nonotify";
  const launcherId = "launcher-nonotify";

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
      allocationProtocol: "gated-v1",
      createdAt: new Date().toISOString(),
      gateAllocated: false,
      kind: "configured-launcher",
      launcherId,
      originWorktree: canonicalRepo,
      pid: child.pid,
      root: canonicalRoot,
      runId,
      runObjective: `[no-mistakes-launcher:${launcherId}] intent`,
      terminalHandle: "term-child",
      terminalTitle: `no-mistakes-launcher-${launcherId}`,
    }),
  );

  const calls = path.join(temp, "calls.jsonl");
  const mockOrca = path.join(temp, "orca");
  await writeFile(calls, "");
  await writeFile(
    mockOrca,
    `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const args = process.argv.slice(2);
if (args[0] === "terminal" && args[1] === "list") {
  console.log(JSON.stringify({ terminals: [] }));
  process.exit(0);
}
if (args[0] === "terminal" && args[1] === "show") {
  console.log(JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } }));
  process.exit(1);
}
if (args[0] === "terminal" && args[1] === "close") {
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "run-list") {
  console.log(JSON.stringify({ runs: [{ id: ${JSON.stringify(runId)}, objective: "[no-mistakes-launcher:" + ${JSON.stringify(launcherId)} + "] intent" }] }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "task-list") {
  console.log(JSON.stringify({ tasks: [{ id: "task-1", status: "in-progress" }] }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "task-update") {
  console.log(JSON.stringify({ task: { id: "task-1", status: "failed" } }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "send") {
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "task-fail") {
  process.exit(0);
}
process.exit(0);
`,
  );
  await chmod(mockOrca, 0o755);

  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_CLI_COMMAND = mockOrca;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");

  const ledger = new DomainLedger({ repositoryPath: canonicalRepo });
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "test launcher no notify",
    policySha256: "0".repeat(64),
    repoRoot: canonicalRepo,
    runId,
    submissionCommitOid: head,
  });
  ledger.acquireLease({
    branch: "feature",
    repoRoot: canonicalRepo,
    runId,
  });
  ledger.close();

  try {
    await main(["prune", "--stranded", "--repo", canonicalRepo]);

    const callsText = await readFile(calls, "utf8");
    assert.doesNotMatch(callsText, /orchestration.*send/u);
    assert.equal(existsSync(marker), false);

    const checkLedger = new DomainLedger({ repositoryPath: canonicalRepo });
    try {
      assert.equal(checkLedger.runStatus(runId), "cancelled");
    } finally {
      checkLedger.close();
    }
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousCommand;
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});

test("configured launcher with gate forwards notifyHandle to reapConfiguredGate and notifies origin", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-launcher-gate-notify-"));
  const repo = path.join(temp, "repo");
  const root = path.join(temp, "runs");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await mkdir(root);
  git(temp, "-c", "init.templateDir=", "init", "-b", "feature", repo);
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, "README.md"), "# Test\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const head = git(repo, "rev-parse", "HEAD");

  const canonicalRepo = await realpath(repo);
  const canonicalRoot = await realpath(root);
  const runId = "run-launcher-gate-notify";
  const launcherId = "launcher-gate-notify";
  const notifyHandle = "term-origin-gate-notify";
  const gateBranch = "no-mistakes-gate-test-branch";
  const gatePath = path.join(canonicalRoot, runId);

  git(canonicalRepo, "worktree", "add", "-b", gateBranch, gatePath);

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
      allocationProtocol: "gated-v1",
      createdAt: new Date().toISOString(),
      gate: {
        branch: gateBranch,
        intentTaskId: "task-intent",
        kind: "configured",
        path: gatePath,
        root: canonicalRoot,
        runId,
      },
      gateAllocated: true,
      kind: "configured-launcher",
      launcherId,
      notifyHandle,
      originWorktree: canonicalRepo,
      pid: child.pid,
      root: canonicalRoot,
      runId,
      runObjective: `[no-mistakes-launcher:${launcherId}] intent`,
      terminalHandle: "term-child",
      terminalTitle: `no-mistakes-launcher-${launcherId}`,
    }),
  );

  const calls = path.join(temp, "calls.jsonl");
  const mockOrca = path.join(temp, "orca");
  await writeFile(calls, "");
  await writeFile(
    mockOrca,
    `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const args = process.argv.slice(2);
if (args[0] === "terminal" && args[1] === "list") {
  console.log(JSON.stringify({ terminals: [] }));
  process.exit(0);
}
if (args[0] === "terminal" && args[1] === "show") {
  console.log(JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } }));
  process.exit(1);
}
if (args[0] === "terminal" && args[1] === "close") {
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "run-list") {
  console.log(JSON.stringify({ runs: [{ id: ${JSON.stringify(runId)}, objective: "[no-mistakes-launcher:" + ${JSON.stringify(launcherId)} + "] intent" }] }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "task-list") {
  console.log(JSON.stringify({ tasks: [{ id: "task-1", status: "in-progress" }] }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "task-update") {
  console.log(JSON.stringify({ task: { id: "task-1", status: "failed" } }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "send") {
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
process.exit(0);
`,
  );
  await chmod(mockOrca, 0o755);

  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_CLI_COMMAND = mockOrca;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");

  const ledger = new DomainLedger({ repositoryPath: canonicalRepo });
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "test launcher gate notify",
    policySha256: "0".repeat(64),
    repoRoot: canonicalRepo,
    runId,
    submissionCommitOid: head,
  });
  const generationToken = ledger.acquireLease({
    branch: "feature",
    repoRoot: canonicalRepo,
    runId,
  });
  ledger.close();

  try {
    await main(["prune", "--stranded", "--repo", canonicalRepo]);

    const callsText = await readFile(calls, "utf8");
    assert.match(
      callsText,
      /orchestration.*send.*term-origin-gate-notify.*cancelled/u,
    );
    assert.equal(existsSync(marker), false);

    const checkLedger = new DomainLedger({ repositoryPath: canonicalRepo });
    try {
      assert.equal(checkLedger.runStatus(runId), "cancelled");
    } finally {
      checkLedger.close();
    }
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousCommand;
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});
