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

import {
  DomainLedger,
  main,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(repo: string, gateId: string): string {
  const digest = createHash("sha256")
    .update(gateId)
    .digest("hex")
    .slice(0, 32);
  return path.join(repo, ".orca", "no-mistakes", `gate-${digest}.json`);
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

test("stranded cleanup reaps a configured gate when Orca settlement is consumer-fenced", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-configured-fence-"));
  const repo = path.join(temp, "repo");
  const runs = path.join(temp, "runs");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await mkdir(runs, { recursive: true });
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  const canonicalRepo = await realpath(repo);
  const canonicalRuns = await realpath(runs);
  const runId = "run-configured-fence";
  const branch = `no-mistakes-gate-${runId}`;
  const gatePath = path.join(canonicalRuns, runId);
  git(canonicalRepo, "worktree", "add", "-b", branch, gatePath);
  const gateHead = git(gatePath, "rev-parse", "HEAD");
  git(canonicalRepo, "worktree", "remove", gatePath);

  const orcaCommand = path.join(temp, "orca");
  await writeFile(
    orcaCommand,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "terminal" && args[1] === "show") {
  console.error("terminal dead")
  process.exit(1)
}
else if (args[0] === "orchestration" && args[1] === "task-list") out({ tasks: [{ id: "task-failed", status: "ready" }] })
else if (args[0] === "orchestration" && args[1] === "task-update") {
  console.error(JSON.stringify({ ok: false, error: { code: "consumer_fenced" } }))
  process.exit(1)
}
else out({ accepted: true })
`,
  );
  await chmod(orcaCommand, 0o755);
  const restore = setEnv(path.join(temp, "home"), orcaCommand);

  const ledger = new DomainLedger({ repositoryPath: canonicalRepo });
  ledger.startRun({
    baseBranch: "main",
    branch: "main",
    intent: "configured fence test",
    policySha256: "f".repeat(64),
    repoRoot: canonicalRepo,
    runId,
    submissionCommitOid: gateHead,
  });
  assert.equal(ledger.finishRun(runId, "failed", gateHead), true);
  ledger.close();

  const marker = markerPath(canonicalRepo, gatePath);
  await writeFile(
    marker,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      gate: {
        branch,
        intentTaskId: "task-intent",
        kind: "configured",
        path: gatePath,
        root: canonicalRuns,
        runId,
      },
      originWorktree: canonicalRepo,
      pid: 99999999,
      runId,
      terminalHandle: "term-dead",
    }),
  );

  try {
    await main(["prune", "--stranded", "--repo", canonicalRepo]);
    assert.equal(existsSync(marker), false);
    assert.equal(git(canonicalRepo, "branch", "--list", branch), "");
  } finally {
    restore();
    await rm(temp, { force: true, recursive: true });
  }
});

test("stranded cleanup retains a configured launcher when Orca settlement is consumer-fenced", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-launcher-fence-"));
  const repo = path.join(temp, "repo");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  const canonicalRepo = await realpath(repo);
  const runId = "run-launcher-fence";
  const launcherId = "launcher-test-123";

  const calls = path.join(temp, "calls.jsonl");
  await writeFile(calls, "");
  const orcaCommand = path.join(temp, "orca");
  await writeFile(
    orcaCommand,
    `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
if (args[0] === "terminal" && args[1] === "list") {
  console.log(JSON.stringify({ terminals: [{ handle: "term-dead", title: "no-mistakes-launcher-" + ${JSON.stringify(launcherId)} }] }))
  process.exit(0)
}
if (args[0] === "terminal" && args[1] === "close") {
  console.log(JSON.stringify({ accepted: true }))
  process.exit(0)
}
if (args[0] === "orchestration" && args[1] === "run-list") {
  console.log(JSON.stringify({ runs: [{ id: ${JSON.stringify(runId)}, objective: "[no-mistakes-launcher:" + ${JSON.stringify(launcherId)} + "] launcher fence test" }] }))
  process.exit(0)
}
if (args[0] === "orchestration" && args[1] === "task-list") {
  console.log(JSON.stringify({ result: { tasks: [{ id: "task-failed", status: "ready" }] } }))
  process.exit(0)
}
if (args[0] === "orchestration" && args[1] === "task-update") {
  console.error(JSON.stringify({ ok: false, error: { code: "consumer_fenced" } }))
  process.exit(1)
}
console.log(JSON.stringify({ accepted: true }))
`,
  );
  await chmod(orcaCommand, 0o755);
  const restore = setEnv(path.join(temp, "home"), orcaCommand);

  const ledger = new DomainLedger({ repositoryPath: canonicalRepo });
  ledger.startRun({
    baseBranch: "main",
    branch: "main",
    intent: "launcher fence test",
    policySha256: "f".repeat(64),
    repoRoot: canonicalRepo,
    runId,
    submissionCommitOid: git(canonicalRepo, "rev-parse", "HEAD"),
  });
  const generationToken = ledger.acquireLease({
    branch: "main",
    repoRoot: canonicalRepo,
    runId,
  });
  ledger.close();

  const marker = markerPath(canonicalRepo, `configured-launcher:${launcherId}`);
  await writeFile(
    marker,
    JSON.stringify({
      allocationProtocol: "gated-v1",
      createdAt: new Date().toISOString(),
      gateAllocated: false,
      kind: "configured-launcher",
      launcherId,
      originWorktree: canonicalRepo,
      pid: 99999999,
      root: canonicalRepo,
      runId,
      runObjective: `[no-mistakes-launcher:${launcherId}] launcher fence test`,
      terminalHandle: "term-dead",
      terminalTitle: `no-mistakes-launcher-${launcherId}`,
    }),
  );

  try {
    await main(["prune", "--stranded", "--repo", canonicalRepo]);
    assert.equal(existsSync(marker), true);
    const reopened = new DomainLedger({ repositoryPath: canonicalRepo });
    try {
      assert.equal(reopened.runStatus(runId), "in-progress");
      assert.equal(
        reopened.leaseFor(canonicalRepo, "main")?.generation_token,
        generationToken,
      );
    } finally {
      reopened.close();
    }
  } finally {
    restore();
    await rm(temp, { force: true, recursive: true });
  }
});

test("unreadable marker is retained and not reaped by stranded prune", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-ineligible-marker-"));
  const repo = path.join(temp, "repo");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  const canonicalRepo = await realpath(repo);
  const marker = path.join(canonicalRepo, ".orca", "no-mistakes", "gate-corrupted.json");
  await writeFile(marker, "{\n--incomplete-outcome-journal--\n");

  try {
    await main(["prune", "--stranded", "--repo", canonicalRepo]);
    assert.equal(existsSync(marker), true);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});
