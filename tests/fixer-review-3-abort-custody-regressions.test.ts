import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CliOrca,
  DomainLedger,
  GitShell,
  installAbortReaping,
  main,
  reapAbortedRun,
  registerAbortRunContext,
  startWorkerWithFallback,
  type GitOperations,
  type OrcaOperations,
  type RepoSnapshot,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const GATE = "c".repeat(40);

function gitStub(
  root: string,
  overrides: Partial<GitOperations> = {},
): GitOperations {
  const snapshot: RepoSnapshot = {
    base: "main",
    baseOid: A,
    branch: "main",
    head: A,
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
      return A;
    },
    async headOf() {
      return A;
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
      return A;
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

function seedRun(ledger: DomainLedger, runId: string, repoRoot: string): void {
  ledger.startRun({
    baseBranch: "main",
    branch: "main",
    intent: "abort custody",
    policySha256: "f".repeat(64),
    repoRoot,
    runId,
    submissionCommitOid: A,
  });
  ledger.acquireLease({ branch: "main", repoRoot, runId });
}

function initRepo(root: string): string {
  execFileSync("git", ["-c", "init.templateDir=", "init", "-b", "main"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], {
    cwd: root,
  });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("abort fences late allocation and preserves worker tips before cleanup", async () => {
  const ledger = new DomainLedger(":memory:");
  seedRun(ledger, "run-abort-order", "/repo");
  const events: string[] = [];
  let allocationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    allocationStarted = resolve;
  });
  let allocate!: () => void;
  const allocation = new Promise<void>((resolve) => {
    allocate = resolve;
  });
  let delivered!: () => void;
  const delivery = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  let stopped = false;
  const worker: WorkerResult = {
    dispatchId: "dispatch-late",
    report: { findings: [], summary: "active" },
    taskId: "task",
    terminalHandle: "term-worker",
    worktreeId: "worktree-worker",
    worktreePath: "/worker",
  };
  const orca = orcaStub({
    async finishWorker() {
      events.push("stop");
      stopped = true;
      delivered();
    },
    async removeWorktree() {
      events.push("remove");
    },
    async startWorker(_taskId, _launch, _fence, onAllocated) {
      allocationStarted();
      await allocation;
      onAllocated?.(worker);
      await delivery;
      return worker;
    },
  });
  const sourceGit = gitStub("/repo", {
    async head() {
      events.push("gate-head");
      return GATE;
    },
    async headOf() {
      const oid = stopped ? B : A;
      events.push(`worker-head:${oid[0]}`);
      return oid;
    },
  });
  const recoveryGit = gitStub("/repo", {
    async anchorRecoveryRef(runId, oid) {
      events.push(`anchor:${runId}:${oid[0]}`);
    },
  });
  try {
    await installAbortReaping({ ledger, orca, orcaCommand: "orca", pid: process.pid });
    await registerAbortRunContext({
      deliveryGit: recoveryGit,
      git: sourceGit,
      ledger,
      runId: "run-abort-order",
    });
    const workerRun = startWorkerWithFallback(orca, async () => "task", [
      {
        name: "reviewer",
        prompt: "review",
        role: "reviewer",
        stage: "review",
        worktree: "new-child",
      },
    ]);
    await started;
    let finished = false;
    const reaping = reapAbortedRun("late allocation").then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    allocate();
    await Promise.all([workerRun, reaping]);
    const firstAnchor = events.findIndex(
      (event) => event.startsWith("anchor:") && event.endsWith(":a"),
    );
    const stop = events.indexOf("stop");
    const finalAnchor = events.findIndex(
      (event) => event.startsWith("anchor:") && event.endsWith(":b"),
    );
    const remove = events.indexOf("remove");
    assert.ok(firstAnchor >= 0 && firstAnchor < stop);
    assert.ok(stop < finalAnchor && finalAnchor < remove);
    assert.ok(events.includes("anchor:run-abort-order:c"));
    assert.equal(ledger.runStatus("run-abort-order"), "cancelled");
  } finally {
    ledger.close();
  }
});

test("abort stops and awaits an active ACP process", async () => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "onm-acp-stop-")));
  const acpx = path.join(temp, "acpx");
  const pidPath = path.join(temp, "pid");
  await writeFile(
    acpx,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))
process.stdin.resume()
setInterval(() => {}, 1000)
`,
  );
  await chmod(acpx, 0o755);
  const orca = new CliOrca({ acpxCommand: acpx, command: "/usr/bin/false", cwd: temp });
  let allocated!: (worker: WorkerResult) => void;
  const workerAllocated = new Promise<WorkerResult>((resolve) => {
    allocated = resolve;
  });
  try {
    const running = orca.startWorker(
      "task-acp",
      {
        agent: { harness: "acp:test" },
        name: "acp",
        prompt: "work",
        role: "reviewer",
        stage: "review",
        worktree: "current",
      },
      undefined,
      (worker) => {
        allocated(worker);
        return () => {};
      },
    );
    const worker = await workerAllocated;
    for (let attempt = 0; attempt < 100 && !existsSync(pidPath); attempt += 1) {
      await delay(10);
    }
    const pid = Number(await readFile(pidPath, "utf8"));
    await orca.finishWorker(worker, "release");
    await assert.rejects(running);
    assert.throws(() => process.kill(pid, 0), (error: unknown) => {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    });
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test("recovery refs reject divergent replacement", async () => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "onm-ref-cas-")));
  try {
    const parent = initRepo(temp);
    execFileSync("git", ["commit", "--allow-empty", "-m", "preserved"], {
      cwd: temp,
    });
    const preserved = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: temp,
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["rev-parse", `${preserved}^{tree}`], {
      cwd: temp,
      encoding: "utf8",
    }).trim();
    const divergent = execFileSync("git", ["commit-tree", tree, "-p", parent], {
      cwd: temp,
      encoding: "utf8",
      input: "divergent\n",
    }).trim();
    const git = new GitShell({ repo: temp });
    await git.anchorRecoveryRef("run-divergent", preserved);
    await assert.rejects(
      git.anchorRecoveryRef("run-divergent", divergent),
      /divergent custody/,
    );
    assert.equal(
      execFileSync("git", ["rev-parse", "refs/no-mistakes/recover/run-divergent"], {
        cwd: temp,
        encoding: "utf8",
      }).trim(),
      preserved,
    );
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test("stranded cleanup retains a gate branch changed after preservation", async () => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "onm-gate-cas-")));
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousWorktrees = process.env.FAKE_WORKTREES;
  const previousRepo = process.env.FAKE_REPO;
  const previousBranch = process.env.FAKE_GATE_BRANCH;
  const previousOld = process.env.FAKE_OLD_OID;
  const previousNew = process.env.FAKE_NEW_OID;
  try {
    const tip = initRepo(temp);
    const tree = execFileSync("git", ["rev-parse", `${tip}^{tree}`], {
      cwd: temp,
      encoding: "utf8",
    }).trim();
    const advanced = execFileSync("git", ["commit-tree", tree, "-p", tip], {
      cwd: temp,
      encoding: "utf8",
      input: "advanced\n",
    }).trim();
    const gatePath = path.join(temp, "no-mistakes-gate-cas");
    const gateBranch = path.basename(gatePath);
    const gateId = `repo::${gatePath}`;
    execFileSync("git", ["branch", gateBranch, tip], { cwd: temp });
    const fakeOrca = path.join(temp, "fake-orca.mjs");
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import { execFileSync } from "node:child_process"
const args = process.argv.slice(2)
const out = (value) => process.stdout.write(JSON.stringify(value))
if (args[0] === "terminal" && args[1] === "show") {
  out({ ok: false, error: { code: "terminal_handle_stale" } })
  process.exitCode = 1
} else if (args[0] === "terminal" && args[1] === "list") {
  out({ ok: true, result: { terminals: [] } })
} else if (args[0] === "worktree" && args[1] === "list") {
  out({ ok: true, result: { worktrees: JSON.parse(process.env.FAKE_WORKTREES) } })
} else if (args[0] === "worktree" && args[1] === "rm") {
  execFileSync("git", ["update-ref", "refs/heads/" + process.env.FAKE_GATE_BRANCH, process.env.FAKE_NEW_OID, process.env.FAKE_OLD_OID], { cwd: process.env.FAKE_REPO })
  out({ ok: true, result: {} })
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
    await chmod(fakeOrca, 0o755);
    process.env.ORCA_CLI_COMMAND = fakeOrca;
    process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "state");
    process.env.FAKE_REPO = temp;
    process.env.FAKE_GATE_BRANCH = gateBranch;
    process.env.FAKE_OLD_OID = tip;
    process.env.FAKE_NEW_OID = advanced;
    process.env.FAKE_WORKTREES = JSON.stringify([
      { branch: "refs/heads/main", id: `repo::${temp}`, path: temp },
      {
        branch: `refs/heads/${gateBranch}`,
        head: tip,
        id: gateId,
        parentWorktreeId: `repo::${temp}`,
        path: gatePath,
      },
    ]);
    const ledger = new DomainLedger();
    seedRun(ledger, "run-gate-cas", temp);
    ledger.close();
    const marker = path.join(
      temp,
      ".orca",
      "no-mistakes",
      `gate-${encodeURIComponent(gateId)}.json`,
    );
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(
      marker,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate: { branch: gateBranch, id: gateId, kind: "orca", path: gatePath },
        originWorktree: temp,
        runId: "run-gate-cas",
        terminalHandle: "term-dead",
      }),
    );
    await main(["prune", "--stranded", "--repo", temp]);
    assert.ok(existsSync(marker));
    assert.equal(
      execFileSync("git", ["rev-parse", `refs/heads/${gateBranch}`], {
        cwd: temp,
        encoding: "utf8",
      }).trim(),
      advanced,
    );
    assert.equal(
      execFileSync("git", ["rev-parse", "refs/no-mistakes/recover/run-gate-cas"], {
        cwd: temp,
        encoding: "utf8",
      }).trim(),
      tip,
    );
  } finally {
    restoreEnv("ORCA_CLI_COMMAND", previousCommand);
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    restoreEnv("FAKE_WORKTREES", previousWorktrees);
    restoreEnv("FAKE_REPO", previousRepo);
    restoreEnv("FAKE_GATE_BRANCH", previousBranch);
    restoreEnv("FAKE_OLD_OID", previousOld);
    restoreEnv("FAKE_NEW_OID", previousNew);
    await rm(temp, { force: true, recursive: true });
  }
});

test("terminal marker refresh is inside launcher cleanup scope", async () => {
  const sourcePath = fileURLToPath(
    new URL("../scripts/orca-no-mistakes.ts", import.meta.url),
  );
  const source = await readFile(sourcePath, "utf8");
  const refresh = source.search(
    /await writeLauncherGateMarker\(\s*repo\.root,\s*gate,\s*startupReceipt,\s*terminalHandle,\s*\);/u,
  );
  const cleanup = source.indexOf(
    '["terminal", "close", "--terminal", terminalHandle, "--tab", "--json"]',
    refresh,
  );
  const catchBlock = source.lastIndexOf("try {", refresh);
  assert.ok(catchBlock >= 0 && catchBlock < refresh);
  assert.ok(refresh < cleanup);
  assert.match(source.slice(refresh, cleanup), /catch \(error\)/u);
});
