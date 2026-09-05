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
  CliOrca,
  DomainLedger,
  GitShell,
  main,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(origin: string, markerId: string): string {
  const digest = createHash("sha256")
    .update(markerId)
    .digest("hex")
    .slice(0, 32);
  return path.join(origin, ".orca", "no-mistakes", `gate-${digest}.json`);
}

function setEnv(home: string, orcaCommand: string): () => void {
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  process.env.ORCA_CLI_COMMAND = orcaCommand;
  return () => {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousCommand;
  };
}

test("dead in-progress run does not deliver precommit passed outcome and is settled cancelled", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-test-precommit-"));
  const origin = path.join(temp, "origin.git");
  const repo = path.join(temp, "repo");
  const runsRoot = path.join(temp, "runs");

  git(temp, "-c", "init.templateDir=", "init", "--bare", origin);
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await writeFile(path.join(repo, ".gitignore"), ".orca/no-mistakes/\n");
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "seed");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  git(temp, `--git-dir=${origin}`, "symbolic-ref", "HEAD", "refs/heads/main");
  await mkdir(runsRoot);

  const canonicalRepo = await realpath(repo);
  const canonicalRunsRoot = await realpath(runsRoot);
  const runId = "run_dead_inprogress_test";
  const gatePath = path.join(canonicalRunsRoot, runId);
  git(canonicalRepo, "worktree", "add", "-b", `no-mistakes-gate-${runId}`, gatePath);

  const logFile = path.join(temp, "orca-calls.log");
  const orcaCommand = path.join(temp, "orca");
  await writeFile(
    orcaCommand,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.ORCA_TEST_LOG, JSON.stringify(process.argv) + "\\n");
const out = (result) => console.log(JSON.stringify({ result }));
out({ accepted: true });
`,
  );
  await chmod(orcaCommand, 0o755);
  process.env.ORCA_TEST_LOG = logFile;
  const restore = setEnv(path.join(temp, "home"), orcaCommand);

  const headOid = git(canonicalRepo, "rev-parse", "HEAD");
  const ledger = new DomainLedger({ repositoryPath: canonicalRepo });
  ledger.startRun({
    baseBranch: "main",
    branch: "main",
    intent: "test dead in-progress run precommit outcome",
    policySha256: "a".repeat(64),
    repoRoot: canonicalRepo,
    runId,
    submissionCommitOid: headOid,
  });
  ledger.acquireLease({
    branch: "main",
    repoRoot: canonicalRepo,
    runId,
  });
  const lease = ledger.leaseFor(canonicalRepo, "main");
  ledger.close();

  const gate = {
    branch: `no-mistakes-gate-${runId}`,
    intentTaskId: "task-intent",
    kind: "configured" as const,
    path: gatePath,
    root: canonicalRunsRoot,
    runId,
  };
  const marker = markerPath(canonicalRepo, gatePath);
  await writeFile(
    marker,
    JSON.stringify({
      allocationProtocol: "gated-v1",
      createdAt: new Date().toISOString(),
      gate,
      generationToken: lease?.generation_token,
      notifyHandle: "term_test_handle",
      originWorktree: canonicalRepo,
      pendingOutcome: "passed",
      pendingSummary: `Run ${runId} passed all 4 stages.\nCandidate commit: ${headOid}.`,
      pid: 99999998,
      runId,
    }),
  );

  try {
    await main(["prune", "--stranded", "--repo", canonicalRepo]);

    const calls = existsSync(logFile)
      ? (await readFile(logFile, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[])
      : [];
    const passedNotify = calls.find(
      (args) =>
        args.includes("orchestration") &&
        args.includes("send") &&
        args.includes("no-mistakes run passed"),
    );
    assert.equal(
      passedNotify,
      undefined,
      "precommit passed outcome must NOT be delivered when run is in-progress",
    );
    const cancelledNotify = calls.find(
      (args) =>
        args.includes("orchestration") &&
        args.includes("send") &&
        args.includes("no-mistakes run cancelled"),
    );
    assert.ok(
      cancelledNotify,
      "stranded cancellation must be delivered before cleanup",
    );
    assert.ok(
      cancelledNotify.includes("--body") &&
        cancelledNotify[cancelledNotify.indexOf("--body") + 1]?.includes(
          `refs/no-mistakes/recover/${runId}`,
        ),
      "stranded cancellation must include recovery instructions",
    );

    const checkLedger = new DomainLedger({ repositoryPath: canonicalRepo });
    const runState = checkLedger.runIdentity(runId);
    checkLedger.close();
    assert.ok(runState !== undefined);
    assert.equal(
      runState.status,
      "cancelled",
      "dead in-progress run must be settled as cancelled",
    );
  } finally {
    delete process.env.ORCA_TEST_LOG;
    restore();
    await rm(temp, { force: true, recursive: true });
  }
});

test("workerName avoids collisions for distinct run IDs", () => {
  const scopedName = (runId: string) =>
    new CliOrca({ command: "orca", cwd: process.cwd(), runId }).workerName(
      "worker",
    );
  assert.notEqual(
    scopedName("run.a"),
    scopedName("run-a"),
    "run.a and run-a must not produce colliding suffixes",
  );

  assert.notEqual(
    scopedName("prefix-alpha-123456789012"),
    scopedName("prefix-bravo-123456789012"),
    "run IDs with identical trailing 12 characters must not collide",
  );
});

test("custody reconstruction treats ancestor terminal commit as integrated", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-test-custody-"));
  const origin = path.join(temp, "origin.git");
  const repo = path.join(temp, "repo");
  const runsRoot = path.join(temp, "runs");

  git(temp, "-c", "init.templateDir=", "init", "--bare", origin);
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await writeFile(path.join(repo, ".gitignore"), ".orca/no-mistakes/\n");
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "seed");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  git(temp, `--git-dir=${origin}`, "symbolic-ref", "HEAD", "refs/heads/main");
  await mkdir(runsRoot);

  const canonicalRepo = await realpath(repo);
  const canonicalRunsRoot = await realpath(runsRoot);
  const runId = "run_custody_ancestor_test";
  const branchName = "feature";
  git(canonicalRepo, "checkout", "-b", branchName);
  const gatePath = path.join(canonicalRunsRoot, runId);
  git(canonicalRepo, "worktree", "add", "-b", `no-mistakes-gate-${runId}`, gatePath);

  const logFile = path.join(temp, "orca-calls.log");
  const orcaCommand = path.join(temp, "orca");
  await writeFile(
    orcaCommand,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.ORCA_TEST_LOG, JSON.stringify(process.argv) + "\\n");
const out = (result) => console.log(JSON.stringify({ result }));
out({ accepted: true });
`,
  );
  await chmod(orcaCommand, 0o755);
  process.env.ORCA_TEST_LOG = logFile;
  const restore = setEnv(path.join(temp, "home"), orcaCommand);

  // Terminal commit on feature branch
  const submissionCommitOid = git(canonicalRepo, "rev-parse", "HEAD");
  await writeFile(path.join(canonicalRepo, "candidate.txt"), "candidate commit\n");
  git(canonicalRepo, "add", "candidate.txt");
  git(canonicalRepo, "commit", "-m", "candidate terminal commit");
  const terminalCommitOid = git(canonicalRepo, "rev-parse", "HEAD");

  // Advance the feature branch further so terminalCommitOid is an ancestor of branch tip
  await writeFile(path.join(canonicalRepo, "next.txt"), "advanced branch commit\n");
  git(canonicalRepo, "add", "next.txt");
  git(canonicalRepo, "commit", "-m", "advance branch beyond terminal commit");
  const newBranchHead = git(canonicalRepo, "rev-parse", "HEAD");
  assert.notEqual(newBranchHead, terminalCommitOid);

  const gitShell = new GitShell({ repo: canonicalRepo });
  const isAnc = await gitShell.isAncestor(terminalCommitOid, newBranchHead);
  assert.equal(isAnc, true, "terminalCommitOid must be ancestor of newBranchHead");

  const ledger = new DomainLedger({ repositoryPath: canonicalRepo });
  ledger.startRun({
    baseBranch: "main",
    branch: branchName,
    intent: "test ancestor custody reconstruction",
    policySha256: "c".repeat(64),
    repoRoot: canonicalRepo,
    runId,
    submissionCommitOid,
  });
  ledger.finishRun(runId, "passed", terminalCommitOid);
  ledger.close();

  const gate = {
    branch: `no-mistakes-gate-${runId}`,
    intentTaskId: "task-intent",
    kind: "configured" as const,
    path: gatePath,
    root: canonicalRunsRoot,
    runId,
  };
  const marker = markerPath(canonicalRepo, gatePath);
  await writeFile(
    marker,
    JSON.stringify({
      allocationProtocol: "gated-v1",
      createdAt: new Date().toISOString(),
      gate,
      notifyHandle: "term_test_handle",
      originWorktree: canonicalRepo,
      pendingOutcome: "passed",
      pendingSummary: `Run ${runId} passed all 4 stages.\nCandidate commit: ${terminalCommitOid}.`,
      pid: 99999997,
      runId,
    }),
  );

  try {
    await main(["prune", "--stranded", "--repo", canonicalRepo]);
    const calls = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const notifyCall = calls.find(
      (args) => args.includes("orchestration") && args.includes("send"),
    );
    assert.ok(notifyCall !== undefined, "notification must be sent");
    const bodyIdx = notifyCall.indexOf("--body");
    assert.ok(bodyIdx >= 0);
    const body = notifyCall[bodyIdx + 1];

    assert.ok(
      body.includes("carries the terminal commit"),
      `expected "carries the terminal commit" in body, got: ${body}`,
    );
    assert.equal(
      body.includes("operator checkout diverged"),
      false,
      "must not report diverged checkout when terminal commit is ancestor",
    );
    assert.equal(
      body.includes(`refs/no-mistakes/recover/${runId}`),
      false,
      "must not emit recovery instructions when terminal commit is ancestor",
    );
  } finally {
    delete process.env.ORCA_TEST_LOG;
    restore();
    await rm(temp, { force: true, recursive: true });
  }
});
