import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

test("configured Runs bind to the coordinator before path placement", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-configured-binding-"));
  const repo = await seedRepo(temp);
  const root = path.join(temp, "runs");
  const config = path.join(temp, "config.json");
  const fakeOrca = path.join(temp, "orca");
  const callsPath = path.join(temp, "calls.jsonl");
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousConfig = process.env.ORCA_NO_MISTAKES_USER_CONFIG;
  try {
    await mkdir(root);
    await writeFile(
      config,
      JSON.stringify({ worktree_roots: { [await realpath(repo)]: root } }),
    );
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
if (args[0] === 'terminal' && args[1] === 'send') {
  const markerDirectory = ${JSON.stringify(path.join(repo, ".orca", "no-mistakes"))}
  const markerFile = fs.readdirSync(markerDirectory)
    .map((name) => markerDirectory + '/' + name)
    .find((file) => file.endsWith('.json') && JSON.parse(fs.readFileSync(file, 'utf8')).startupReceipt)
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  fs.writeFileSync(markerFile + '.startup', JSON.stringify({ pid: process.ppid, token: marker.startupReceipt }))
}
const result = args[0] === 'terminal' && args[1] === 'create'
  ? { terminal: { handle: 'configured-coordinator' } }
  : args[0] === 'orchestration' && args[1] === 'run-create'
    ? { run: { id: 'configured-run' } }
    : args[0] === 'orchestration' && args[1] === 'task-create'
      ? { task: { id: 'task-intent' } }
      : args[0] === 'terminal' && args[1] === 'show'
        ? { terminal: { connected: true, preview: 'ready' } }
      : { accepted: true }
console.log(JSON.stringify({ result }))
`,
    );
    await chmod(fakeOrca, 0o755);
    process.env.ORCA_CLI_COMMAND = fakeOrca;
    process.env.ORCA_NO_MISTAKES_USER_CONFIG = config;

    await main([
      "run",
      `--repo=${repo}`,
      "--base=main",
      "--intent=Bind configured run.",
    ]);

    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const terminalIndex = calls.findIndex(
      (args) => args[0] === "terminal" && args[1] === "create",
    );
    const runIndex = calls.findIndex(
      (args) => args[0] === "orchestration" && args[1] === "run-create",
    );
    assert.ok(terminalIndex >= 0 && terminalIndex < runIndex);
    assert.equal(
      calls[runIndex]?.[calls[runIndex].indexOf("--from") + 1],
      "configured-coordinator",
    );

    const gatePath = path.join(root, "configured-run");
    const branch = git(gatePath, "branch", "--show-current");
    git(repo, "worktree", "remove", "--force", gatePath);
    git(repo, "branch", "-D", branch);
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousCommand;
    if (previousConfig === undefined)
      delete process.env.ORCA_NO_MISTAKES_USER_CONFIG;
    else process.env.ORCA_NO_MISTAKES_USER_CONFIG = previousConfig;
    await rm(temp, { recursive: true, force: true });
  }
});

test("configured Run IDs cannot escape their root", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-configured-run-id-"));
  const repo = await seedRepo(temp);
  const root = path.join(temp, "runs");
  const config = path.join(temp, "config.json");
  const fakeOrca = path.join(temp, "orca");
  const runIdPath = path.join(temp, "run-id");
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousConfig = process.env.ORCA_NO_MISTAKES_USER_CONFIG;
  try {
    await mkdir(path.join(repo, ".git", "info"), { recursive: true });
    await writeFile(path.join(repo, ".git", "info", "exclude"), ".orca/\n");
    await mkdir(root);
    await writeFile(
      config,
      JSON.stringify({ worktree_roots: { [await realpath(repo)]: root } }),
    );
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const result = args[0] === 'terminal' && args[1] === 'create'
  ? { terminal: { handle: 'configured-coordinator' } }
  : args[0] === 'orchestration' && args[1] === 'run-create'
    ? { run: { id: fs.readFileSync(${JSON.stringify(runIdPath)}, 'utf8') } }
    : { accepted: true }
console.log(JSON.stringify({ result }))
`,
    );
    await chmod(fakeOrca, 0o755);
    process.env.ORCA_CLI_COMMAND = fakeOrca;
    process.env.ORCA_NO_MISTAKES_USER_CONFIG = config;

    for (const runId of [".", ".."]) {
      await writeFile(runIdPath, runId);
      await assert.rejects(
        main([
          "run",
          `--repo=${repo}`,
          "--base=main",
          "--intent=Reject unsafe run ID.",
        ]),
        /invalid run ID/,
      );
      assert.deepEqual(await readdir(root), []);
    }
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousCommand;
    if (previousConfig === undefined)
      delete process.env.ORCA_NO_MISTAKES_USER_CONFIG;
    else process.env.ORCA_NO_MISTAKES_USER_CONFIG = previousConfig;
    await rm(temp, { recursive: true, force: true });
  }
});

test("configured roots reject symlinked repository ancestors before mkdir", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-configured-symlink-"));
  const repo = await seedRepo(temp);
  const operator = path.join(temp, "operator");
  const linkedRepo = path.join(operator, "linked-repo");
  const requestedRoot = path.join(linkedRepo, "created-by-mkdir");
  const config = path.join(temp, "config.json");
  const previousConfig = process.env.ORCA_NO_MISTAKES_USER_CONFIG;
  try {
    await mkdir(operator);
    await symlink(repo, linkedRepo);
    await writeFile(
      config,
      JSON.stringify({
        worktree_roots: { [await realpath(repo)]: requestedRoot },
      }),
    );
    process.env.ORCA_NO_MISTAKES_USER_CONFIG = config;

    await assert.rejects(
      main([
        "run",
        `--repo=${repo}`,
        "--base=main",
        "--intent=Reject symlinked root.",
      ]),
      /configured worktree root must be outside repository/,
    );
    assert.equal(existsSync(path.join(repo, "created-by-mkdir")), false);
  } finally {
    if (previousConfig === undefined)
      delete process.env.ORCA_NO_MISTAKES_USER_CONFIG;
    else process.env.ORCA_NO_MISTAKES_USER_CONFIG = previousConfig;
    await rm(temp, { recursive: true, force: true });
  }
});
