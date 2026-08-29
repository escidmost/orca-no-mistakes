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
  registerAbortRunContext,
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

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

function markerPath(origin: string, gateId: string): string {
  const digest = createHash("sha256").update(gateId).digest("hex").slice(0, 32);
  return path.join(origin, ".orca", "no-mistakes", `gate-${digest}.json`);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("failed-worker teardown keeps one serialized cleanup owner", async () => {
  const source = await readFile(
    new URL("../scripts/orca-no-mistakes.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("  async startWorker(");
  const end = source.indexOf("  async #cleanupPreparedWorker", start);
  const workerStart = source.slice(start, end);
  const claims = [...workerStart.matchAll(/abortOwnsWorkerCleanup\(registration\)/gu)];

  assert.equal(claims.length, 4);
  for (const claim of claims) {
    const index = claim.index ?? 0;
    assert.match(
      workerStart.slice(Math.max(0, index - 180), index),
      /await withGateMutation\(async \(\) => \{/u,
    );
    assert.match(
      workerStart.slice(index, index + 450),
      /registration\?\.\(\);\s+\}, true\);/u,
    );
  }
});

test("abort stops every worker when one worktree cannot be read", async () => {
  const ledger = new DomainLedger(":memory:");
  ledger.startRun({
    baseBranch: "main",
    branch: "main",
    intent: "anchor failure",
    policySha256: "f".repeat(64),
    repoRoot: "/repo",
    runId: "run-anchor-failure",
    submissionCommitOid: A,
  });
  ledger.acquireLease({
    branch: "main",
    repoRoot: "/repo",
    runId: "run-anchor-failure",
  });
  const stopped: string[] = [];
  const anchored: string[] = [];
  const rejectors = new Map<string, (error: Error) => void>();
  let allocations = 0;
  let resolveAllocated!: () => void;
  const allocated = new Promise<void>((resolve) => {
    resolveAllocated = resolve;
  });
  const orca = orcaStub({
    async finishWorker(worker) {
      stopped.push(worker.dispatchId);
      rejectors.get(worker.dispatchId)?.(new Error("stopped"));
    },
    async removeWorktree() {
      assert.fail("unpreserved worker worktrees must be retained");
    },
    async startWorker(taskId, _launch, _fence, onAllocated) {
      allocations += 1;
      const worker: WorkerResult = {
        dispatchId: `dispatch-${allocations}`,
        report: { findings: [], summary: "active" },
        taskId,
        worktreeId: `worktree-${allocations}`,
        worktreePath: allocations === 1 ? "/unreadable" : "/readable",
      };
      onAllocated?.(worker);
      if (allocations === 2) resolveAllocated();
      return await new Promise<never>((_resolve, reject) => {
        rejectors.set(worker.dispatchId, reject);
      });
    },
  });
  const sourceGit = gitStub("/repo", {
    async head() {
      return GATE;
    },
    async headOf(worktreePath) {
      if (worktreePath === "/unreadable") throw new Error("unreadable worktree");
      return B;
    },
  });
  const recoveryGit = gitStub("/repo", {
    async anchorRecoveryRef(runId, oid) {
      anchored.push(`${runId}:${oid}`);
    },
  });
  try {
    await installAbortReaping({ orca, orcaCommand: "orca", pid: process.pid });
    await registerAbortRunContext({
      deliveryGit: recoveryGit,
      git: sourceGit,
      ledger,
      runId: "run-anchor-failure",
    });
    const first = startWorkerWithFallback(orca, async () => "task-1", [
      {
        name: "one",
        prompt: "work",
        role: "reviewer",
        stage: "review",
        worktree: "current",
      },
    ]).catch(() => undefined);
    const second = startWorkerWithFallback(orca, async () => "task-2", [
      {
        name: "two",
        prompt: "work",
        role: "reviewer",
        stage: "review",
        worktree: "current",
      },
    ]).catch(() => undefined);
    await allocated;

    await reapAbortedRun("unreadable worker");
    await Promise.all([first, second]);

    assert.deepEqual(stopped, ["dispatch-1", "dispatch-2"]);
    assert.equal(
      anchored.filter((entry) => entry.endsWith(`:${B}`)).length,
      2,
    );
    assert.ok(anchored.includes(`run-anchor-failure:${GATE}`));
    assert.equal(ledger.runStatus("run-anchor-failure"), "in-progress");
    assert.equal(
      ledger.leaseFor("/repo", "main")?.run_id,
      "run-anchor-failure",
    );
  } finally {
    ledger.close();
  }
});

class StartCrashLedger extends DomainLedger {
  override startRun(_input: Parameters<DomainLedger["startRun"]>[0]): void {
    throw new Error("crash before startRun");
  }
}

test("run marker binds before the ledger row is started", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "onm-run-marker-order-")),
  );
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(root, "home");
  const ledger = new StartCrashLedger(":memory:");
  const gate = {
    branch: "gate-marker-order",
    id: `repo::${path.join(root, "gate-marker-order")}`,
    kind: "orca" as const,
    path: path.join(root, "gate-marker-order"),
  };
  const orca = orcaStub({
    async createRun() {
      return "run-marker-order";
    },
  });
  try {
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
        { allowLocalConfig: true, intent: "marker order" },
        orca,
        gitStub(root),
        ledger,
      ),
      /crash before startRun/u,
    );

    const marker = JSON.parse(
      await readFile(markerPath(root, gate.id), "utf8"),
    ) as { runId?: string };
    assert.equal(marker.runId, "run-marker-order");
  } finally {
    ledger.close();
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    await rm(root, { force: true, recursive: true });
  }
});

async function seedStrandedGate(prefix: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  git(temp, "-c", "init.templateDir=", "init", "-b", "feature", "origin");
  const origin = await realpath(path.join(temp, "origin"));
  git(origin, "config", "user.email", "test@example.com");
  git(origin, "config", "user.name", "Test User");
  git(origin, "config", "commit.gpgsign", "false");
  git(origin, "config", "core.hooksPath", "/dev/null");
  git(origin, "commit", "--allow-empty", "-m", "seed");
  const gateName = `gate-${path.basename(temp)}`;
  const gatePath = path.join(temp, gateName);
  git(origin, "worktree", "add", "-b", gateName, gatePath);
  git(gatePath, "commit", "--allow-empty", "-m", "gate work");
  const gateHead = git(gatePath, "rev-parse", "HEAD");
  const gateId = `repo::${gatePath}`;
  const originId = `repo::${origin}`;
  const fakeOrca = path.join(temp, "orca");
  await writeFile(
    fakeOrca,
    `#!/usr/bin/env node
import { execFileSync } from "node:child_process"
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") {
  out({ worktrees: [
    { id: ${JSON.stringify(originId)}, path: ${JSON.stringify(origin)}, branch: "refs/heads/feature", head: ${JSON.stringify(gateHead)} },
    { id: ${JSON.stringify(gateId)}, path: ${JSON.stringify(gatePath)}, branch: ${JSON.stringify(`refs/heads/${gateName}`)}, head: ${JSON.stringify(gateHead)}, parentWorktreeId: ${JSON.stringify(originId)} }
  ] })
} else if (args[0] === "terminal" && args[1] === "list") {
  out({ terminals: [] })
} else if (args[0] === "worktree" && args[1] === "rm") {
  execFileSync("git", ["worktree", "remove", "--force", ${JSON.stringify(gatePath)}], { cwd: ${JSON.stringify(origin)} })
  out({ removed: true })
} else if (args[0] === "orchestration" && args[1] === "task-list") {
  out({ tasks: [] })
} else if (args[0] === "orchestration" && args[1] === "task-create") {
  out({ task: { id: "task-settlement" } })
} else if (args[0] === "orchestration" && args[1] === "task-update") {
  out({ task: { id: "task-settlement", status: "failed" } })
} else {
  out({ ok: true })
}
`,
  );
  await chmod(fakeOrca, 0o755);
  const dead = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(dead.pid !== undefined);
  return {
    fakeOrca,
    gate: { branch: gateName, id: gateId, kind: "orca" as const, path: gatePath },
    gateHead,
    marker: markerPath(origin, gateId),
    origin,
    pid: dead.pid,
    temp,
  };
}

async function writeStrandedMarker(
  seeded: Awaited<ReturnType<typeof seedStrandedGate>>,
  runId: string,
): Promise<void> {
  await mkdir(path.dirname(seeded.marker), { recursive: true });
  await writeFile(
    seeded.marker,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      gate: seeded.gate,
      originWorktree: seeded.origin,
      pid: seeded.pid,
      runId,
    }),
  );
}

async function pruneCrashRemnant(
  prefix: string,
  runId: string,
  seedLedger: (ledger: DomainLedger, origin: string) => void,
  expectReaped = true,
): Promise<string | undefined> {
  const seeded = await seedStrandedGate(prefix);
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousOrca = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(seeded.temp, "home");
  process.env.ORCA_CLI_COMMAND = seeded.fakeOrca;
  let status: string | undefined;
  try {
    const ledger = new DomainLedger();
    seedLedger(ledger, seeded.origin);
    ledger.close();
    await writeStrandedMarker(seeded, runId);

    await main(["prune", "--stranded", "--repo", seeded.origin]);

    assert.equal(existsSync(seeded.gate.path), !expectReaped);
    assert.equal(
      git(seeded.origin, "branch", "--list", seeded.gate.branch) !== "",
      !expectReaped,
    );
    assert.equal(existsSync(seeded.marker), !expectReaped);
    if (expectReaped) {
      assert.equal(
        git(
          seeded.origin,
          "rev-parse",
          `refs/no-mistakes/recover/${runId}`,
        ),
        seeded.gateHead,
      );
    }
    const reopened = new DomainLedger();
    status = reopened.runStatus(runId);
    reopened.close();
  } finally {
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    restoreEnv("ORCA_CLI_COMMAND", previousOrca);
    await rm(seeded.temp, { force: true, recursive: true });
  }
  return status;
}

test("stranded prune reaps a marker whose ledger row was never started", async () => {
  await pruneCrashRemnant("onm-before-start-run-", "run-before-start", () => {});
});

test("stranded prune retains an in-progress run whose lease was never acquired", async () => {
  const runId = "run-before-lease";
  assert.equal(
    await pruneCrashRemnant(
      "onm-before-acquire-lease-",
      runId,
      (ledger, origin) => {
        ledger.startRun({
          baseBranch: "feature",
          branch: "feature",
          intent: "lease crash",
          policySha256: "f".repeat(64),
          repoRoot: origin,
          runId,
          submissionCommitOid: A,
        });
      },
      false,
    ),
    "in-progress",
  );
});
