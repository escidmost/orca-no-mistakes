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
  releaseWorker,
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

async function deadPid(): Promise<number> {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

async function seed(prefix: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const repo = path.join(temp, "repo");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  return { repo: await realpath(repo), temp };
}

function setEnv(home: string, orcaCommand: string): () => void {
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousOrca = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  process.env.ORCA_CLI_COMMAND = orcaCommand;
  return () => {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    if (previousOrca === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousOrca;
  };
}

test("worker allocation and release update the durable gate marker", async () => {
  const seeded = await seed("onm-worker-marker-");
  const gate = {
    branch: "gate",
    id: `repo::${path.join(seeded.temp, "gate")}`,
    kind: "orca" as const,
    path: path.join(seeded.temp, "gate"),
  };
  const marker = markerPath(seeded.repo, gate.id);
  const worker: WorkerResult = {
    dispatchId: "dispatch-durable",
    report: { findings: [], summary: "active" },
    taskId: "task-durable",
    terminalHandle: "term-durable",
    worktreeBranch: "worker-durable",
    worktreeId: `repo::${path.join(seeded.temp, "worker")}`,
    worktreePath: path.join(seeded.temp, "worker"),
  };
  const orca = {
    async finishWorker() {},
    async removeWorktree() {},
    async startWorker(_taskId: string, _launch: unknown, _fence: unknown, onAllocated: ((worker: WorkerResult) => { ready: Promise<void> }) | undefined) {
      const registration = onAllocated?.(worker);
      await registration?.ready;
      const persisted = JSON.parse(await readFile(marker, "utf8")) as {
        workers?: Array<{ dispatchId: string }>;
      };
      assert.deepEqual(persisted.workers?.map(({ dispatchId }) => dispatchId), [
        worker.dispatchId,
      ]);
      return worker;
    },
  } as unknown as OrcaOperations;
  try {
    await installAbortReaping({
      gate,
      originWorktree: seeded.repo,
      pid: process.pid,
      runId: "run-durable-worker",
    });
    const outcome = await startWorkerWithFallback(
      orca,
      async () => worker.taskId,
      [
        {
          name: "durable",
          prompt: "work",
          role: "reviewer",
          stage: "review",
          worktree: "new-child",
        },
      ],
    );
    await releaseWorker(outcome.worker, orca);
    const released = JSON.parse(await readFile(marker, "utf8")) as {
      workers?: unknown[];
    };
    assert.equal(released.workers, undefined);
  } finally {
    await installAbortReaping({ pid: process.pid });
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("stranded launcher rediscovers tagged terminal and run receipts", async () => {
  const seeded = await seed("onm-launcher-discovery-");
  const root = path.join(seeded.temp, "runs");
  const home = path.join(seeded.temp, "home");
  const launcherId = "launcher-discovery";
  const terminalTitle = `no-mistakes-launcher-${launcherId}`;
  const runObjective = `[no-mistakes-launcher:${launcherId}] intent`;
  const marker = markerPath(
    seeded.repo,
    `configured-launcher:${launcherId}`,
  );
  await mkdir(root);
  await writeFile(
    marker,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      kind: "configured-launcher",
      launcherId,
      originWorktree: seeded.repo,
      pid: await deadPid(),
      root,
      runObjective,
      terminalTitle,
    }),
  );
  const calls = path.join(seeded.temp, "calls.jsonl");
  const command = path.join(seeded.temp, "orca");
  await writeFile(
    command,
    `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "terminal" && args[1] === "list") out({ terminals: [{ handle: "term-discovered", title: ${JSON.stringify(terminalTitle)} }] })
else if (args[0] === "orchestration" && args[1] === "run-list") out({ runs: [{ id: "run-discovered", objective: ${JSON.stringify(runObjective)} }], nextCursor: null })
else if (args[0] === "orchestration" && args[1] === "task-list") out({ tasks: [{ id: "task-discovered", status: "in_progress" }] })
else if (args[0] === "orchestration" && args[1] === "task-update") out({ task: { id: "task-discovered", status: "failed" } })
else if (args[0] === "terminal" && args[1] === "close") out({ closed: true })
else { console.error(JSON.stringify({ error: { code: "unexpected" } })); process.exit(1) }
`,
  );
  await chmod(command, 0o755);
  const restore = setEnv(home, command);
  try {
    await main(["prune", "--stranded", "--repo", seeded.repo]);
    assert.equal(existsSync(marker), false);
    const recorded = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      recorded.some(
        (args) => args[0] === "orchestration" && args[1] === "task-update",
      ),
      true,
    );
    assert.equal(
      recorded.some(
        (args) => args[0] === "terminal" && args[1] === "close",
      ),
      true,
    );
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("stranded prune removes an unowned branch at the recovery OID", async () => {
  const seeded = await seed("onm-branch-retry-");
  const home = path.join(seeded.temp, "home");
  const gatePath = path.join(seeded.temp, "gate");
  git(seeded.repo, "worktree", "add", "-b", "gate", gatePath);
  const canonicalGate = await realpath(gatePath);
  const gate = {
    branch: "gate",
    id: `repo::${canonicalGate}`,
    kind: "orca" as const,
    path: canonicalGate,
  };
  const runId = "run-branch-retry";
  const head = git(seeded.repo, "rev-parse", "HEAD");
  git(seeded.repo, "update-ref", `refs/no-mistakes/recover/${runId}`, head);
  git(seeded.repo, "worktree", "remove", gatePath);
  const marker = markerPath(seeded.repo, gate.id);
  await writeFile(
    marker,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      gate,
      originWorktree: seeded.repo,
      pid: await deadPid(),
      runId,
    }),
  );
  const restore = setEnv(home, path.join(seeded.temp, "orca"));
  const ledger = new DomainLedger();
  try {
    ledger.startRun({
      baseBranch: "main",
      branch: "main",
      intent: "retry cleanup",
      policySha256: "policy",
      repoRoot: seeded.repo,
      runId,
      submissionCommitOid: head,
    });
    ledger.acquireLease({ branch: "main", repoRoot: seeded.repo, runId });
    assert.equal(
      ledger.settleRun(runId, "cancelled", {
        branch: "main",
        repoRoot: seeded.repo,
      }),
      true,
    );
  } finally {
    ledger.close();
  }
  await writeFile(
    path.join(seeded.temp, "orca"),
    `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === "worktree" && args[1] === "list") console.log(JSON.stringify({ result: { worktrees: [{ id: "repo::${seeded.repo}", path: ${JSON.stringify(seeded.repo)}, branch: "refs/heads/main", head: ${JSON.stringify(head)} }] } }))
else if (args[0] === "orchestration" && args[1] === "task-list") console.log(JSON.stringify({ result: { tasks: [{ id: "task-settlement", status: "in_progress" }] } }))
else if (args[0] === "orchestration" && args[1] === "task-update") console.log(JSON.stringify({ result: { task: { id: "task-settlement", status: "failed" } } }))
else { console.error(JSON.stringify({ error: { code: "unexpected" } })); process.exit(1) }
`,
  );
  await chmod(path.join(seeded.temp, "orca"), 0o755);
  try {
    await main(["prune", "--stranded", "--repo", seeded.repo]);
    assert.equal(existsSync(marker), false);
    assert.equal(git(seeded.repo, "branch", "--list", "gate"), "");
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});
