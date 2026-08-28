import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
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

function seedRun(ledger: DomainLedger, runId: string): void {
  ledger.startRun({
    baseBranch: "main",
    branch: "main",
    intent: "abort ownership",
    policySha256: "f".repeat(64),
    repoRoot: "/repo",
    runId,
    submissionCommitOid: A,
  });
  ledger.acquireLease({ branch: "main", repoRoot: "/repo", runId });
}

function launch(name: string) {
  return {
    name,
    prompt: "work",
    role: "reviewer" as const,
    stage: "review" as const,
    worktree: "current" as const,
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("abort owns allocated cleanup through the final worker anchor", async () => {
  const ledger = new DomainLedger(":memory:");
  seedRun(ledger, "run-worker-owner");
  const events: string[] = [];
  let tip = A;
  let rejectDelivery!: (error: Error) => void;
  const delivery = new Promise<never>((_resolve, reject) => {
    rejectDelivery = reject;
  });
  let allocated!: () => void;
  const allocation = new Promise<void>((resolve) => {
    allocated = resolve;
  });
  let producerCleanup = false;
  const worker: WorkerResult = {
    dispatchId: "dispatch-owner",
    report: { findings: [], summary: "active" },
    taskId: "task-owner",
    terminalHandle: "term-owner",
    worktreeId: "worktree-owner",
    worktreePath: "/worker-owner",
  };
  const orca = orcaStub({
    async finishWorker() {
      events.push("stop");
      tip = B;
      rejectDelivery(new Error("terminal closed"));
    },
    async removeWorktree() {
      events.push("remove");
    },
    async startWorker(_taskId, _launch, _fence, onAllocated) {
      const registration = onAllocated?.(worker);
      allocated();
      try {
        return await delivery;
      } catch (error) {
        const abortOwns = registration?.abortOwnsCleanup?.() === true;
        if (!abortOwns) producerCleanup = true;
        throw error;
      }
    },
  });
  const sourceGit = gitStub("/repo", {
    async head() {
      return GATE;
    },
    async headOf() {
      events.push(`head:${tip[0]}`);
      return tip;
    },
  });
  const recoveryGit = gitStub("/repo", {
    async anchorRecoveryRef(_runId, oid) {
      events.push(`anchor:${oid[0]}`);
    },
  });
  await installAbortReaping({ orca, orcaCommand: "orca", pid: process.pid });
  await registerAbortRunContext({
    deliveryGit: recoveryGit,
    git: sourceGit,
    ledger,
    runId: "run-worker-owner",
  });
  const started = startWorkerWithFallback(orca, async () => "task-owner", [
    launch("owner"),
  ]).then(
    () => false,
    () => true,
  );
  await allocation;
  await reapAbortedRun("cleanup owner");

  assert.equal(await started, true);
  assert.equal(producerCleanup, false);
  assert.ok(events.indexOf("anchor:a") < events.indexOf("stop"));
  assert.ok(events.indexOf("stop") < events.indexOf("anchor:b"));
  assert.ok(events.indexOf("anchor:b") < events.indexOf("remove"));
  assert.equal(ledger.runStatus("run-worker-owner"), "cancelled");
  ledger.close();
});

test("abort attempts every worker stop before retaining on failure", async () => {
  const ledger = new DomainLedger(":memory:");
  seedRun(ledger, "run-stop-all");
  const attempts: string[] = [];
  const rejectors = new Map<string, (error: Error) => void>();
  let allocations = 0;
  let allAllocated!: () => void;
  const allocated = new Promise<void>((resolve) => {
    allAllocated = resolve;
  });
  const orca = orcaStub({
    async finishWorker(worker) {
      attempts.push(worker.dispatchId);
      rejectors.get(worker.dispatchId)?.(new Error("stopped"));
      if (worker.dispatchId === "dispatch-1") throw new Error("stop failed");
    },
    async removeWorktree() {
      assert.fail("worker worktrees must be retained after a stop failure");
    },
    async startWorker(taskId, _launch, _fence, onAllocated) {
      const worker: WorkerResult = {
        dispatchId: `dispatch-${++allocations}`,
        report: { findings: [], summary: "active" },
        taskId,
        terminalHandle: `term-${allocations}`,
        worktreeId: `worktree-${allocations}`,
        worktreePath: `/worker-${allocations}`,
      };
      onAllocated?.(worker);
      if (allocations === 2) allAllocated();
      return await new Promise<never>((_resolve, reject) => {
        rejectors.set(worker.dispatchId, reject);
      });
    },
  });
  const sourceGit = gitStub("/repo", {
    async head() {
      return GATE;
    },
  });
  const recoveryGit = gitStub("/repo");
  await installAbortReaping({ orca, orcaCommand: "orca", pid: process.pid });
  await registerAbortRunContext({
    deliveryGit: recoveryGit,
    git: sourceGit,
    ledger,
    runId: "run-stop-all",
  });
  const first = startWorkerWithFallback(orca, async () => "task-1", [
    launch("one"),
  ]).catch(() => undefined);
  const second = startWorkerWithFallback(orca, async () => "task-2", [
    launch("two"),
  ]).catch(() => undefined);
  await allocated;
  await reapAbortedRun("stop all");
  await Promise.all([first, second]);

  assert.deepEqual(attempts, ["dispatch-1", "dispatch-2"]);
  assert.equal(ledger.runStatus("run-stop-all"), "in-progress");
  ledger.close();
});

test("stranded pruning treats connected false as a dead coordinator", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "onm-disconnected-")),
  );
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousOrca = process.env.ORCA_CLI_COMMAND;
  try {
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
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const gateName = "no-mistakes-gate-disconnected";
    const gatePath = path.join(root, ".orca", "workspaces", gateName);
    const gateId = `repo::${gatePath}`;
    const originId = `repo::${root}`;
    const branch = `refs/heads/${gateName}`;
    execFileSync("git", ["branch", gateName, head], { cwd: root });
    await mkdir(gatePath, { recursive: true });
    const markers = path.join(root, ".orca", "no-mistakes");
    await mkdir(markers, { recursive: true });
    const marker = path.join(
      markers,
      `gate-${encodeURIComponent(gateId)}.json`,
    );
    await writeFile(
      marker,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate: { branch: gateName, id: gateId, kind: "orca", path: gatePath },
        originWorktree: root,
        terminalHandle: "term-disconnected",
        version: 1,
      }),
    );
    const fakeOrca = path.join(root, "orca");
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'terminal' && args[1] === 'show') {
  console.log(JSON.stringify({ok:true,result:{terminal:{connected:false}}}))
} else if (args[0] === 'terminal' && args[1] === 'list') {
  console.log(JSON.stringify({ok:true,result:{terminals:[]}}))
} else if (args[0] === 'worktree' && args[1] === 'list') {
  console.log(JSON.stringify({ok:true,result:{worktrees:[
    {id:${JSON.stringify(gateId)},path:${JSON.stringify(gatePath)},branch:${JSON.stringify(branch)},head:${JSON.stringify(head)},repoId:'repo',parentWorktreeId:${JSON.stringify(originId)}},
    {id:${JSON.stringify(originId)},path:${JSON.stringify(root)},branch:'refs/heads/main',head:${JSON.stringify(head)},repoId:'repo',parentWorktreeId:null}
  ]}}))
} else if (args[0] === 'worktree' && args[1] === 'rm') {
  console.log(JSON.stringify({ok:true,result:{removed:true}}))
} else {
  console.error(JSON.stringify({ok:false,error:{code:'unexpected'}}))
  process.exit(1)
}
`,
    );
    await chmod(fakeOrca, 0o755);
    process.env.ORCA_CLI_COMMAND = fakeOrca;
    process.env.ORCA_NO_MISTAKES_HOME = path.join(root, "home");

    await main(["prune", "--stranded", "--repo", root]);

    assert.equal(existsSync(marker), false);
    assert.throws(() =>
      execFileSync("git", ["rev-parse", "--verify", branch], { cwd: root }),
    );
  } finally {
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    restoreEnv("ORCA_CLI_COMMAND", previousOrca);
    await rm(root, { force: true, recursive: true });
  }
});
