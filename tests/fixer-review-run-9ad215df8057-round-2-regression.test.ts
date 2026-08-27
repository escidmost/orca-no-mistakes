import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function seedRepo(temp: string): Promise<string> {
  const origin = path.join(temp, "origin.git");
  const repo = path.join(temp, "repo");
  git(temp, "-c", "init.templateDir=", "init", "--bare", origin);
  git(temp, "-c", "init.templateDir=", "init", "-b", "main", repo);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, "README.md"), "seed\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "seed");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  git(temp, `--git-dir=${origin}`, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repo, "checkout", "-b", "feature");
  return repo;
}

test("configured preflight failures settle the intent task", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-configured-preflight-"));
  const repo = await seedRepo(temp);
  const root = path.join(temp, "runs");
  const userConfig = path.join(temp, "config.json");
  const fakeOrca = path.join(temp, "orca");
  const callsPath = path.join(temp, "calls.jsonl");
  const environmentNames = [
    "NO_MISTAKES_DELIVERY_BRANCH",
    "NO_MISTAKES_GATE_BRANCH",
    "NO_MISTAKES_GATE_WORKTREE_ROOT",
    "NO_MISTAKES_INTENT_TASK_ID",
    "NO_MISTAKES_ORIGIN_WORKTREE",
    "NO_MISTAKES_RUN_ID",
    "ORCA_CLI_COMMAND",
    "ORCA_NO_MISTAKES_USER_CONFIG",
  ] as const;
  const previous = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  try {
    await mkdir(root);
    await writeFile(
      userConfig,
      JSON.stringify({ worktree_roots: { [await realpath(repo)]: root } }),
    );
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const result = args[0] === 'terminal' && args[1] === 'create'
  ? { terminal: { handle: 'configured-coordinator' } }
  : args[0] === 'terminal' && args[1] === 'show'
    ? { terminal: { connected: true, preview: 'ready' } }
    : args[0] === 'orchestration' && args[1] === 'run-create'
      ? { run: { id: 'configured-run' } }
      : args[0] === 'orchestration' && args[1] === 'task-create'
        ? { task: { id: 'task-intent' } }
        : { accepted: true }
console.log(JSON.stringify({ result }))
`,
    );
    await chmod(fakeOrca, 0o755);
    process.env.ORCA_CLI_COMMAND = fakeOrca;
    process.env.ORCA_NO_MISTAKES_USER_CONFIG = userConfig;

    await main([
      "run",
      `--repo=${repo}`,
      "--base=main",
      "--intent=Reject invalid policy.",
    ]);

    let calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const createdTask = calls.find(
      (args) => args[0] === "orchestration" && args[1] === "task-create",
    );
    assert.equal(createdTask?.[createdTask.indexOf("--run") + 1], "configured-run");
    const sent = calls.find(
      (args) => args[0] === "terminal" && args[1] === "send",
    );
    assert.match(
      sent?.[sent.indexOf("--text") + 1] ?? "",
      /NO_MISTAKES_INTENT_TASK_ID='task-intent'/,
    );

    const gatePath = path.join(root, "configured-run");
    process.env.NO_MISTAKES_DELIVERY_BRANCH = "feature";
    process.env.NO_MISTAKES_GATE_BRANCH = git(
      gatePath,
      "branch",
      "--show-current",
    );
    process.env.NO_MISTAKES_GATE_WORKTREE_ROOT = root;
    process.env.NO_MISTAKES_INTENT_TASK_ID = "task-intent";
    process.env.NO_MISTAKES_ORIGIN_WORKTREE = repo;
    process.env.NO_MISTAKES_RUN_ID = "configured-run";
    await writeFile(userConfig, "stages: [\n");

    await assert.rejects(
      main([
        "run",
        "--attached",
        `--repo=${gatePath}`,
        "--base=main",
        "--intent=Reject invalid policy.",
      ]),
      /invalid|parse|flow sequence/i,
    );

    calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const failed = calls.filter(
      (args) =>
        args[0] === "orchestration" &&
        args[1] === "task-update" &&
        args[args.indexOf("--id") + 1] === "task-intent" &&
        args[args.indexOf("--status") + 1] === "failed",
    );
    assert.equal(failed.length, 1);
    assert.deepEqual(await readdir(root), []);
  } finally {
    for (const name of environmentNames) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(temp, { recursive: true, force: true });
  }
});
