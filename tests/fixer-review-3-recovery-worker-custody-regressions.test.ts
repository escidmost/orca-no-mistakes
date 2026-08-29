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

import { DomainLedger, main } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(origin: string, gatePath: string): string {
  const digest = createHash("sha256")
    .update(gatePath)
    .digest("hex")
    .slice(0, 32);
  return path.join(origin, ".orca", "no-mistakes", `gate-${digest}.json`);
}

async function deadPid(): Promise<number> {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

async function seed(prefix: string): Promise<{
  repo: string;
  root: string;
  temp: string;
}> {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const repo = path.join(temp, "repo");
  const root = path.join(temp, "runs");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await mkdir(root);
  git(repo, "-c", "init.templateDir=", "init", "-b", "feature");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  return {
    repo: await realpath(repo),
    root: await realpath(root),
    temp,
  };
}

async function writeOrcaStub(
  command: string,
  callsFile: string,
): Promise<void> {
  await writeFile(
    command,
    `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [] })
else if (args[0] === "terminal" && args[1] === "list") out({ terminals: [] })
else if (args[0] === "terminal" && args[1] === "close") out({ closed: true })
else if (args[0] === "orchestration" && args[1] === "task-list") out({ tasks: [{ id: "task-intent", status: "in_progress" }] })
else if (args[0] === "orchestration" && args[1] === "task-update") out({ task: { id: "task-intent", status: "failed" } })
else if (args[0] === "worktree" && args[1] === "rm") {
  console.log(JSON.stringify({ ok: false, error: { code: "busy" } }))
  process.exit(1)
} else {
  console.error(JSON.stringify({ error: { code: "unexpected", args } }))
  process.exit(1)
}
`,
  );
  await chmod(command, 0o755);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("absent configured gate requires recovery custody", async () => {
  const seeded = await seed("onm-configured-absent-recovery-");
  const home = path.join(seeded.temp, "home");
  const command = path.join(seeded.temp, "orca");
  const callsFile = path.join(seeded.temp, "calls.jsonl");
  const runId = "run-absent-recovery";
  const gatePath = path.join(seeded.root, runId);
  const marker = markerPath(seeded.repo, gatePath);
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  try {
    await writeFile(
      marker,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate: {
          branch: `no-mistakes-gate-${runId}`,
          intentTaskId: "task-intent",
          kind: "configured",
          path: gatePath,
          root: seeded.root,
          runId,
        },
        originWorktree: seeded.repo,
        pid: await deadPid(),
        runId,
      }),
    );
    const ledger = new DomainLedger(path.join(home, "ledger.db"));
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "absent recovery custody",
      policySha256: "policy",
      repoRoot: seeded.repo,
      runId,
      submissionCommitOid: git(seeded.repo, "rev-parse", "HEAD"),
    });
    ledger.acquireLease({ branch: "feature", repoRoot: seeded.repo, runId });
    ledger.close();
    await writeOrcaStub(command, callsFile);
    process.env.ORCA_CLI_COMMAND = command;
    process.env.ORCA_NO_MISTAKES_HOME = home;

    await main(["prune", "--stranded", "--repo", seeded.repo]);

    const retained = new DomainLedger(path.join(home, "ledger.db"));
    try {
      assert.equal(existsSync(marker), true);
      assert.equal(retained.runIdentity(runId)?.status, "in-progress");
      assert.equal(retained.leaseFor(seeded.repo, "feature")?.run_id, runId);
    } finally {
      retained.close();
    }
  } finally {
    restoreEnv("ORCA_CLI_COMMAND", previousCommand);
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("configured resume cleanup separates orchestration and domain run IDs", async () => {
  const seeded = await seed("onm-configured-resume-identities-");
  const home = path.join(seeded.temp, "home");
  const command = path.join(seeded.temp, "orca");
  const callsFile = path.join(seeded.temp, "calls.jsonl");
  const orchestrationRunId = "run-resume-orchestration";
  const domainRunId = "run-resume-domain";
  const gatePath = path.join(seeded.root, orchestrationRunId);
  const marker = markerPath(seeded.repo, gatePath);
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  try {
    await writeFile(
      marker,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        domainRunId,
        gate: {
          branch: `no-mistakes-gate-${orchestrationRunId}`,
          intentTaskId: "task-intent",
          kind: "configured",
          path: gatePath,
          root: seeded.root,
          runId: orchestrationRunId,
        },
        originWorktree: seeded.repo,
        pid: await deadPid(),
        runId: orchestrationRunId,
      }),
    );
    const head = git(seeded.repo, "rev-parse", "HEAD");
    git(
      seeded.repo,
      "update-ref",
      `refs/no-mistakes/recover/${domainRunId}`,
      head,
    );
    const ledger = new DomainLedger(path.join(home, "ledger.db"));
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "separate configured resume identities",
      policySha256: "policy",
      repoRoot: seeded.repo,
      runId: domainRunId,
      submissionCommitOid: head,
    });
    ledger.acquireLease({ branch: "feature", repoRoot: seeded.repo, runId: domainRunId });
    ledger.close();
    await writeOrcaStub(command, callsFile);
    process.env.ORCA_CLI_COMMAND = command;
    process.env.ORCA_NO_MISTAKES_HOME = home;

    await main(["prune", "--stranded", "--repo", seeded.repo]);

    const reaped = new DomainLedger(path.join(home, "ledger.db"));
    try {
      assert.equal(existsSync(marker), false);
      assert.equal(reaped.runIdentity(domainRunId)?.status, "cancelled");
      assert.equal(reaped.leaseFor(seeded.repo, "feature"), undefined);
    } finally {
      reaped.close();
    }
    const calls = (await readFile(callsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(calls.some((args) => args.includes(orchestrationRunId)));
    assert.equal(calls.some((args) => args.includes(domainRunId)), false);
  } finally {
    restoreEnv("ORCA_CLI_COMMAND", previousCommand);
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("stranded cleanup retains an unowned worker terminal", async () => {
  const seeded = await seed("onm-unowned-worker-terminal-");
  const home = path.join(seeded.temp, "home");
  const command = path.join(seeded.temp, "orca");
  const callsFile = path.join(seeded.temp, "calls.jsonl");
  const runId = "run-unowned-terminal";
  const gate = {
    branch: `no-mistakes-gate-${runId}`,
    intentTaskId: "task-intent",
    kind: "configured" as const,
    path: path.join(seeded.root, runId),
    root: seeded.root,
    runId,
  };
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  try {
    git(seeded.repo, "worktree", "add", "-b", gate.branch, gate.path, "HEAD");
    gate.path = await realpath(gate.path);
    const marker = markerPath(seeded.repo, gate.path);
    await writeFile(
      marker,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate,
        originWorktree: seeded.repo,
        pid: await deadPid(),
        runId,
        workers: [
          {
            dispatchId: "dispatch-unowned",
            taskId: "task-worker",
            terminalHandle: "term-unrelated",
          },
        ],
      }),
    );
    await writeOrcaStub(command, callsFile);
    process.env.ORCA_CLI_COMMAND = command;
    process.env.ORCA_NO_MISTAKES_HOME = home;

    await main(["prune", "--stranded", "--repo", seeded.repo]);

    const retained = JSON.parse(await readFile(marker, "utf8")) as {
      workers?: Array<{ terminalHandle?: string }>;
    };
    const calls = (await readFile(callsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(retained.workers?.[0]?.terminalHandle, "term-unrelated");
    assert.equal(
      calls.some(
        (args) =>
          args[0] === "terminal" &&
          args[1] === "close" &&
          args.includes("term-unrelated"),
      ),
      false,
    );
    assert.equal(existsSync(gate.path), true);
  } finally {
    restoreEnv("ORCA_CLI_COMMAND", previousCommand);
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    await rm(seeded.temp, { force: true, recursive: true });
  }
});
