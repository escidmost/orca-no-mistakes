import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
  GitShell,
  installAbortReaping,
  main,
  reapAbortedRun,
  registerAbortRunContext,
  releaseWorker,
  startWorkerWithFallback,
  type OrcaOperations,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// The marker is the on-disk contract between a run and `prune --stranded`.
function markerPath(origin: string, gateId: string): string {
  const digest = createHash("sha256").update(gateId).digest("hex").slice(0, 32);
  return path.join(origin, ".orca", "no-mistakes", `gate-${digest}.json`);
}

// Records what the abort reaper asks Orca to do instead of driving real
// terminals: terminal teardown itself is covered by the Orca adapter tests.
class ReapOrca implements OrcaOperations {
  readonly released: WorkerResult[] = [];
  workerWorktreeId = "repo::/worker";
  workerWorktreePath = "/worker";
  readonly removedWorktrees: string[] = [];

  async createRun(): Promise<string> {
    return "run-x";
  }

  async createTask(): Promise<string> {
    return "task-x";
  }

  async startWorker(taskId: string): Promise<WorkerResult> {
    return {
      dispatchId: "dispatch-1",
      report: { findings: [], summary: "clean", tested: [] },
      taskId,
      terminalHandle: "term-worker-1",
      worktreeId: this.workerWorktreeId,
      worktreePath: this.workerWorktreePath,
    };
  }

  async finishWorker(
    worker: WorkerResult,
    disposition: "release" | "retain",
  ): Promise<void> {
    if (disposition === "release") this.released.push(worker);
  }

  async removeWorktree(worktreeId: string): Promise<void> {
    this.removedWorktrees.push(worktreeId);
  }

  async completeTask(): Promise<void> {}

  async createGate(): Promise<string> {
    return "gate-1";
  }

  async waitForGate(): Promise<string> {
    return "approve";
  }

  async setWorktreeStatus(): Promise<void> {}
}

// A repository with a live gate worktree whose HEAD has moved past the base,
// plus a fake `orca` binary that removes the gate worktree for real, lists
// worktrees and terminals, and reports every terminal as gone.
async function seedRun(prefix: string, options: { work?: boolean } = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  git(temp, "-c", "init.templateDir=", "init", "-b", "feature", "origin");
  const origin = await realpath(path.join(temp, "origin"));
  git(origin, "config", "user.email", "test@example.com");
  git(origin, "config", "user.name", "Test User");
  git(origin, "config", "commit.gpgsign", "false");
  git(origin, "config", "core.hooksPath", "/dev/null");
  await writeFile(path.join(origin, "README.md"), "seed\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "seed");
  const baseOid = git(origin, "rev-parse", "HEAD");
  // The gate's id, path, and branch must identify each other: the id embeds
  // the absolute path and the branch basename matches the path basename.
  const gateBranch = "evs/no-mistakes-gate-abort";
  git(
    origin,
    "worktree",
    "add",
    "-b",
    gateBranch,
    path.join(temp, "no-mistakes-gate-abort"),
  );
  const gatePath = await realpath(path.join(temp, "no-mistakes-gate-abort"));
  let gateHead = baseOid;
  if (options.work !== false) {
    await writeFile(path.join(gatePath, "work.txt"), "work\n");
    git(gatePath, "add", ".");
    git(gatePath, "commit", "-m", "work");
    gateHead = git(gatePath, "rev-parse", "HEAD");
  }
  // A real worker worktree: abort preservation must anchor its actual HEAD.
  const workerPath = path.join(temp, "worker");
  git(origin, "worktree", "add", "--detach", workerPath, baseOid);
  await writeFile(path.join(workerPath, "finding.txt"), "fix\n");
  git(workerPath, "add", ".");
  git(workerPath, "commit", "-m", "worker fix");
  const workerHead = git(workerPath, "rev-parse", "HEAD");
  const workerId = `repo::${workerPath}`;
  const gateId = `repo::${gatePath}`;
  const originId = `repo::${origin}`;
  const fakeOrca = path.join(temp, "orca");
  await writeFile(
    fakeOrca,
    `#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
const gatePath = ${JSON.stringify(gatePath)}
const origin = ${JSON.stringify(origin)}
if (args[0] === 'worktree' && args[1] === 'list') {
  const worktrees = [{ id: ${JSON.stringify(originId)}, path: origin, branch: 'refs/heads/feature', head: ${JSON.stringify(baseOid)} }]
  if (existsSync(gatePath)) {
    const head = execFileSync('git', ['rev-parse', 'refs/heads/${gateBranch}'], { cwd: origin, encoding: 'utf8' }).trim()
    worktrees.push({ id: ${JSON.stringify(gateId)}, path: gatePath, branch: 'refs/heads/${gateBranch}', head, parentWorktreeId: ${JSON.stringify(originId)} })
  }
  out({ worktrees })
} else if (args[0] === 'worktree' && args[1] === 'rm') {
  try { execFileSync('git', ['worktree', 'remove', '--force', gatePath], { cwd: origin }) } catch {}
  out({ ok: true })
} else if (args[0] === 'terminal' && args[1] === 'list') {
  out({ terminals: [] })
} else if (args[0] === 'terminal' && args[1] === 'show') {
  console.log(JSON.stringify({ ok: false, error: { code: 'terminal_handle_stale' } }))
  process.exit(1)
} else if (args[0] === 'orchestration' && args[1] === 'task-list') {
  out({ tasks: [{ id: 'task-settlement', status: 'in_progress' }] })
} else if (args[0] === 'orchestration' && args[1] === 'task-update') {
  out({ task: { id: 'task-settlement', status: 'failed' } })
} else {
  out({ ok: true })
}
`,
  );
  await chmod(fakeOrca, 0o755);
  const gate = {
    branch: gateBranch,
    id: gateId,
    kind: "orca" as const,
    path: gatePath,
  };
  return {
    baseOid,
    fakeOrca,
    gate,
    gateHead,
    gatePath,
    origin,
    temp,
    workerHead,
    workerId,
    workerPath,
  };
}

function withEnv(overrides: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.on("exit", resolve));
  assert.ok(child.pid !== undefined);
  return child.pid;
}

const reviewerLaunch = {
  commitOid: "a".repeat(40),
  name: "no-mistakes-review-1",
  prompt: "review",
  role: "reviewer",
  stage: "review",
  worktree: "new-child",
} as const;

test("an aborted run reaps its workers and gate workspace and preserves its commits", async () => {
  const seeded = await seedRun("onm-abort-reap-");
  const restore = withEnv({
    ORCA_NO_MISTAKES_HOME: path.join(seeded.temp, "home"),
  });
  const runId = "run-aborted";
  const ledger = new DomainLedger();
  const notifications: string[] = [];
  try {
    const orca = new ReapOrca();
    orca.workerWorktreeId = seeded.workerId;
    orca.workerWorktreePath = seeded.workerPath;
    ledger.startRun({
      baseBranch: "feature",
      branch: "feature",
      intent: "abort",
      policySha256: "f".repeat(64),
      repoRoot: seeded.origin,
      runId,
      submissionCommitOid: seeded.baseOid,
    });
    ledger.acquireLease({ branch: "feature", repoRoot: seeded.origin, runId });
    await installAbortReaping({
      gate: seeded.gate,
      ledger,
      notify: async (summary) => {
        notifications.push(summary);
      },
      orca,
      orcaCommand: seeded.fakeOrca,
      originWorktree: seeded.origin,
      pid: process.pid,
      terminalHandle: "term-coordinator",
    });
    assert.ok(
      existsSync(markerPath(seeded.origin, seeded.gate.id)),
      "coordinator startup must record the gate marker",
    );
    await registerAbortRunContext({
      deliveryGit: new GitShell({ repo: seeded.origin }),
      git: new GitShell({ repo: seeded.gatePath }),
      ledger,
      runId,
    });
    await startWorkerWithFallback(orca, async () => "task-1", [
      reviewerLaunch,
    ]);

    await reapAbortedRun("received SIGTERM");

    assert.equal(
      orca.released.length,
      1,
      "abort must stop the live worker terminal",
    );
    assert.deepEqual(orca.removedWorktrees, [seeded.workerId]);
    assert.equal(
      existsSync(seeded.gatePath),
      false,
      "gate worktree must be removed",
    );
    assert.equal(
      git(seeded.origin, "branch", "--list", seeded.gate.branch),
      "",
      "gate branch must be deleted",
    );
    assert.equal(
      git(seeded.origin, "rev-parse", `refs/no-mistakes/recover/${runId}`),
      seeded.gateHead,
      "the gate's last commit must survive at the recovery ref",
    );
    const workerRunId = `${runId}-worker-${createHash("sha256")
      .update("dispatch-1")
      .digest("hex")
      .slice(0, 16)}`;
    assert.equal(
      git(seeded.origin, "rev-parse", `refs/no-mistakes/recover/${workerRunId}`),
      seeded.workerHead,
      "the worker's last commit must survive at its own recovery ref",
    );
    assert.equal(ledger.runStatus(runId), "cancelled");
    assert.equal(
      existsSync(markerPath(seeded.origin, seeded.gate.id)),
      false,
      "the marker goes away with the workspace it describes",
    );
    assert.ok(
      notifications.some((summary) =>
        summary.includes(`refs/no-mistakes/recover/${runId}`),
      ),
      "the operator must be told where the commits were preserved",
    );
    // The lease is free again: another run for the same branch can start.
    ledger.startRun({
      baseBranch: "feature",
      branch: "feature",
      intent: "after",
      policySha256: "f".repeat(64),
      repoRoot: seeded.origin,
      runId: "run-after",
      submissionCommitOid: seeded.baseOid,
    });
    ledger.acquireLease({
      branch: "feature",
      repoRoot: seeded.origin,
      runId: "run-after",
    });
  } finally {
    await installAbortReaping({ pid: process.pid });
    ledger.close();
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("a worker released before the abort is not released again", async () => {
  const orca = new ReapOrca();
  const ledger = new DomainLedger(":memory:");
  try {
    await installAbortReaping({
      ledger,
      notify: async () => {},
      orca,
      orcaCommand: "orca",
      pid: process.pid,
    });
    const outcome = await startWorkerWithFallback(
      orca,
      async () => "task-1",
      [reviewerLaunch],
    );
    await releaseWorker(outcome.worker, orca);
    assert.equal(orca.released.length, 1);

    await reapAbortedRun("received SIGHUP");

    assert.equal(
      orca.released.length,
      1,
      "a worker already released must not be re-reaped",
    );
    assert.equal(orca.removedWorktrees.length, 1);
  } finally {
    ledger.close();
  }
});

test("prune --stranded reaps a dead coordinator's gate workspace", async () => {
  const seeded = await seedRun("onm-stranded-dead-");
  const restore = withEnv({
    ORCA_CLI_COMMAND: seeded.fakeOrca,
    ORCA_NO_MISTAKES_HOME: path.join(seeded.temp, "home"),
  });
  const runId = "run-dead";
  try {
    const ledger = new DomainLedger();
    ledger.startRun({
      baseBranch: "feature",
      branch: "feature",
      intent: "dead",
      policySha256: "f".repeat(64),
      repoRoot: seeded.origin,
      runId,
      submissionCommitOid: seeded.baseOid,
    });
    ledger.acquireLease({ branch: "feature", repoRoot: seeded.origin, runId });
    ledger.close();
    await mkdir(path.dirname(markerPath(seeded.origin, seeded.gate.id)), {
      recursive: true,
    });
    await writeFile(
      markerPath(seeded.origin, seeded.gate.id),
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate: seeded.gate,
        originWorktree: seeded.origin,
        pid: await deadPid(),
        runId,
        terminalHandle: "term-dead",
      }),
    );

    await main(["prune", "--stranded", `--repo=${seeded.origin}`]);

    assert.equal(existsSync(seeded.gatePath), false);
    assert.equal(
      git(seeded.origin, "branch", "--list", seeded.gate.branch),
      "",
    );
    assert.equal(
      git(seeded.origin, "rev-parse", `refs/no-mistakes/recover/${runId}`),
      seeded.gateHead,
      "prune must preserve the dead run's last commit before reaping",
    );
    assert.equal(existsSync(markerPath(seeded.origin, seeded.gate.id)), false);
    const reopened = new DomainLedger();
    assert.equal(reopened.runStatus(runId), "cancelled");
    reopened.startRun({
      baseBranch: "feature",
      branch: "feature",
      intent: "after",
      policySha256: "f".repeat(64),
      repoRoot: seeded.origin,
      runId: "run-after",
      submissionCommitOid: seeded.baseOid,
    });
    reopened.acquireLease({
      branch: "feature",
      repoRoot: seeded.origin,
      runId: "run-after",
    });
    reopened.close();
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("prune --stranded retains a live coordinator's gate workspace", async () => {
  const seeded = await seedRun("onm-stranded-live-");
  const restore = withEnv({
    ORCA_CLI_COMMAND: seeded.fakeOrca,
    ORCA_NO_MISTAKES_HOME: path.join(seeded.temp, "home"),
  });
  const runId = "run-live";
  try {
    const ledger = new DomainLedger();
    ledger.startRun({
      baseBranch: "feature",
      branch: "feature",
      intent: "live",
      policySha256: "f".repeat(64),
      repoRoot: seeded.origin,
      runId,
      submissionCommitOid: seeded.baseOid,
    });
    ledger.close();
    await mkdir(path.dirname(markerPath(seeded.origin, seeded.gate.id)), {
      recursive: true,
    });
    // This process stands in for the live coordinator.
    await writeFile(
      markerPath(seeded.origin, seeded.gate.id),
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate: seeded.gate,
        originWorktree: seeded.origin,
        pid: process.pid,
        runId,
        terminalHandle: "term-live",
      }),
    );

    await main(["prune", "--stranded", `--repo=${seeded.origin}`]);

    assert.ok(existsSync(seeded.gatePath), "a live run's worktree stays");
    assert.notEqual(
      git(seeded.origin, "branch", "--list", seeded.gate.branch),
      "",
      "a live run's branch stays",
    );
    assert.ok(existsSync(markerPath(seeded.origin, seeded.gate.id)));
    assert.equal(
      git(seeded.origin, "for-each-ref", "refs/no-mistakes/recover"),
      "",
      "nothing is anchored for a run that is still alive",
    );
    const reopened = new DomainLedger();
    assert.equal(reopened.runStatus(runId), "in-progress");
    reopened.close();
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("prune --stranded reaps a gate whose coordinator never started", async () => {
  const seeded = await seedRun("onm-stranded-never-", { work: false });
  const restore = withEnv({
    ORCA_CLI_COMMAND: seeded.fakeOrca,
    ORCA_NO_MISTAKES_HOME: path.join(seeded.temp, "home"),
  });
  try {
    // A launcher-written marker: terminal handle only, no pid or run yet.
    await mkdir(path.dirname(markerPath(seeded.origin, seeded.gate.id)), {
      recursive: true,
    });
    await writeFile(
      markerPath(seeded.origin, seeded.gate.id),
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate: seeded.gate,
        originWorktree: seeded.origin,
        terminalHandle: "term-gone",
      }),
    );

    await main(["prune", "--stranded", `--repo=${seeded.origin}`]);

    assert.equal(existsSync(seeded.gatePath), false);
    assert.equal(
      git(seeded.origin, "branch", "--list", seeded.gate.branch),
      "",
    );
    assert.equal(existsSync(markerPath(seeded.origin, seeded.gate.id)), false);
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("prune --stranded retains a gate whose commits cannot be anchored", async () => {
  const seeded = await seedRun("onm-stranded-anchor-");
  const restore = withEnv({
    ORCA_CLI_COMMAND: seeded.fakeOrca,
    ORCA_NO_MISTAKES_HOME: path.join(seeded.temp, "home"),
  });
  const runId = "run-dead";
  try {
    const ledger = new DomainLedger();
    ledger.startRun({
      baseBranch: "feature",
      branch: "feature",
      intent: "dead",
      policySha256: "f".repeat(64),
      repoRoot: seeded.origin,
      runId,
      submissionCommitOid: seeded.baseOid,
    });
    ledger.close();
    await mkdir(path.dirname(markerPath(seeded.origin, seeded.gate.id)), {
      recursive: true,
    });
    await writeFile(
      markerPath(seeded.origin, seeded.gate.id),
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate: seeded.gate,
        originWorktree: seeded.origin,
        pid: await deadPid(),
        runId,
        terminalHandle: "term-dead",
      }),
    );
    // A stale ref lock makes the anchor fail: reaping must not take the
    // workspace whose commits it could not preserve.
    await mkdir(
      path.join(seeded.origin, ".git", "refs", "no-mistakes", "recover"),
      { recursive: true },
    );
    await writeFile(
      path.join(
        seeded.origin,
        ".git",
        "refs",
        "no-mistakes",
        "recover",
        `${runId}.lock`,
      ),
      "",
    );

    await main(["prune", "--stranded", `--repo=${seeded.origin}`]);

    assert.ok(existsSync(seeded.gatePath), "an unanchored workspace stays");
    assert.notEqual(
      git(seeded.origin, "branch", "--list", seeded.gate.branch),
      "",
      "an unanchored branch stays",
    );
    assert.ok(existsSync(markerPath(seeded.origin, seeded.gate.id)));
    const reopened = new DomainLedger();
    assert.equal(reopened.runStatus(runId), "in-progress");
    reopened.close();
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});
