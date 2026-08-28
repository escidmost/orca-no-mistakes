import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
  await writeFile(path.join(repo, ".orca", "no-mistakes", ".gitkeep"), "");
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
  failFirstSettlement = false,
): Promise<{ calls: string; command: string }> {
  const calls = path.join(temp, "calls.jsonl");
  const failedSettlement = path.join(temp, "failed-settlement");
  const command = path.join(temp, "orca");
  await writeFile(
    command,
    `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "terminal" && args[1] === "show") {
  console.log(JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } }))
  process.exit(1)
} else if (args[0] === "terminal" && args[1] === "create") {
  out({ terminal: { handle: "term-configured" } })
} else if (args[0] === "orchestration" && args[1] === "run-create") {
  out({ run: { id: "run-launch" } })
} else if (args[0] === "orchestration" && args[1] === "task-create") {
  out({ task: { id: "task-intent" } })
} else if (args[0] === "orchestration" && args[1] === "task-list") {
  if (${JSON.stringify(failFirstSettlement)} && !fs.existsSync(${JSON.stringify(failedSettlement)})) {
    fs.writeFileSync(${JSON.stringify(failedSettlement)}, "failed")
    process.exit(1)
  }
  out({ tasks: [{ id: "task-intent", status: "in_progress" }] })
} else {
  out({ accepted: true })
}
`,
  );
  await chmod(command, 0o755);
  return { calls, command };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("a pre-run configured abort preserves and cleans every gate resource", async () => {
  const seeded = await seed("onm-configured-abort-");
  const gate = await addGate(seeded, "run-abort");
  const fake = await fakeOrca(seeded.temp);
  const ledger = new DomainLedger(":memory:");
  try {
    await installAbortReaping({
      deliveryGit: new GitShell({ repo: seeded.repo }),
      gate,
      git: new GitShell({ repo: gate.path }),
      ledger,
      orca: new CliOrca({
        command: fake.command,
        cwd: seeded.repo,
        runId: gate.runId,
      }),
      orcaCommand: fake.command,
      originWorktree: seeded.repo,
      runId: gate.runId,
      terminalHandle: "term-configured",
    });
    assert.equal(existsSync(markerPath(seeded.repo, gate.path)), true);

    await reapAbortedRun("pre-run configured abort");

    assert.equal(existsSync(gate.path), false);
    assert.equal(git(seeded.repo, "branch", "--list", gate.branch), "");
    assert.equal(existsSync(markerPath(seeded.repo, gate.path)), false);
    assert.equal(
      git(seeded.repo, "rev-parse", `refs/no-mistakes/recover/${gate.runId}`),
      git(seeded.repo, "rev-parse", "HEAD"),
    );
    const calls = (await readFile(fake.calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(
      calls.some((args) => args[0] === "terminal" && args[1] === "close"),
    );
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "orchestration" &&
          args[1] === "task-update" &&
          args[args.indexOf("--status") + 1] === "failed",
      ),
    );
  } finally {
    ledger.close();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("stranded configured gates retry graceful cleanup", async () => {
  const seeded = await seed("onm-configured-stranded-");
  const gate = await addGate(seeded, "run-stranded");
  const fake = await fakeOrca(seeded.temp);
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const marker = markerPath(seeded.repo, gate.path);
  try {
    await writeFile(path.join(gate.path, "dirty.txt"), "retain\n");
    await writeFile(
      marker,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate,
        originWorktree: seeded.repo,
        runId: gate.runId,
        terminalHandle: "term-configured",
      }),
    );
    process.env.ORCA_CLI_COMMAND = fake.command;
    process.env.ORCA_NO_MISTAKES_HOME = path.join(seeded.temp, "home");

    await main(["prune", "--stranded", `--repo=${seeded.repo}`]);
    assert.equal(existsSync(gate.path), true);
    assert.equal(existsSync(marker), true);

    await rm(path.join(gate.path, "dirty.txt"));
    await main(["prune", "--stranded", `--repo=${seeded.repo}`]);
    assert.equal(existsSync(gate.path), false);
    assert.equal(git(seeded.repo, "branch", "--list", gate.branch), "");
    assert.equal(existsSync(marker), false);
    assert.equal(
      git(seeded.repo, "rev-parse", `refs/no-mistakes/recover/${gate.runId}`),
      git(seeded.repo, "rev-parse", "HEAD"),
    );
    const calls = (await readFile(fake.calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "orchestration" &&
          args[1] === "task-update" &&
          args[args.indexOf("--status") + 1] === "failed",
      ),
    );
  } finally {
    restoreEnv("ORCA_CLI_COMMAND", previousCommand);
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("cancelled and failed configured runs retry task settlement", async (t) => {
  for (const initialStatus of ["in-progress", "failed"] as const) {
    await t.test(initialStatus, async () => {
      const seeded = await seed(`onm-configured-${initialStatus}-retry-`);
      const gate = await addGate(seeded, `run-${initialStatus}-retry`);
      const fake = await fakeOrca(seeded.temp, true);
      const previousCommand = process.env.ORCA_CLI_COMMAND;
      const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
      const marker = markerPath(seeded.repo, gate.path);
      try {
        process.env.ORCA_CLI_COMMAND = fake.command;
        process.env.ORCA_NO_MISTAKES_HOME = path.join(seeded.temp, "home");
        await writeFile(
          marker,
          JSON.stringify({
            createdAt: new Date().toISOString(),
            gate,
            originWorktree: seeded.repo,
            runId: gate.runId,
            terminalHandle: "term-configured",
          }),
        );
        const ledger = new DomainLedger();
        ledger.startRun({
          baseBranch: "main",
          branch: "feature",
          intent: "retry configured settlement",
          policySha256: "a".repeat(64),
          repoRoot: seeded.repo,
          runId: gate.runId,
          submissionCommitOid: git(seeded.repo, "rev-parse", "HEAD"),
        });
        ledger.acquireLease({
          branch: "feature",
          repoRoot: seeded.repo,
          runId: gate.runId,
        });
        if (initialStatus === "failed") ledger.settleRun(gate.runId, "failed");
        ledger.close();

        await main(["prune", "--stranded", `--repo=${seeded.repo}`]);
        assert.equal(existsSync(gate.path), true);
        assert.equal(existsSync(marker), true);
        const retained = new DomainLedger();
        assert.equal(
          retained.runStatus(gate.runId),
          initialStatus === "in-progress" ? "cancelled" : "failed",
        );
        retained.close();

        await main(["prune", "--stranded", `--repo=${seeded.repo}`]);
        assert.equal(existsSync(gate.path), false);
        assert.equal(existsSync(marker), false);
        const calls = (await readFile(fake.calls, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        assert.equal(
          calls.filter(
            (args) => args[0] === "orchestration" && args[1] === "task-list",
          ).length,
          2,
        );
        assert.equal(
          calls.filter(
            (args) => args[0] === "orchestration" && args[1] === "task-update",
          ).length,
          1,
        );
      } finally {
        restoreEnv("ORCA_CLI_COMMAND", previousCommand);
        restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
        await rm(seeded.temp, { force: true, recursive: true });
      }
    });
  }
});

test("a configured marker write failure precedes launcher allocations", async () => {
  const seeded = await seed("onm-configured-marker-failure-");
  const fake = await fakeOrca(seeded.temp);
  const config = path.join(seeded.temp, "config.json");
  const markerDirectory = path.join(seeded.repo, ".orca", "no-mistakes");
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousConfig = process.env.ORCA_NO_MISTAKES_USER_CONFIG;
  try {
    await writeFile(
      config,
      JSON.stringify({ worktree_roots: { [seeded.repo]: seeded.root } }),
    );
    await chmod(markerDirectory, 0o555);
    process.env.ORCA_CLI_COMMAND = fake.command;
    process.env.ORCA_NO_MISTAKES_USER_CONFIG = config;

    await assert.rejects(
      main([
        "run",
        `--repo=${seeded.repo}`,
        "--base=main",
        "--intent=Clean failed configured launch.",
      ]),
      /EACCES|permission denied/i,
    );

    assert.deepEqual(await readdir(seeded.root), []);
    assert.equal(
      git(seeded.repo, "branch", "--list", "no-mistakes-gate-*"),
      "",
    );
    assert.throws(() =>
      git(
        seeded.repo,
        "show-ref",
        "--verify",
        "--quiet",
        "refs/no-mistakes/recover/run-launch",
      ),
    );
    assert.equal(existsSync(fake.calls), false);
  } finally {
    await chmod(markerDirectory, 0o755).catch(() => {});
    restoreEnv("ORCA_CLI_COMMAND", previousCommand);
    restoreEnv("ORCA_NO_MISTAKES_USER_CONFIG", previousConfig);
    await rm(seeded.temp, { force: true, recursive: true });
  }
});
