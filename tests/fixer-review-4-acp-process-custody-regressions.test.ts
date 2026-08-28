import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
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
  CliOrca,
  DomainLedger,
  installAbortReaping,
  main,
  releaseWorker,
  startWorkerWithFallback,
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

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

async function seed(prefix: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const repo = path.join(temp, "repo");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  git(repo, "-c", "init.templateDir=", "init", "-b", "feature");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  return { repo: await realpath(repo), temp };
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !existsSync(file); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(file), true);
}

function setEnv(home: string, command: string): () => void {
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousOrca = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  process.env.ORCA_CLI_COMMAND = command;
  return () => {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    if (previousOrca === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousOrca;
  };
}

test("ACP workers publish durable running and exited receipts", async () => {
  const seeded = await seed("onm-acp-process-receipt-");
  const gatePath = path.join(seeded.temp, "gate");
  git(seeded.repo, "worktree", "add", "-b", "gate", gatePath);
  const gate = await realpath(gatePath);
  const gateId = `repo::${gate}`;
  const marker = markerPath(seeded.repo, gateId);
  const pidFile = path.join(seeded.temp, "acpx.pid");
  const releaseFile = path.join(seeded.temp, "release");
  const acpx = path.join(seeded.temp, "acpx");
  await writeFile(
    acpx,
    `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(releaseFile)})) return
  clearInterval(timer)
  console.log(JSON.stringify({ findings: [], summary: "done", tested: [] }))
}, 10)
process.stdin.resume()
`,
  );
  await chmod(acpx, 0o755);
  const orca = new CliOrca({ acpxCommand: acpx, command: "/usr/bin/false", cwd: gate });
  let running: ReturnType<typeof startWorkerWithFallback> | undefined;
  try {
    await installAbortReaping({
      gate: { branch: "gate", id: gateId, kind: "orca", path: gate },
      originWorktree: seeded.repo,
      pid: process.pid,
      runId: "run-acp-process-receipt",
    });
    running = startWorkerWithFallback(
      orca,
      async () => "task-acp",
      [
        {
          agent: { harness: "acp:test" },
          name: "acp",
          prompt: "work",
          role: "reviewer",
          stage: "review",
          worktree: "current",
        },
      ],
    );
    await waitForFile(pidFile);
    const pid = Number(await readFile(pidFile, "utf8"));
    const active = JSON.parse(await readFile(marker, "utf8")) as {
      workers?: Array<{ processReceipt?: unknown }>;
    };
    assert.deepEqual(active.workers?.[0]?.processReceipt, {
      pid,
      protocol: "gated-v1",
      state: "running",
    });

    await writeFile(releaseFile, "go");
    const outcome = await running;
    const exited = JSON.parse(await readFile(marker, "utf8")) as {
      workers?: Array<{ processReceipt?: unknown }>;
    };
    assert.deepEqual(exited.workers?.[0]?.processReceipt, {
      protocol: "gated-v1",
      state: "exited",
    });
    await releaseWorker(outcome.worker, orca);
  } finally {
    await writeFile(releaseFile, "go").catch(() => {});
    await running?.catch(() => {});
    await installAbortReaping({ pid: process.pid });
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("stranded cleanup waits for a receipted ACP process to exit", async () => {
  const seeded = await seed("onm-acp-stranded-process-");
  const gatePath = path.join(seeded.temp, "gate");
  const workerPath = path.join(seeded.temp, "worker");
  git(seeded.repo, "worktree", "add", "-b", "gate", gatePath);
  git(seeded.repo, "worktree", "add", "-b", "worker", workerPath);
  const gate = await realpath(gatePath);
  const worker = await realpath(workerPath);
  const gateId = `repo::${gate}`;
  const workerId = `repo::${worker}`;
  const runId = "run-acp-stranded-process";
  const dispatchId = "acp-stranded-process";
  const head = git(seeded.repo, "rev-parse", "HEAD");
  const marker = markerPath(seeded.repo, gateId);
  const command = path.join(seeded.temp, "orca");
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  assert.ok(live.pid !== undefined);
  await writeFile(
    marker,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      gate: { branch: "gate", id: gateId, kind: "orca", path: gate },
      originWorktree: seeded.repo,
      pid: deadPid(),
      runId,
      workers: [
        {
          dispatchId,
          processReceipt: {
            pid: live.pid,
            protocol: "gated-v1",
            state: "running",
          },
          taskId: "task-acp",
          worktreeBranch: "worker",
          worktreeId: workerId,
          worktreePath: worker,
        },
      ],
    }),
  );
  await writeFile(
    command,
    `#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [
  { id: ${JSON.stringify(`repo::${seeded.repo}`)}, path: ${JSON.stringify(seeded.repo)}, branch: "refs/heads/feature", head: ${JSON.stringify(head)} },
  ...(existsSync(${JSON.stringify(gate)}) ? [{ id: ${JSON.stringify(gateId)}, path: ${JSON.stringify(gate)}, branch: "refs/heads/gate", head: ${JSON.stringify(head)}, parentWorktreeId: ${JSON.stringify(`repo::${seeded.repo}`)} }] : []),
  ...(existsSync(${JSON.stringify(worker)}) ? [{ id: ${JSON.stringify(workerId)}, path: ${JSON.stringify(worker)}, branch: "refs/heads/worker", head: ${JSON.stringify(head)}, parentWorktreeId: ${JSON.stringify(gateId)} }] : [])
] })
else if (args[0] === "terminal" && args[1] === "list") out({ terminals: [] })
else if (args[0] === "worktree" && args[1] === "rm") {
  const target = args.includes("id:" + ${JSON.stringify(workerId)}) ? ${JSON.stringify(worker)} : ${JSON.stringify(gate)}
  execFileSync("git", ["worktree", "remove", "--force", target], { cwd: ${JSON.stringify(seeded.repo)} })
  out({ removed: true })
} else { console.error(JSON.stringify({ error: { code: "unexpected", args } })); process.exit(1) }
`,
  );
  await chmod(command, 0o755);
  const restore = setEnv(path.join(seeded.temp, "home"), command);
  const ledger = new DomainLedger();
  try {
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "ACP process custody",
      policySha256: "f".repeat(64),
      repoRoot: seeded.repo,
      runId,
      submissionCommitOid: head,
    });
    assert.equal(ledger.finishRun(runId, "passed", head), true);
    git(
      seeded.repo,
      "update-ref",
      `refs/no-mistakes/recover/${runId}`,
      head,
    );
    await main(["prune", "--stranded", "--repo", seeded.repo]);
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(worker), true);
    assert.equal(existsSync(gate), true);

    live.kill("SIGKILL");
    if (live.exitCode === null) await once(live, "exit");
    await main(["prune", "--stranded", "--repo", seeded.repo]);

    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(worker), false);
    assert.equal(existsSync(gate), false);
    assert.equal(git(seeded.repo, "branch", "--list", "worker"), "");
    assert.equal(git(seeded.repo, "branch", "--list", "gate"), "");
    const suffix = createHash("sha256")
      .update(dispatchId)
      .digest("hex")
      .slice(0, 16);
    assert.equal(
      git(
        seeded.repo,
        "rev-parse",
        `refs/no-mistakes/recover/${runId}-worker-${suffix}`,
      ),
      head,
    );
  } finally {
    ledger.close();
    restore();
    if (live.exitCode === null) live.kill("SIGKILL");
    await rm(seeded.temp, { force: true, recursive: true });
  }
});
