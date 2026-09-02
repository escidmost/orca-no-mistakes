import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  RunSettlementError,
  installAbortReaping,
  main,
  runPipeline,
  type GitOperations,
  type OrcaOperations,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(repo: string, identity: string): string {
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 32);
  return path.join(repo, ".orca", "no-mistakes", `gate-${digest}.json`);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("cleanup-pending configured gates retain a live coordinator", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-live-cleanup-pending-"));
  const repo = path.join(temp, "repo");
  const root = path.join(temp, "runs");
  const command = path.join(temp, "orca");
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  try {
    await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
    await mkdir(root);
    git(repo, "-c", "init.templateDir=", "init", "-b", "feature");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "commit", "--allow-empty", "-m", "seed");
    const gate = {
      branch: "no-mistakes-gate-run-live",
      intentTaskId: "task-intent",
      kind: "configured" as const,
      path: path.join(root, "run-live"),
      root,
      runId: "run-live",
    };
    git(repo, "worktree", "add", "-b", gate.branch, gate.path, "HEAD");
    gate.path = await realpath(gate.path);
    const marker = markerPath(repo, gate.path);
    await writeFile(
      marker,
      JSON.stringify({
        cleanupPending: true,
        createdAt: new Date().toISOString(),
        gate,
        originWorktree: await realpath(repo),
        pid: process.pid,
        runId: gate.runId,
      }),
    );
    await writeFile(
      command,
      `#!/usr/bin/env node
const args = process.argv.slice(2)
const result = args[0] === "orchestration" && args[1] === "task-list"
  ? { tasks: [{ id: "task-intent", status: "in_progress" }] }
  : { accepted: true }
console.log(JSON.stringify({ result }))
`,
    );
    await chmod(command, 0o755);
    process.env.ORCA_CLI_COMMAND = command;
    process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");

    await main(["prune", "--stranded", "--repo", repo]);

    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(gate.path), true);
    assert.notEqual(git(repo, "branch", "--list", gate.branch), "");
  } finally {
    restoreEnv("ORCA_CLI_COMMAND", previousCommand);
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    await rm(temp, { force: true, recursive: true });
  }
});

class FailingSettlementLedger extends DomainLedger {
  override settleRun(
    ..._args: Parameters<DomainLedger["settleRun"]>
  ): boolean {
    throw new Error("injected settlement failure");
  }

  override settleRunWithAttemptOutcome(
    ..._args: Parameters<DomainLedger["settleRunWithAttemptOutcome"]>
  ): boolean {
    throw new Error("injected settlement failure");
  }
}

test("local settlement failure retains recovery custody", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-settlement-custody-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const runId = "run-settlement-failure";
  const head = "a".repeat(40);
  let anchored = false;
  const gitOperations = {
    async anchorRecoveryRef() {
      anchored = true;
    },
    async assertReady() {
      return {
        base: "main",
        baseOid: "b".repeat(40),
        branch: "feature",
        head,
        root: temp,
      };
    },
    async head() {
      return head;
    },
    async policySha256() {
      return "c".repeat(64);
    },
    async rebase() {
      throw new Error("injected pipeline failure");
    },
  } as unknown as GitOperations;
  let task = 0;
  const orca = {
    async completeTask() {},
    async createRun() {
      return runId;
    },
    async createTask() {
      return `task-${++task}`;
    },
    async setWorktreeStatus() {},
  } as unknown as OrcaOperations;
  const ledger = new FailingSettlementLedger(":memory:");
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");
  try {
    await assert.rejects(
      runPipeline(
        { allowLocalConfig: true, intent: "Retain failed settlement custody." },
        orca,
        gitOperations,
        ledger,
      ),
      (error) =>
        error instanceof RunSettlementError && error.outcome === "failed",
    );
    assert.equal(anchored, true);
    assert.equal(ledger.runStatus(runId), "in-progress");
    assert.equal(ledger.leaseFor(temp, "feature")?.run_id, runId);
  } finally {
    await installAbortReaping({ pid: process.pid });
    ledger.close();
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    await rm(temp, { force: true, recursive: true });
  }
});
