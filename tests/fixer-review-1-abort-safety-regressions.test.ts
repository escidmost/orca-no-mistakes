import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
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
  registerAbortRunContext,
  releaseWorker,
  runPipeline,
  startWorkerWithFallback,
  type GitOperations,
  type OrcaOperations,
  type RepoSnapshot,
  type StageReport,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";

const OID = "a".repeat(40);
const NEXT_OID = "b".repeat(40);

function runRow(ledger: DomainLedger, runId: string, repoRoot = "/repo"): void {
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "abort safety",
    policySha256: "f".repeat(64),
    repoRoot,
    runId,
    submissionCommitOid: OID,
  });
}

function gitStub(overrides: Partial<GitOperations> = {}): GitOperations {
  const snapshot: RepoSnapshot = {
    base: "main",
    baseOid: OID,
    branch: "feature",
    head: OID,
    root: "/repo",
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
  let task = 0;
  return {
    async completeTask() {},
    async createGate() {
      return "gate";
    },
    async createRun() {
      return "run";
    },
    async createTask() {
      return `task-${task++}`;
    },
    async finishWorker() {},
    async removeWorktree() {},
    async setWorktreeStatus() {},
    async startWorker(taskId) {
      return {
        dispatchId: `dispatch-${task}`,
        report: { findings: [], summary: "clean", tested: [] },
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

test("abort retains the gate and lease when recovery anchoring fails", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-abort-anchor-"));
  const ledger = new DomainLedger(":memory:");
  const runId = "run-anchor-failure";
  const marker = path.join(
    temp,
    ".orca",
    "no-mistakes",
    `gate-${createHash("sha256").update("gate").digest("hex").slice(0, 32)}.json`,
  );
  try {
    runRow(ledger, runId, temp);
    ledger.acquireLease({ branch: "feature", repoRoot: temp, runId });
    await installAbortReaping({
      gate: {
        branch: "gate",
        id: "gate",
        kind: "orca",
        path: path.join(temp, "gate"),
      },
      ledger,
      notify: async () => assert.fail("an unpreserved run must not be cancelled"),
      orca: orcaStub(),
      orcaCommand: "/must-not-run",
      originWorktree: temp,
      pid: process.pid,
    });
    await registerAbortRunContext({
      deliveryGit: gitStub({
        async anchorRecoveryRef() {
          throw new Error("ref lock");
        },
      }),
      git: gitStub(),
      ledger,
      runId,
    });

    await reapAbortedRun("test abort");

    assert.equal(ledger.runStatus(runId), "in-progress");
    assert.ok(existsSync(marker));
    runRow(ledger, "next", temp);
    assert.throws(() =>
      ledger.acquireLease({ branch: "feature", repoRoot: temp, runId: "next" }),
    );
  } finally {
    ledger.close();
    await rm(temp, { force: true, recursive: true });
  }
});

test("abort cannot overwrite a terminal run", async () => {
  const ledger = new DomainLedger(":memory:");
  const notifications: string[] = [];
  try {
    runRow(ledger, "run-passed");
    assert.equal(ledger.finishRun("run-passed", "passed", OID), true);
    await installAbortReaping({
      ledger,
      notify: async (message) => {
        notifications.push(message);
      },
      orca: orcaStub(),
      orcaCommand: "orca",
      pid: process.pid,
    });
    await registerAbortRunContext({
      deliveryGit: gitStub(),
      git: gitStub(),
      ledger,
      runId: "run-passed",
    });

    await reapAbortedRun("late signal");

    assert.equal(ledger.runStatus("run-passed"), "passed");
    assert.deepEqual(notifications, []);
  } finally {
    ledger.close();
  }
});

test("abort waits for an in-flight gate mutation before anchoring", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-abort-race-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");
  const ledger = new DomainLedger(":memory:");
  let releaseRebase!: () => void;
  let rebaseStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    rebaseStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseRebase = resolve;
  });
  const anchors: string[] = [];
  let head = OID;
  const git = gitStub({
    async anchorRecoveryRef(_runId, oid) {
      anchors.push(oid);
    },
    async assertReady() {
      return { base: "main", baseOid: OID, branch: "feature", head: OID, root: temp };
    },
    async head() {
      return head;
    },
    async rebase(): Promise<StageReport> {
      rebaseStarted();
      await blocked;
      head = NEXT_OID;
      return { findings: [], rebaseUpstreamHead: OID, summary: "rebased" };
    },
  });
  const orca = orcaStub({
    async createRun() {
      return "run-race";
    },
  });
  try {
    await installAbortReaping({
      ledger,
      notify: async () => {},
      orca,
      orcaCommand: "orca",
      pid: process.pid,
    });
    const pipeline = runPipeline(
      { allowLocalConfig: true, intent: "race" },
      orca,
      git,
      ledger,
    );
    await started;
    const reap = reapAbortedRun("signal during rebase");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(anchors, []);
    releaseRebase();
    await reap;
    assert.equal(anchors[0], NEXT_OID);
    await assert.rejects(pipeline);
  } finally {
    ledger.close();
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    await rm(temp, { force: true, recursive: true });
  }
});

test("a releasing worker stays visible to the abort reaper", async () => {
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releases = 0;
  const worker: WorkerResult = {
    dispatchId: "dispatch",
    report: { findings: [], summary: "clean" },
    taskId: "task",
    worktreeId: "worker",
  };
  const orca = orcaStub({
    async finishWorker() {
      releases += 1;
      if (releases === 1) await firstRelease;
    },
    async startWorker() {
      return worker;
    },
  });
  await installAbortReaping({ orca, orcaCommand: "orca", pid: process.pid });
  await startWorkerWithFallback(orca, async () => "task", [
    {
      commitOid: OID,
      name: "reviewer",
      prompt: "review",
      role: "reviewer",
      stage: "review",
      worktree: "new-child",
    },
  ]);
  const release = releaseWorker(worker, orca);
  await new Promise<void>((resolve) => setImmediate(resolve));
  // The reaper serializes on the gate-mutation lock that the in-flight
  // release still holds: start it without awaiting, let the release finish
  // (it defers removal to the reaper once it sees the abort), then join both.
  const reap = reapAbortedRun("signal during release");
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([reap, release]);
  assert.equal(releases, 2);
});

test("the launcher records a gate before configuring it", async () => {
  const source = await readFile(
    new URL("../scripts/orca-no-mistakes.ts", import.meta.url),
    "utf8",
  );
  const marker = source.search(
    /await\s+writeLauncherGateMarker\(\s*repo\.root,\s*gate,\s*startupReceipt,/u,
  );
  const configure = source.indexOf('"--parent-worktree"', marker);
  assert.ok(marker >= 0 && configure > marker);
});

test("stranded prune retains a gate whose branch tip is unresolved", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-stranded-tip-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousOrca = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");
  process.env.ORCA_CLI_COMMAND = "/must-not-run";
  const repo = path.join(temp, "repo");
  const gatePath = path.join(temp, "gate");
  try {
    await mkdir(repo);
    await mkdir(gatePath);
    execFileSync("git", ["-c", "init.templateDir=", "init"], { cwd: repo });
    const root = await realpath(repo);
    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise<void>((resolve) => dead.on("exit", () => resolve()));
    assert.ok(dead.pid !== undefined);
    const marker = path.join(root, ".orca", "no-mistakes", "gate-gate.json");
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(
      marker,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate: { branch: "missing", id: "gate", kind: "orca", path: gatePath },
        originWorktree: root,
        pid: dead.pid,
      }),
    );

    await main(["prune", "--stranded", `--repo=${root}`]);

    assert.ok(existsSync(marker));
    assert.ok(existsSync(gatePath));
  } finally {
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    restoreEnv("ORCA_CLI_COMMAND", previousOrca);
    await rm(temp, { force: true, recursive: true });
  }
});
