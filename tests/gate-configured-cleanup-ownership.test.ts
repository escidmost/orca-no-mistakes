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

async function addGate(
  seeded: Awaited<ReturnType<typeof seed>>,
  runId: string,
) {
  const gate = {
    branch: `no-mistakes-gate-${runId}`,
    intentTaskId: "task-intent",
    kind: "configured" as const,
    path: path.join(seeded.root, runId),
    root: seeded.root,
    runId,
  };
  git(
    seeded.repo,
    "worktree",
    "add",
    "-b",
    gate.branch,
    gate.path,
    git(seeded.repo, "rev-parse", "HEAD"),
  );
  return gate;
}

function markerPath(origin: string, identity: string): string {
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 32);
  return path.join(origin, ".orca", "no-mistakes", `gate-${digest}.json`);
}

async function fakeOrca(temp: string) {
  const calls = path.join(temp, "calls.jsonl");
  const command = path.join(temp, "orca");
  const closeState = path.join(temp, "close-state");
  const capture = path.join(temp, "capture.json");
  await writeFile(closeState, "close");
  await writeFile(
    command,
    `#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "terminal" && args[1] === "create" && process.env.ONM_CAPTURE_MARKER) {
  const dir = path.join(process.cwd(), ".orca", "no-mistakes")
  const name = fs.readdirSync(dir).find((entry) => entry.startsWith("gate-") && entry.endsWith(".json"))
  fs.writeFileSync(${JSON.stringify(capture)}, fs.readFileSync(path.join(dir, name), "utf8"))
  console.error("terminal allocation stopped")
  process.exit(1)
} else if (args[0] === "terminal" && args[1] === "close" && fs.readFileSync(${JSON.stringify(closeState)}, "utf8") === "fail") {
  console.log(JSON.stringify({ ok: false, error: { code: "temporary_failure" } }))
  process.exit(1)
} else if (args[0] === "terminal" && args[1] === "show") {
  out({ terminal: { connected: true, handle: "term-configured" } })
} else if (args[0] === "terminal" && args[1] === "create") {
  out({ terminal: { handle: "term-configured" } })
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
  return { calls, capture, closeState, command };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("configured launch is discoverable before its first allocation", async () => {
  const seeded = await seed("onm-configured-launcher-marker-");
  const fake = await fakeOrca(seeded.temp);
  const config = path.join(seeded.temp, "config.json");
  const previousCapture = process.env.ONM_CAPTURE_MARKER;
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousConfig = process.env.ORCA_NO_MISTAKES_USER_CONFIG;
  try {
    await writeFile(
      config,
      JSON.stringify({ worktree_roots: { [seeded.repo]: seeded.root } }),
    );
    process.env.ONM_CAPTURE_MARKER = "1";
    process.env.ORCA_CLI_COMMAND = fake.command;
    process.env.ORCA_NO_MISTAKES_USER_CONFIG = config;
    await assert.rejects(
      main([
        "run",
        `--repo=${seeded.repo}`,
        "--base=main",
        "--intent=Stop before allocation.",
      ]),
      /terminal allocation stopped/,
    );
    const marker = JSON.parse(await readFile(fake.capture, "utf8")) as {
      kind: string;
      originWorktree: string;
      root: string;
    };
    assert.deepEqual(
      { kind: marker.kind, originWorktree: marker.originWorktree, root: marker.root },
      {
        kind: "configured-launcher",
        originWorktree: seeded.repo,
        root: seeded.root,
      },
    );
    const markerDirectory = path.join(seeded.repo, ".orca", "no-mistakes");
    const [pendingMarker] = (await readdir(markerDirectory)).filter((name) =>
      name.endsWith(".json"),
    );
    assert.ok(pendingMarker);
    assert.equal(
      (JSON.parse(
        await readFile(path.join(markerDirectory, pendingMarker), "utf8"),
      ) as { allocationPending?: boolean }).allocationPending,
      true,
    );
  } finally {
    restoreEnv("ONM_CAPTURE_MARKER", previousCapture);
    restoreEnv("ORCA_CLI_COMMAND", previousCommand);
    restoreEnv("ORCA_NO_MISTAKES_USER_CONFIG", previousConfig);
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("configured abort retains a replacement worktree at the recorded path", async () => {
  const seeded = await seed("onm-configured-owner-race-");
  const gate = await addGate(seeded, "run-owner");
  const fake = await fakeOrca(seeded.temp);
  const ledger = new DomainLedger(":memory:");
  try {
    await installAbortReaping({
      deliveryGit: new GitShell({ repo: seeded.repo }),
      gate,
      git: new GitShell({ repo: gate.path }),
      ledger,
      orca: new CliOrca({ command: fake.command, cwd: seeded.repo, runId: gate.runId }),
      orcaCommand: fake.command,
      originWorktree: seeded.repo,
      runId: gate.runId,
      terminalHandle: "term-configured",
    });
    git(seeded.repo, "worktree", "remove", gate.path);
    git(seeded.repo, "branch", "-D", gate.branch);
    git(seeded.repo, "worktree", "add", "-b", "replacement", gate.path, "HEAD");

    await reapAbortedRun("replacement owner race");

    assert.equal(existsSync(gate.path), true);
    assert.equal(git(gate.path, "branch", "--show-current"), "replacement");
    assert.equal(existsSync(markerPath(seeded.repo, gate.path)), true);
  } finally {
    ledger.close();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("configured terminal closure retries from a cleanup-pending marker", async () => {
  const seeded = await seed("onm-configured-close-retry-");
  const gate = await addGate(seeded, "run-close");
  const fake = await fakeOrca(seeded.temp);
  const ledger = new DomainLedger(":memory:");
  const marker = markerPath(seeded.repo, gate.path);
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  try {
    await writeFile(fake.closeState, "fail");
    await installAbortReaping({
      deliveryGit: new GitShell({ repo: seeded.repo }),
      gate,
      git: new GitShell({ repo: gate.path }),
      ledger,
      orca: new CliOrca({ command: fake.command, cwd: seeded.repo, runId: gate.runId }),
      orcaCommand: fake.command,
      originWorktree: seeded.repo,
      runId: gate.runId,
      terminalHandle: "term-configured",
    });
    await reapAbortedRun("transient terminal close failure");
    assert.equal(existsSync(gate.path), false);
    assert.equal(existsSync(marker), true);
    assert.equal(
      (JSON.parse(await readFile(marker, "utf8")) as { cleanupPending?: boolean })
        .cleanupPending,
      true,
    );

    await writeFile(fake.closeState, "close");
    process.env.ORCA_CLI_COMMAND = fake.command;
    process.env.ORCA_NO_MISTAKES_HOME = path.join(seeded.temp, "home");
    await main(["prune", "--stranded", `--repo=${seeded.repo}`]);
    assert.equal(existsSync(marker), false);
    const calls = (await readFile(fake.calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.filter((args) => args[0] === "terminal" && args[1] === "close")
        .length,
      2,
    );
  } finally {
    restoreEnv("ORCA_CLI_COMMAND", previousCommand);
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    ledger.close();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});
