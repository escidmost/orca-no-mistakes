import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  GitShell,
  installAbortReaping,
  reapAbortedRun,
  startWorkerWithFallback,
  type OrcaOperations,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(origin: string, identity: string): string {
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 32);
  return path.join(origin, ".orca", "no-mistakes", `gate-${digest}.json`);
}

test("gate removal retains custody when worker worktree cleanup fails", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-worker-custody-"));
  const origin = path.join(temp, "repo");
  await mkdir(path.join(origin, ".orca", "no-mistakes"), {
    recursive: true,
  });
  git(origin, "-c", "init.templateDir=", "init", "-b", "main");
  git(origin, "config", "user.email", "test@example.com");
  git(origin, "config", "user.name", "Test User");
  git(origin, "commit", "--allow-empty", "-m", "seed");
  const head = git(origin, "rev-parse", "HEAD");
  const root = path.join(temp, "configured");
  await mkdir(root);
  const runId = "run-worker-custody";
  const gateBranch = `no-mistakes-gate-${runId}`;
  const gatePath = path.join(root, runId);
  git(origin, "worktree", "add", "-b", gateBranch, gatePath);
  const workerBranch = "worker-custody";
  const workerPath = path.join(temp, workerBranch);
  git(origin, "worktree", "add", "-b", workerBranch, workerPath);
  const gate = {
    branch: gateBranch,
    intentTaskId: "intent-worker-custody",
    kind: "configured" as const,
    path: await realpath(gatePath),
    root: await realpath(root),
    runId,
  };
  const worker: WorkerResult = {
    dispatchId: "dispatch-worker-custody",
    report: { findings: [], summary: "active", tested: [] },
    taskId: "task-worker-custody",
    worktreeBranch: workerBranch,
    worktreeId: `repo::${workerPath}`,
    worktreePath: workerPath,
  };
  const orca = {
    async finishWorker() {},
    async removeWorktree() {
      throw new Error("worker worktree removal failed");
    },
    async startWorker(
      _taskId: string,
      _launch: unknown,
      _fence: unknown,
      onAllocated: ((worker: WorkerResult) => { ready?: Promise<void> }) | undefined,
    ) {
      const registration = onAllocated?.(worker);
      await registration?.ready;
      return worker;
    },
  } as unknown as OrcaOperations;
  const ledger = new DomainLedger(path.join(temp, "ledger.sqlite"));
  try {
    ledger.startRun({
      baseBranch: "main",
      branch: "main",
      intent: "retain worker custody",
      policySha256: "f".repeat(64),
      repoRoot: origin,
      runId,
      submissionCommitOid: head,
    });
    await installAbortReaping({
      deliveryGit: new GitShell({ repo: origin }),
      gate,
      git: new GitShell({ repo: gate.path }),
      ledger,
      orca,
      orcaCommand: process.execPath,
      originWorktree: origin,
      pid: process.pid,
      runId,
    });
    await startWorkerWithFallback(
      orca,
      async () => worker.taskId,
      [
        {
          commitOid: head,
          name: "worker-custody",
          prompt: "work",
          role: "reviewer",
          stage: "review",
          worktree: "new-child",
        },
      ],
    );

    await reapAbortedRun("worker cleanup failed");

    assert.equal(existsSync(gate.path), true);
    assert.equal(existsSync(workerPath), true);
    assert.equal(
      git(origin, "rev-parse", `refs/heads/${gateBranch}`),
      head,
    );
    const marker = JSON.parse(
      await readFile(markerPath(origin, gate.path), "utf8"),
    ) as { workers?: Array<{ dispatchId: string }> };
    assert.deepEqual(marker.workers?.map(({ dispatchId }) => dispatchId), [
      worker.dispatchId,
    ]);
  } finally {
    ledger.close();
    await installAbortReaping({ pid: process.pid });
    if (existsSync(workerPath))
      git(origin, "worktree", "remove", "--force", workerPath);
    if (existsSync(gatePath))
      git(origin, "worktree", "remove", "--force", gatePath);
    await rm(temp, { force: true, recursive: true });
  }
});
