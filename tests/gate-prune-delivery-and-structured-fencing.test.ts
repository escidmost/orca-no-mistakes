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

test("stranded cleanup retains gate when error text contains consumer_fenced without structured error.code", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-fence-substring-"));
  const repo = path.join(temp, "repo");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  git(repo, "-c", "init.templateDir=", "init", "-b", "feature");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  const canonicalRepo = await realpath(repo);
  const runId = "run-fence-substring";
  const gateName = `no-mistakes-gate-${runId}`;
  const branch = `evs/${gateName}`;
  const gatePath = path.join(temp, gateName);
  git(canonicalRepo, "worktree", "add", "-b", branch, gatePath);
  const canonicalGate = await realpath(gatePath);
  const gateHead = git(canonicalGate, "rev-parse", "HEAD");
  git(canonicalRepo, "worktree", "remove", canonicalGate);
  const gateId = `repo::${canonicalGate}`;
  const calls = path.join(temp, "calls.jsonl");
  const orcaCommand = path.join(temp, "orca");
  await writeFile(
    orcaCommand,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [{
  id: ${JSON.stringify(`repo::${canonicalRepo}`)},
  path: ${JSON.stringify(canonicalRepo)},
  branch: "refs/heads/feature",
  head: ${JSON.stringify(gateHead)}
}] })
else if (args[0] === "orchestration" && args[1] === "task-list") out({ tasks: [{ id: "task-failed", status: "ready" }] })
else if (args[0] === "orchestration" && args[1] === "task-update") {
  console.error("warning: diagnostic mentioning consumer_fenced failure")
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
    branch: "feature",
    intent: "terminal branch cleanup retry",
    policySha256: "f".repeat(64),
    repoRoot: canonicalRepo,
    runId,
    submissionCommitOid: gateHead,
  });
  assert.equal(ledger.finishRun(runId, "failed", gateHead), true);
  ledger.close();
  const marker = markerPath(canonicalRepo, gateId);
  await writeFile(
    marker,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      gate: { branch, id: gateId, kind: "orca", path: canonicalGate },
      originWorktree: canonicalRepo,
      runId,
      terminalHandle: "term-dead",
    }),
  );

  try {
    await main(["prune", "--stranded", "--repo", canonicalRepo]);
    assert.equal(existsSync(marker), true);
    assert.notEqual(git(canonicalRepo, "branch", "--list", branch), "");
  } finally {
    restore();
    await rm(temp, { force: true, recursive: true });
  }
});

test("stranded cleanup clears delivered pending outcome immediately and renders when targeting origin terminal", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-origin-deliver-"));
  const repo = path.join(temp, "repo");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  git(repo, "-c", "init.templateDir=", "init", "-b", "feature");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  const canonicalRepo = await realpath(repo);
  const runId = "run-origin-deliver";
  const gateName = `no-mistakes-gate-${runId}`;
  const branch = `evs/${gateName}`;
  const gatePath = path.join(temp, gateName);
  git(canonicalRepo, "worktree", "add", "-b", branch, gatePath);
  const canonicalGate = await realpath(gatePath);
  const gateHead = git(canonicalGate, "rev-parse", "HEAD");
  git(canonicalRepo, "worktree", "remove", canonicalGate);
  const gateId = `repo::${canonicalGate}`;
  const calls = path.join(temp, "calls.jsonl");
  const orcaCommand = path.join(temp, "orca");
  await writeFile(
    orcaCommand,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [{
  id: ${JSON.stringify(`repo::${canonicalRepo}`)},
  path: ${JSON.stringify(canonicalRepo)},
  branch: "refs/heads/feature",
  head: ${JSON.stringify(gateHead)}
}] })
else if (args[0] === "orchestration" && args[1] === "task-list") out({ tasks: [{ id: "task-failed", status: "ready" }] })
else if (args[0] === "orchestration" && args[1] === "task-update") out({ task: { id: "task-failed", status: "failed" } })
else out({ accepted: true })
`,
  );
  await chmod(orcaCommand, 0o755);
  const restore = setEnv(path.join(temp, "home"), orcaCommand);
  const previousHandle = process.env.ORCA_TERMINAL_HANDLE;
  process.env.ORCA_TERMINAL_HANDLE = "term-origin";

  const ledger = new DomainLedger({ repositoryPath: canonicalRepo });
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "origin deliver test",
    policySha256: "f".repeat(64),
    repoRoot: canonicalRepo,
    runId,
    submissionCommitOid: gateHead,
  });
  assert.equal(ledger.finishRun(runId, "failed", gateHead), true);
  ledger.close();

  const marker = markerPath(canonicalRepo, gateId);
  await writeFile(
    marker,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      gate: { branch, id: gateId, kind: "orca", path: canonicalGate },
      notifyHandle: "term-origin",
      originWorktree: canonicalRepo,
      pendingOutcome: "failed",
      pendingSummary: "No-mistakes failed: rendered locally to origin",
      runId,
      terminalHandle: "term-dead",
    }),
  );

  let renderCount = 0;
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const text = args.map((a) => String(a)).join(" ");
    if (text.includes("No-mistakes failed: rendered locally to origin")) {
      renderCount += 1;
    }
    originalConsoleError(...args);
  };

  try {
    // First prune attempt: without recovery ref, gate is retained, but pending outcome is delivered and cleared durably
    await main(["prune", "--stranded", "--repo", canonicalRepo]);
    assert.equal(renderCount, 1);
    assert.equal(existsSync(marker), true);

    const updatedMarker = JSON.parse(await readFile(marker, "utf8")) as {
      pendingOutcome?: unknown;
      pendingSummary?: unknown;
    };
    assert.equal(updatedMarker.pendingOutcome, undefined);
    assert.equal(updatedMarker.pendingSummary, undefined);

    // Second prune attempt: because pendingOutcome was cleared, it is not re-delivered
    await main(["prune", "--stranded", "--repo", canonicalRepo]);
    assert.equal(renderCount, 1);

    // Now supply recovery ref so gate cleanup completes
    git(canonicalRepo, "update-ref", `refs/no-mistakes/recover/${runId}`, gateHead);
    await main(["prune", "--stranded", "--repo", canonicalRepo]);
    assert.equal(existsSync(marker), false);
    assert.equal(renderCount, 1);
  } finally {
    console.error = originalConsoleError;
    if (previousHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = previousHandle;
    restore();
    await rm(temp, { force: true, recursive: true });
  }
});
