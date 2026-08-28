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
  installAbortReaping,
  main,
  reapAbortedRun,
  runPipeline,
  startWorkerWithFallback,
  type GitOperations,
  type OrcaOperations,
  type RepoSnapshot,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";

const OID = "a".repeat(40);

function runRow(
  ledger: DomainLedger,
  runId: string,
  repoRoot: string,
  branch = "main",
): void {
  ledger.startRun({
    baseBranch: "main",
    branch,
    intent: "lifecycle safety",
    policySha256: "f".repeat(64),
    repoRoot,
    runId,
    submissionCommitOid: OID,
  });
}

function gitStub(
  root: string,
  overrides: Partial<GitOperations> = {},
): GitOperations {
  const snapshot: RepoSnapshot = {
    base: "main",
    baseOid: OID,
    branch: "main",
    head: OID,
    root,
  };
  return {
    async anchorRecoveryRef() {},
    async applyWorktreeCommits() {
      return true;
    },
    async assertClean() {},
    async assertFixerChangesAllowed() {},
    async assertReady() {
      return snapshot;
    },
    async diffBase() {
      return "";
    },
    async head() {
      return OID;
    },
    async headOf() {
      return OID;
    },
    async pathExists() {
      return false;
    },
    async policySha256() {
      return "f".repeat(64);
    },
    async rebase() {
      return { findings: [], summary: "rebased" };
    },
    async resolveBaseOid() {
      return OID;
    },
    async resolveRefSha() {
      return undefined;
    },
    async showFile() {
      return undefined;
    },
    async worktreeIsReusable() {
      return false;
    },
    ...overrides,
  };
}

function orcaStub(overrides: Partial<OrcaOperations> = {}): OrcaOperations {
  return {
    async completeTask() {},
    async createGate() {
      return "gate";
    },
    async createRun() {
      return "run";
    },
    async createTask() {
      return "task";
    },
    async finishWorker() {},
    async removeWorktree() {},
    async setWorktreeStatus() {},
    async startWorker(taskId) {
      return {
        dispatchId: "dispatch",
        report: { findings: [], summary: "clean" },
        taskId,
      };
    },
    async waitForGate() {
      return "approve";
    },
    ...overrides,
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function writeFakeOrca(root: string): Promise<string> {
  const executable = path.join(root, "fake-orca.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify(args) + "\\n")
const out = (value) => process.stdout.write(JSON.stringify(value))
if (args[0] === "terminal" && args[1] === "show") {
  const code = process.env.FAKE_TERMINAL_ERROR || "terminal_handle_stale"
  out({ ok: false, error: { code, message: code } })
  process.exitCode = 1
} else if (args[0] === "terminal" && args[1] === "list") {
  out({ ok: true, result: { terminals: [] } })
} else if (args[0] === "worktree" && args[1] === "list") {
  out({ ok: true, result: { worktrees: JSON.parse(process.env.FAKE_WORKTREES || "[]") } })
} else if (args[0] === "worktree" && args[1] === "rm") {
  if (process.env.FAKE_RM_FAIL === "1") {
    out({ ok: false, error: { code: "busy" } })
    process.exitCode = 1
  } else out({ ok: true, result: {} })
} else if (args[0] === "orchestration" && args[1] === "task-list") {
  out({ ok: true, result: { tasks: [{ id: "task-settlement", status: "in_progress" }] } })
} else if (args[0] === "orchestration" && args[1] === "task-update") {
  out({ ok: true, result: { task: { id: "task-settlement", status: "failed" } } })
} else {
  out({ ok: false, error: { code: "unexpected" } })
  process.exitCode = 1
}
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

function gateMarkerPath(repo: string, gateId: string): string {
  const digest = createHash("sha256").update(gateId).digest("hex").slice(0, 32);
  return path.join(
    repo,
    ".orca",
    "no-mistakes",
    `gate-${digest}.json`,
  );
}

async function writeMarker(
  repo: string,
  gate: { branch: string; id: string; path: string },
  runId?: string,
): Promise<string> {
  const marker = gateMarkerPath(repo, gate.id);
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(
    marker,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      gate: { ...gate, kind: "orca" },
      originWorktree: repo,
      runId,
      terminalHandle: "term-dead",
    }),
  );
  return marker;
}

test("workers are registered before their delivery completes", async () => {
  let allocated!: () => void;
  const allocation = new Promise<void>((resolve) => {
    allocated = resolve;
  });
  let deliver!: () => void;
  const delivery = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  let reaped = 0;
  const worker: WorkerResult = {
    dispatchId: "dispatch",
    report: { findings: [], summary: "active" },
    taskId: "task",
    terminalHandle: "term-worker",
    worktreeId: "worker-worktree",
  };
  const orca = orcaStub({
    async finishWorker() {
      reaped += 1;
    },
    async startWorker(_taskId, _launch, _fence, onAllocated) {
      onAllocated?.(worker);
      allocated();
      await delivery;
      return worker;
    },
  });
  let started: ReturnType<typeof startWorkerWithFallback> | undefined;
  try {
    await installAbortReaping({ orca, orcaCommand: "orca", pid: process.pid });
    started = startWorkerWithFallback(orca, async () => "task", [
      {
        name: "reviewer",
        prompt: "review",
        role: "reviewer",
        stage: "review",
        worktree: "new-child",
      },
    ]);
    await allocation;
    await reapAbortedRun("signal during worker delivery");
    assert.equal(reaped, 1);
  } finally {
    deliver();
    await started?.catch(() => {});
    await installAbortReaping({ pid: process.pid });
  }
});

test("abort waits for run setup before deciding settlement", async () => {
  const temp = await realpath(
    await mkdtemp(path.join(tmpdir(), "onm-run-setup-")),
  );
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");
  const ledger = new DomainLedger(":memory:");
  let createStarted!: () => void;
  const creating = new Promise<void>((resolve) => {
    createStarted = resolve;
  });
  let finishCreate!: () => void;
  const created = new Promise<void>((resolve) => {
    finishCreate = resolve;
  });
  const orca = orcaStub({
    async createRun() {
      createStarted();
      await created;
      return "run-setup-race";
    },
  });
  try {
    await installAbortReaping({ orca, orcaCommand: "orca", pid: process.pid });
    const pipeline = runPipeline(
      { allowLocalConfig: true, intent: "setup race" },
      orca,
      gitStub(temp),
      ledger,
    );
    await creating;
    let reaped = false;
    const reap = reapAbortedRun("signal during run setup").then(() => {
      reaped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reaped, false);
    finishCreate();
    await reap;
    await assert.rejects(pipeline);
    assert.equal(ledger.runStatus("run-setup-race"), "cancelled");
    assert.equal(ledger.leaseFor(temp, "main"), undefined);
  } finally {
    ledger.close();
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    await rm(temp, { force: true, recursive: true });
  }
});

test("transient terminal probe failures retain stranded gates", async () => {
  const temp = await realpath(
    await mkdtemp(path.join(tmpdir(), "onm-terminal-probe-")),
  );
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousLog = process.env.FAKE_ORCA_LOG;
  const previousError = process.env.FAKE_TERMINAL_ERROR;
  const previousWorktrees = process.env.FAKE_WORKTREES;
  const log = path.join(temp, "orca.log");
  const gatePath = path.join(temp, "no-mistakes-gate-probe");
  const gate = {
    branch: path.basename(gatePath),
    id: `repo::${gatePath}`,
    path: gatePath,
  };
  try {
    process.env.ORCA_CLI_COMMAND = await writeFakeOrca(temp);
    process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "state");
    process.env.FAKE_ORCA_LOG = log;
    process.env.FAKE_TERMINAL_ERROR = "daemon_unavailable";
    process.env.FAKE_WORKTREES = JSON.stringify([
      { branch: "refs/heads/main", id: `repo::${temp}`, path: temp },
      {
        branch: `refs/heads/${gate.branch}`,
        head: OID,
        id: gate.id,
        parentWorktreeId: `repo::${temp}`,
        path: gate.path,
      },
    ]);
    const marker = await writeMarker(temp, gate);
    await main(["prune", "--stranded", "--repo", temp]);
    assert.ok(existsSync(marker));
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls, [
      ["worktree", "list", "--json"],
      ["terminal", "list", "--worktree", `path:${gatePath}`, "--json"],
      ["terminal", "show", "--terminal", "term-dead", "--json"],
    ]);
  } finally {
    restoreEnv("ORCA_CLI_COMMAND", previousCommand);
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    restoreEnv("FAKE_ORCA_LOG", previousLog);
    restoreEnv("FAKE_TERMINAL_ERROR", previousError);
    restoreEnv("FAKE_WORKTREES", previousWorktrees);
    await rm(temp, { force: true, recursive: true });
  }
});

test("marker resources must match current Orca ownership", async () => {
  const temp = await realpath(
    await mkdtemp(path.join(tmpdir(), "onm-marker-owner-")),
  );
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousLog = process.env.FAKE_ORCA_LOG;
  const previousWorktrees = process.env.FAKE_WORKTREES;
  const log = path.join(temp, "orca.log");
  const originId = `repo::${temp}`;
  const gatePath = path.join(temp, "no-mistakes-gate-owner");
  const gate = {
    branch: path.basename(gatePath),
    id: `repo::${gatePath}`,
    path: gatePath,
  };
  try {
    process.env.ORCA_CLI_COMMAND = await writeFakeOrca(temp);
    process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "state");
    process.env.FAKE_ORCA_LOG = log;
    process.env.FAKE_WORKTREES = JSON.stringify([
      { branch: "refs/heads/main", id: originId, path: temp },
      {
        branch: `refs/heads/${gate.branch}`,
        head: OID,
        id: gate.id,
        parentWorktreeId: "repo::somewhere-else",
        path: gate.path,
      },
    ]);
    const marker = await writeMarker(temp, gate);
    await main(["prune", "--stranded", "--repo", temp]);
    assert.ok(existsSync(marker));
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "worktree" && args[1] === "rm"),
      false,
    );
  } finally {
    restoreEnv("ORCA_CLI_COMMAND", previousCommand);
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    restoreEnv("FAKE_ORCA_LOG", previousLog);
    restoreEnv("FAKE_WORKTREES", previousWorktrees);
    await rm(temp, { force: true, recursive: true });
  }
});

test("run settlement atomically releases its lease", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    runRow(ledger, "run-settle", "/repo", "feature");
    ledger.acquireLease({
      branch: "feature",
      repoRoot: "/repo",
      runId: "run-settle",
    });
    assert.equal(ledger.settleRun("run-settle", "cancelled"), true);
    assert.equal(ledger.runStatus("run-settle"), "cancelled");
    assert.equal(ledger.leaseFor("/repo", "feature"), undefined);
    ledger.acquireLease({
      branch: "feature",
      repoRoot: "/repo",
      runId: "run-settle",
    });
    assert.equal(ledger.settleRun("run-settle", "cancelled"), false);
    assert.equal(ledger.leaseFor("/repo", "feature"), undefined);
  } finally {
    ledger.close();
  }
});

test("ownership-fenced settlement requires the in-progress run's lease", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    runRow(ledger, "run-owned", "/repo", "feature");
    const ownership = { branch: "feature", repoRoot: "/repo" };
    assert.equal(ledger.settleRun("run-owned", "cancelled", ownership), false);
    assert.equal(ledger.runStatus("run-owned"), "in-progress");
    ledger.acquireLease({ ...ownership, runId: "run-owned" });
    assert.equal(ledger.settleRun("run-owned", "cancelled", ownership), true);
    assert.equal(ledger.runStatus("run-owned"), "cancelled");
    assert.equal(ledger.settleRun("run-owned", "cancelled", ownership), true);
  } finally {
    ledger.close();
  }
});

test("stranded cleanup settles before removal and retries partial removal", async () => {
  const temp = await realpath(
    await mkdtemp(path.join(tmpdir(), "onm-stranded-retry-")),
  );
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousLog = process.env.FAKE_ORCA_LOG;
  const previousRm = process.env.FAKE_RM_FAIL;
  const previousWorktrees = process.env.FAKE_WORKTREES;
  const log = path.join(temp, "orca.log");
  const gatePath = path.join(temp, "no-mistakes-gate-retry");
  const gate = {
    branch: path.basename(gatePath),
    id: `repo::${gatePath}`,
    path: gatePath,
  };
  const originId = `repo::${temp}`;
  try {
    execFileSync("git", ["-c", "init.templateDir=", "init", "-b", "main"], {
      cwd: temp,
    });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: temp,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: temp });
    await writeFile(path.join(temp, "tracked"), "data\n");
    execFileSync("git", ["add", "tracked"], { cwd: temp });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: temp });
    execFileSync("git", ["branch", gate.branch], { cwd: temp });
    const tip = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: temp,
      encoding: "utf8",
    }).trim();
    process.env.ORCA_CLI_COMMAND = await writeFakeOrca(temp);
    process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "state");
    process.env.FAKE_ORCA_LOG = log;
    process.env.FAKE_WORKTREES = JSON.stringify([
      { branch: "refs/heads/main", id: originId, path: temp },
      {
        branch: `refs/heads/${gate.branch}`,
        head: tip,
        id: gate.id,
        parentWorktreeId: originId,
        path: gate.path,
      },
    ]);
    const ledger = new DomainLedger();
    runRow(ledger, "run-stranded-retry", temp);
    ledger.acquireLease({
      branch: "main",
      repoRoot: temp,
      runId: "run-stranded-retry",
    });
    ledger.close();
    const marker = await writeMarker(temp, gate, "run-stranded-retry");

    process.env.FAKE_RM_FAIL = "1";
    await main(["prune", "--stranded", "--repo", temp]);
    assert.ok(existsSync(marker));
    const settled = new DomainLedger();
    assert.equal(settled.runStatus("run-stranded-retry"), "cancelled");
    assert.equal(settled.leaseFor(temp, "main"), undefined);
    settled.close();
    assert.equal(
      execFileSync(
        "git",
        ["rev-parse", "refs/no-mistakes/recover/run-stranded-retry"],
        { cwd: temp, encoding: "utf8" },
      ).trim(),
      tip,
    );

    process.env.FAKE_RM_FAIL = "0";
    await main(["prune", "--stranded", "--repo", temp]);
    assert.equal(existsSync(marker), false);
    assert.throws(() =>
      execFileSync("git", ["show-ref", "--verify", `refs/heads/${gate.branch}`], {
        cwd: temp,
        stdio: "ignore",
      }),
    );
  } finally {
    restoreEnv("ORCA_CLI_COMMAND", previousCommand);
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    restoreEnv("FAKE_ORCA_LOG", previousLog);
    restoreEnv("FAKE_RM_FAIL", previousRm);
    restoreEnv("FAKE_WORKTREES", previousWorktrees);
    await rm(temp, { force: true, recursive: true });
  }
});
