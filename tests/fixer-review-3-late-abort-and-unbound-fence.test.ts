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
  DomainLedger,
  installAbortReaping,
  main,
  reapAbortedRun,
} from "../scripts/orca-no-mistakes.ts";

const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

test("reapAbortedRun preserves and delivers pending passed outcome on already settled run", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-late-abort-"));
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
  const runId = "run-late-abort-settled";
  const gatePath = path.join(canonicalRoot, runId);
  git(canonicalRepo, "worktree", "add", "-b", "gate-branch", gatePath);

  const ledger = new DomainLedger({ repositoryPath: canonicalRepo });
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "test late abort",
    policySha256: "0".repeat(64),
    repoRoot: canonicalRepo,
    runId,
    submissionCommitOid: head,
  });
  ledger.finishRun(runId, "passed", head);

  const notifications: Array<{ outcome?: string; summary: string }> = [];
  const gate = {
    branch: "gate-branch",
    id: `configured::${gatePath}`,
    intentTaskId: "task-1",
    kind: "configured" as const,
    path: gatePath,
    root: canonicalRoot,
    runId,
  };

  const gitOperations = {
    anchorRecoveryRef: async () => {},
    applyWorktreeCommits: async () => true,
    assertClean: async () => {},
    assertFixerChangesAllowed: async () => {},
    assertReady: async () => ({
      base: "main",
      baseOid: head,
      branch: "feature",
      head,
      root: canonicalRepo,
    }),
    diffBase: async () => "",
    head: async () => head,
    headOf: async () => head,
    pathExists: async () => false,
    policySha256: async () => "0".repeat(64),
    rebase: async () => ({ findings: [], summary: "rebased" }),
    resolveBaseOid: async () => head,
    resolveRefSha: async () => head,
    restoreTrackedFile: async () => {},
    stageAndCommit: async () => head,
  };

  await installAbortReaping({
    deliveryGit: gitOperations,
    gate,
    git: gitOperations,
    ledger,
    notify: async (summary, outcome) => {
      notifications.push({ outcome, summary });
    },
    notifyHandle: "term-origin",
    originWorktree: canonicalRepo,
    pendingOutcome: "passed",
    pendingSummary: "Run passed all stages.",
    pid: process.pid,
    runId,
  });

  const markerFile = path.join(
    canonicalRepo,
    ".orca",
    "no-mistakes",
    `gate-${createHash("sha256").update(gate.path).digest("hex").slice(0, 32)}.json`,
  );
  await writeFile(
    markerFile,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      gate,
      kind: "gate",
      notifyHandle: "term-origin",
      originWorktree: canonicalRepo,
      pendingOutcome: "passed",
      pendingSummary: "Run passed all stages.",
      pid: process.pid,
      runId,
    }),
  );

  try {
    await reapAbortedRun("operator interrupt");

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.outcome, "passed");
    assert.equal(notifications[0]?.summary, "Run passed all stages.");
  } finally {
    ledger.close();
    await rm(temp, { force: true, recursive: true });
  }
});

test("configured launcher with absent domain row retains on consumer_fenced error", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-unbound-fenced-"));
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

  const canonicalRepo = await realpath(repo);
  const canonicalRoot = await realpath(root);
  const runId = "run-unbound-fenced";
  const launcherId = "launcher-unbound-fenced";

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
if (args[0] === "orchestration" && args[1] === "run-list") {
  console.log(JSON.stringify({ runs: [{ id: ${JSON.stringify(runId)}, objective: "[no-mistakes-launcher:" + ${JSON.stringify(launcherId)} + "] intent" }] }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "task-list") {
  console.log(JSON.stringify({ tasks: [{ id: "task-1", status: "in-progress" }] }));
  process.exit(0);
}
if (args[0] === "orchestration" && args[1] === "task-update") {
  console.log(JSON.stringify({ error: { code: "consumer_fenced", message: "owned by another consumer" } }));
  process.exit(1);
}
process.exit(0);
`,
  );
  await chmod(mockOrca, 0o755);

  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_CLI_COMMAND = mockOrca;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");

  try {
    await main(["prune", "--stranded", "--repo", canonicalRepo]);

    assert.equal(existsSync(marker), true);
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousCommand;
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});

test("reapAbortedRun retains gate worktree when pending passed outcome notification fails", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-late-abort-fail-"));
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
  const runId = "run-late-abort-notify-fail";
  const gatePath = path.join(canonicalRoot, runId);
  git(canonicalRepo, "worktree", "add", "-b", "gate-branch-fail", gatePath);

  const ledger = new DomainLedger({ repositoryPath: canonicalRepo });
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "test late abort notify fail",
    policySha256: "0".repeat(64),
    repoRoot: canonicalRepo,
    runId,
    submissionCommitOid: head,
  });
  ledger.finishRun(runId, "passed", head);

  const gate = {
    branch: "gate-branch-fail",
    id: `configured::${gatePath}`,
    intentTaskId: "task-1",
    kind: "configured" as const,
    path: gatePath,
    root: canonicalRoot,
    runId,
  };

  const gitOperations = {
    anchorRecoveryRef: async () => {},
    applyWorktreeCommits: async () => true,
    assertClean: async () => {},
    assertFixerChangesAllowed: async () => {},
    assertReady: async () => ({
      base: "main",
      baseOid: head,
      branch: "feature",
      head,
      root: canonicalRepo,
    }),
    diffBase: async () => "",
    head: async () => head,
    headOf: async () => head,
    pathExists: async () => false,
    policySha256: async () => "0".repeat(64),
    rebase: async () => ({ findings: [], summary: "rebased" }),
    resolveBaseOid: async () => head,
    resolveRefSha: async () => head,
    restoreTrackedFile: async () => {},
    stageAndCommit: async () => head,
  };

  await installAbortReaping({
    deliveryGit: gitOperations,
    gate,
    git: gitOperations,
    ledger,
    notify: async () => {
      throw new Error("notification network failure");
    },
    notifyHandle: "term-origin",
    originWorktree: canonicalRepo,
    pendingOutcome: "passed",
    pendingSummary: "Run passed all stages.",
    pid: process.pid,
    runId,
  });

  const markerFile = path.join(
    canonicalRepo,
    ".orca",
    "no-mistakes",
    `gate-${createHash("sha256").update(gate.path).digest("hex").slice(0, 32)}.json`,
  );

  try {
    await reapAbortedRun("operator interrupt");

    assert.equal(existsSync(markerFile), true);
    assert.equal(existsSync(gatePath), true);
  } finally {
    ledger.close();
    await rm(temp, { force: true, recursive: true });
  }
});
