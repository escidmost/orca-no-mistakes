import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  GateStopError,
  installAbortReaping,
  reapAbortedRun,
  registerAbortRunContext,
  releaseWorker,
  runPipeline,
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
      return { findings: [], rebaseUpstreamHead: A, summary: "rebased" };
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
        report: { findings: [], rebaseUpstreamHead: A, summary: "clean" },
        taskId,
      };
    },
    async waitForGate() {
      return "approve";
    },
    ...overrides,
  };
}

function seedRun(ledger: DomainLedger, runId: string, root: string): void {
  ledger.startRun({
    baseBranch: "main",
    branch: "main",
    intent: "abort finalization",
    policySha256: "f".repeat(64),
    repoRoot: root,
    runId,
    submissionCommitOid: A,
  });
  ledger.acquireLease({ branch: "main", repoRoot: root, runId });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("normal worker release yields to abort preservation ownership", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "onm-release-owner-")));
  const ledger = new DomainLedger(":memory:");
  seedRun(ledger, "run-release-owner", root);
  const events: string[] = [];
  let tip = A;
  let finishCalls = 0;
  let finishStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    finishStarted = resolve;
  });
  let allowFinish!: () => void;
  const finishing = new Promise<void>((resolve) => {
    allowFinish = resolve;
  });
  const worker: WorkerResult = {
    dispatchId: "dispatch-release-owner",
    report: { findings: [], summary: "done" },
    taskId: "task-release-owner",
    terminalHandle: "term-release-owner",
    worktreeId: "worktree-release-owner",
    worktreePath: "/worker-release-owner",
  };
  const orca = orcaStub({
    async finishWorker() {
      finishCalls += 1;
      events.push(`finish:${finishCalls}`);
      if (finishCalls === 1) {
        tip = B;
        finishStarted();
        await finishing;
      }
    },
    async removeWorktree() {
      events.push("remove");
    },
    async startWorker(_taskId, _launch, _fence, onAllocated) {
      onAllocated?.(worker);
      return worker;
    },
  });
  const sourceGit = gitStub(root, {
    async head() {
      return GATE;
    },
    async headOf() {
      events.push(`head:${tip[0]}`);
      return tip;
    },
  });
  const recoveryGit = gitStub(root, {
    async anchorRecoveryRef(_runId, oid) {
      events.push(`anchor:${oid[0]}`);
    },
  });
  try {
    await installAbortReaping({ orca, orcaCommand: "orca", pid: process.pid });
    await registerAbortRunContext({
      deliveryGit: recoveryGit,
      git: sourceGit,
      ledger,
      runId: "run-release-owner",
    });
    const result = await startWorkerWithFallback(
      orca,
      async () => worker.taskId,
      [
        {
          name: "reviewer",
          prompt: "review",
          role: "reviewer",
          stage: "review",
          worktree: "current",
        },
      ],
    );
    const reap = reapAbortedRun("release race");
    await started;
    const normalRelease = releaseWorker(result.worker, orca).then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    allowFinish();
    await reap;

    assert.ok((await normalRelease) instanceof GateStopError);
    assert.equal(finishCalls, 1);
    assert.deepEqual(events, [
      "head:a",
      "anchor:a",
      "finish:1",
      "head:b",
      "anchor:b",
      "anchor:c",
      "remove",
    ]);
    assert.equal(ledger.runStatus("run-release-owner"), "cancelled");
  } finally {
    ledger.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("abort owns failure settlement and attached gate cleanup", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "onm-gate-owner-")));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(root, "home");
  const ledger = new DomainLedger(":memory:");
  let finishCalls = 0;
  let reap: Promise<void> | undefined;
  const orca = orcaStub({
    async createRun() {
      return "run-gate-owner";
    },
    async finishWorker() {
      finishCalls += 1;
      if (finishCalls === 1) {
        reap = reapAbortedRun("pipeline failure race");
        await new Promise<void>((resolve) => setImmediate(resolve));
        throw new Error("delivery acknowledgement failed");
      }
      throw new Error("abort stop failed");
    },
    async startWorker(taskId, _launch, _fence, onAllocated) {
      const worker: WorkerResult = {
        dispatchId: "dispatch-gate-owner",
        report: { findings: [], rebaseUpstreamHead: A, summary: "clean" },
        taskId,
        terminalHandle: "term-gate-owner",
      };
      onAllocated?.(worker);
      return worker;
    },
  });
  const git = gitStub(root);
  try {
    await installAbortReaping({ ledger, orca, orcaCommand: "orca", pid: process.pid });
    await assert.rejects(
      runPipeline(
        { allowLocalConfig: true, intent: "gate cleanup ownership" },
        orca,
        git,
        ledger,
      ),
      GateStopError,
    );
    await reap;

    assert.equal(ledger.runStatus("run-gate-owner"), "in-progress");
    assert.equal(ledger.leaseFor(root, "main")?.run_id, "run-gate-owner");
    const source = await readFile(
      new URL("../scripts/orca-no-mistakes.ts", import.meta.url),
      "utf8",
    );
    const mainFinally = source.slice(source.indexOf("  } finally {", source.indexOf("export async function main")));
    assert.match(mainFinally, /withGateMutation\(async \(\) => \{\s+if \(abortRequested\) return;/u);
  } finally {
    ledger.close();
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    await rm(root, { force: true, recursive: true });
  }
});

test("run setup fails and releases its lease when marker refresh fails", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "onm-marker-durable-")));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(root, "home");
  const ledger = new DomainLedger(":memory:");
  let workersStarted = 0;
  const gate = {
    branch: "no-mistakes-gate-marker",
    id: `repo::${path.join(root, "no-mistakes-gate-marker")}`,
    kind: "orca" as const,
    path: path.join(root, "no-mistakes-gate-marker"),
  };
  const orca = orcaStub({
    async createRun() {
      return "run-marker-durable";
    },
    async startWorker(taskId) {
      workersStarted += 1;
      return {
        dispatchId: "dispatch-must-not-start",
        report: { findings: [], summary: "must not start" },
        taskId,
      };
    },
  });
  const git = gitStub(root);
  try {
    await mkdir(path.join(root, ".orca"), { recursive: true });
    await writeFile(path.join(root, ".orca", "no-mistakes"), "not a directory");
    await installAbortReaping({
      gate,
      ledger,
      orca,
      orcaCommand: "orca",
      originWorktree: root,
      pid: process.pid,
    });

    await assert.rejects(
      runPipeline(
        { allowLocalConfig: true, intent: "durable marker" },
        orca,
        git,
        ledger,
      ),
    );

    assert.equal(workersStarted, 0);
    // The marker refresh binds the run ID before startRun, so a refresh
    // failure leaves no run row behind at all — and no lease.
    assert.equal(ledger.runStatus("run-marker-durable"), undefined);
    assert.equal(ledger.leaseFor(root, "main"), undefined);
  } finally {
    ledger.close();
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    await rm(root, { force: true, recursive: true });
  }
});
