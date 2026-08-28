import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CliOrca,
  DomainLedger,
  GitShell,
  installAbortReaping,
  reapAbortedRun,
  registerAbortRunContext,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fakeOrca(
  temp: string,
  tasks: { id: string; status: string }[],
) {
  const calls = path.join(temp, "calls.jsonl");
  const failed = path.join(temp, "failed");
  const command = path.join(temp, "orca");
  await writeFile(
    command,
    `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
const initial = ${JSON.stringify(tasks)}
const failed = ${JSON.stringify(failed)}
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "orchestration" && args[1] === "task-list") {
  out({ tasks: fs.existsSync(failed)
    ? [...initial, { id: "task-settlement", status: "failed" }]
    : initial })
} else if (args[0] === "orchestration" && args[1] === "task-create") {
  out({ task: { id: "task-settlement" } })
} else if (args[0] === "orchestration" && args[1] === "task-update") {
  fs.writeFileSync(failed, "failed")
  out({ task: { id: args[args.indexOf("--id") + 1], status: "failed" } })
} else {
  process.exitCode = 1
}
`,
  );
  await chmod(command, 0o755);
  return { calls, command };
}

async function operations(calls: string): Promise<string[]> {
  return (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as string[]).slice(0, 2).join(" "));
}

test("all-completed runs receive exactly one failed settlement task", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-completed-settlement-"));
  try {
    const fake = await fakeOrca(temp, [
      { id: "task-stage-1", status: "completed" },
      { id: "task-stage-2", status: "completed" },
    ]);
    const orca = new CliOrca({
      command: fake.command,
      cwd: temp,
      runId: "run-completed",
    });

    await orca.failRun("cleanup failed");
    await orca.failRun("cleanup retry");

    assert.deepEqual(await operations(fake.calls), [
      "orchestration task-list",
      "orchestration task-create",
      "orchestration task-update",
      "orchestration task-list",
    ]);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test("abort settles external tasks after the ledger already failed", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-terminal-abort-settlement-"));
  const repo = path.join(temp, "repo");
  execFileSync("git", ["-c", "init.templateDir=", "init", "-b", "feature", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  const root = await realpath(repo);
  const head = git(root, "rev-parse", "HEAD");
  const runId = "run-failed-before-abort";
  const ledger = new DomainLedger(":memory:");
  try {
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "settle terminal abort",
      policySha256: "a".repeat(64),
      repoRoot: root,
      runId,
      submissionCommitOid: head,
    });
    assert.equal(ledger.finishRun(runId, "failed", head), true);
    const fake = await fakeOrca(temp, [
      { id: "task-open", status: "in_progress" },
    ]);
    const gitShell = new GitShell({ repo: root });
    await installAbortReaping({
      ledger,
      orca: new CliOrca({ command: fake.command, cwd: root, runId }),
      orcaCommand: fake.command,
      pid: process.pid,
    });
    await registerAbortRunContext({
      deliveryGit: gitShell,
      git: gitShell,
      ledger,
      runId,
    });

    await reapAbortedRun("signal after local failure");

    assert.deepEqual(await operations(fake.calls), [
      "orchestration task-list",
      "orchestration task-update",
    ]);
    assert.equal(ledger.runStatus(runId), "failed");
  } finally {
    ledger.close();
    await rm(temp, { force: true, recursive: true });
  }
});
