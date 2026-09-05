import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  CliOrca,
  DomainLedger,
  GitShell,
  installAbortReaping,
  main,
  reapAbortedRun,
} from "../scripts/orca-no-mistakes.ts";

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

async function seed(prefix: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const origin = path.join(temp, "origin.git");
  const repo = path.join(temp, "repo");
  const root = path.join(temp, "runs");
  git(temp, "-c", "init.templateDir=", "init", "--bare", origin);
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await writeFile(path.join(repo, ".gitignore"), ".orca/no-mistakes/\n");
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "seed");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  git(temp, `--git-dir=${origin}`, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repo, "checkout", "-b", "feature");
  await mkdir(root);
  return { repo: await realpath(repo), root: await realpath(root), temp };
}

async function addGate(seeded: Awaited<ReturnType<typeof seed>>, runId: string) {
  const gatePath = path.join(seeded.root, runId);
  const branch = `no-mistakes-gate-${runId}`;
  git(
    seeded.repo,
    "worktree",
    "add",
    "-b",
    branch,
    gatePath,
    git(seeded.repo, "rev-parse", "HEAD"),
  );
  return {
    branch,
    intentTaskId: "task-intent",
    kind: "configured" as const,
    path: gatePath,
    root: seeded.root,
    runId,
  };
}

async function fakeOrca(
  temp: string,
  mode: "ok" | "both" | "message" | "wake",
): Promise<{ calls: string; command: string }> {
  const calls = path.join(temp, `calls-${mode}.jsonl`);
  const command = path.join(temp, `orca-${mode}`);
  await writeFile(
    command,
    `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "orchestration" && args[1] === "send") {
  if (${JSON.stringify(mode === "both" || mode === "wake")}) {
    console.error("orchestration send unreachable")
    process.exit(1)
  }
  out({ message: { id: "msg-delivered" } })
} else if (args[0] === "terminal" && args[1] === "send") {
  if (${JSON.stringify(mode === "both" || mode === "message")}) {
    console.error("terminal send unreachable")
    process.exit(1)
  }
  out({ accepted: true })
} else if (args[0] === "terminal" && args[1] === "show") {
  out({ terminal: { connected: true, handle: "term-configured" } })
} else if (args[0] === "orchestration" && args[1] === "run-create") {
  out({ run: { id: "run-launch" } })
} else if (args[0] === "orchestration" && args[1] === "task-create") {
  out({ task: { id: "task-intent" } })
} else if (args[0] === "orchestration" && args[1] === "task-list") {
  out({ tasks: [{ id: "task-intent", status: "in_progress" }] })
} else {
  out({ accepted: true })
}
`,
  );
  await chmod(command, 0o755);
  return { calls, command };
}

async function readCalls(calls: string): Promise<string[][]> {
  return (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const GATE_ENV_KEYS = [
  "NO_MISTAKES_DELIVERY_BRANCH",
  "NO_MISTAKES_GATE_BRANCH",
  "NO_MISTAKES_GATE_WORKTREE_ROOT",
  "NO_MISTAKES_ORIGIN_WORKTREE",
  "NO_MISTAKES_RUN_ID",
  "ORCA_CLI_COMMAND",
  "ORCA_NO_MISTAKES_HOME",
  "ORCA_TERMINAL_HANDLE",
] as const;

function snapshotEnv(): Map<string, string | undefined> {
  return new Map(GATE_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreSnapshot(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) restoreEnv(key, value);
}

test("total notification failure throws while one working transport resolves", async () => {
  const previousHandle = process.env.ORCA_TERMINAL_HANDLE;
  delete process.env.ORCA_TERMINAL_HANDLE;
  try {
    for (const mode of ["message", "wake"] as const) {
      const fake = await fakeOrca(
        await mkdtemp(path.join(tmpdir(), `onm-notify-boundary-${mode}-`)),
        mode,
      );
      try {
        const orca = new CliOrca({
          command: fake.command,
          cwd: path.dirname(fake.command),
          notifyHandle: "origin-term",
        });
        for (const outcome of ["passed", "failed", "cancelled"] as const) {
          await orca.notifyRunResult(outcome, `boundary probe ${outcome}`);
        }
      } finally {
        await rm(path.dirname(fake.command), { force: true, recursive: true });
      }
    }
    for (const outcome of ["passed", "failed", "cancelled"] as const) {
      const fake = await fakeOrca(
        await mkdtemp(path.join(tmpdir(), "onm-notify-boundary-both-")),
        "both",
      );
      try {
        const orca = new CliOrca({
          command: fake.command,
          cwd: path.dirname(fake.command),
          notifyHandle: "origin-term",
        });
        await assert.rejects(
          orca.notifyRunResult(outcome, `boundary probe ${outcome}`),
          new RegExp(
            `no-mistakes run ${outcome} notification could not be delivered`,
          ),
        );
      } finally {
        await rm(path.dirname(fake.command), { force: true, recursive: true });
      }
    }
  } finally {
    restoreEnv("ORCA_TERMINAL_HANDLE", previousHandle);
  }
});

for (const mode of ["both", "message"] as const) {
  test(`attached failed runs retain gate resources only when no transport delivers (${mode})`, async () => {
    const seeded = await seed(`onm-failed-deliver-${mode}-`);
    const gate = await addGate(seeded, `run-deliver-${mode}`);
    const fake = await fakeOrca(seeded.temp, mode);
    await writeFile(path.join(gate.path, "diverge.txt"), "diverge\n");
    git(gate.path, "add", ".");
    git(gate.path, "commit", "-m", "diverge");
    const snapshot = snapshotEnv();
    try {
      process.env.ORCA_CLI_COMMAND = fake.command;
      process.env.ORCA_NO_MISTAKES_HOME = path.join(seeded.temp, "home");
      process.env.ORCA_TERMINAL_HANDLE = "term-configured";
      process.env.NO_MISTAKES_GATE_BRANCH = gate.branch;
      process.env.NO_MISTAKES_ORIGIN_WORKTREE = seeded.repo;
      process.env.NO_MISTAKES_RUN_ID = gate.runId;
      process.env.NO_MISTAKES_GATE_WORKTREE_ROOT = gate.root;
      delete process.env.NO_MISTAKES_DELIVERY_BRANCH;

      await assert.rejects(
        main([
          "run",
          "--attached",
          `--repo=${gate.path}`,
          "--base=main",
          "--intent=Deliver the failed run outcome.",
          "--notify",
          "origin-term",
        ]),
        /gate worktree is not based on the initiating checkout/,
      );

      const calls = await readCalls(fake.calls);
      assert.ok(
        calls.some((args) => args[0] === "orchestration" && args[1] === "send"),
      );
      assert.ok(
        calls.some((args) => args[0] === "terminal" && args[1] === "send"),
      );
      const closed = calls.some(
        (args) => args[0] === "terminal" && args[1] === "close",
      );
      assert.equal(closed, mode === "message");
      assert.equal(existsSync(gate.path), mode === "both");
      assert.equal(
        git(seeded.repo, "branch", "--list", gate.branch) !== "",
        mode === "both",
      );
      assert.equal(
        existsSync(markerPath(seeded.repo, gate.path)),
        mode === "both",
      );
    } finally {
      restoreSnapshot(snapshot);
      await rm(seeded.temp, { force: true, recursive: true });
    }
  });
}

for (const mode of ["both", "ok"] as const) {
  test(`cancelled aborts retain gate resources only when no transport delivers (${mode})`, async () => {
    const seeded = await seed(`onm-cancel-deliver-${mode}-`);
    const gate = await addGate(seeded, `run-cancel-${mode}`);
    const fake = await fakeOrca(seeded.temp, mode);
    const ledger = new DomainLedger(":memory:");
    try {
      ledger.startRun({
        baseBranch: "main",
        branch: "feature",
        intent: "deliver the cancelled outcome",
        policySha256: "a".repeat(64),
        repoRoot: seeded.repo,
        runId: gate.runId,
        submissionCommitOid: git(seeded.repo, "rev-parse", "HEAD"),
      });
      const generationToken = ledger.acquireLease({
        branch: "feature",
        repoRoot: seeded.repo,
        runId: gate.runId,
      });
      const orca = new CliOrca({
        command: fake.command,
        cwd: seeded.repo,
        notifyHandle: "origin-term",
        runId: gate.runId,
      });
      await installAbortReaping({
        deliveryGit: new GitShell({ repo: seeded.repo }),
        gate,
        generationToken,
        git: new GitShell({ repo: gate.path }),
        ledger,
        notify: (summary) => orca.notifyRunResult("cancelled", summary),
        orca,
        orcaCommand: fake.command,
        originWorktree: seeded.repo,
        runId: gate.runId,
        terminalHandle: "term-configured",
      });

      await reapAbortedRun("cancel with unreachable origin");

      assert.equal(ledger.runStatus(gate.runId), "cancelled");
      const calls = await readCalls(fake.calls);
      assert.ok(
        calls.some((args) => args[0] === "orchestration" && args[1] === "send"),
      );
      assert.ok(
        calls.some((args) => args[0] === "terminal" && args[1] === "send"),
      );
      const closed = calls.some(
        (args) => args[0] === "terminal" && args[1] === "close",
      );
      assert.equal(closed, mode === "ok");
      assert.equal(existsSync(gate.path), mode === "both");
      assert.equal(
        git(seeded.repo, "branch", "--list", gate.branch) !== "",
        mode === "both",
      );
      assert.equal(
        existsSync(markerPath(seeded.repo, gate.path)),
        mode === "both",
      );
      assert.equal(
        git(
          seeded.repo,
          "rev-parse",
          `refs/no-mistakes/recover/${gate.runId}`,
        ) !== "",
        true,
      );
    } finally {
      ledger.close();
      await rm(seeded.temp, { force: true, recursive: true });
    }
  });
}
