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

test("configured launch settles Runs after post-creation failures", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-configured-run-failure-"));
  const origin = path.join(temp, "origin.git");
  const repo = path.join(temp, "repo");
  const root = path.join(temp, "runs");
  const configPath = path.join(temp, "config.json");
  const fakeOrca = path.join(temp, "orca");
  const callsPath = path.join(temp, "calls.jsonl");
  const taskCreateMarker = path.join(temp, "task-create-marker");
  const environmentNames = [
    "FAKE_ORCA_MODE",
    "ORCA_CLI_COMMAND",
    "ORCA_NO_MISTAKES_USER_CONFIG",
  ] as const;
  const previous = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  try {
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
    await mkdir(root);
    await writeFile(
      configPath,
      JSON.stringify({ worktree_roots: { [await realpath(repo)]: root } }),
    );
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const mode = process.env.FAKE_ORCA_MODE
const marker = ${JSON.stringify(taskCreateMarker)}
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'terminal' && args[1] === 'create') {
  out({ terminal: { handle: 'configured-coordinator' } })
} else if (args[0] === 'orchestration' && args[1] === 'run-create') {
  out({ run: { id: mode === 'invalid-run' ? '../escaped' : 'configured-run' } })
} else if (args[0] === 'orchestration' && args[1] === 'task-list') {
  out({ tasks: mode === 'malformed-task' ? [{ id: 'task-orphan', status: 'ready' }] : [] })
} else if (args[0] === 'orchestration' && args[1] === 'task-create') {
  if (mode === 'task-error' && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'failed')
    process.stderr.write('intent task create failed')
    process.exit(1)
  }
  if (mode === 'malformed-task' && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'created')
    out({ task: { id: '' } })
  } else {
    out({ task: { id: 'task-cleanup' } })
  }
} else {
  out({ accepted: true })
}
`,
    );
    await chmod(fakeOrca, 0o755);
    process.env.ORCA_CLI_COMMAND = fakeOrca;
    process.env.ORCA_NO_MISTAKES_USER_CONFIG = configPath;

    let callCount = 0;
    for (const [mode, error, runId, failedTask] of [
      ["invalid-run", /invalid run ID/, "../escaped", "task-cleanup"],
      ["task-error", /intent task create failed/, "configured-run", "task-cleanup"],
      ["malformed-task", /invalid task ID/, "configured-run", "task-orphan"],
    ] as const) {
      await rm(taskCreateMarker, { force: true });
      process.env.FAKE_ORCA_MODE = mode;
      await assert.rejects(
        main([
          "run",
          `--repo=${repo}`,
          "--base=main",
          "--intent=Keep configured lifecycle state bounded.",
        ]),
        error,
      );
      const calls = (await readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const scenarioCalls = calls.slice(callCount);
      callCount = calls.length;
      assert.ok(
        scenarioCalls.some(
          (args) => args[0] === "terminal" && args[1] === "close",
        ),
      );
      assert.deepEqual(await readdir(root), []);
      if (mode === "invalid-run") {
        assert.equal(await readdir(temp).then((entries) => entries.includes("escaped")), false);
        assert.equal(
          scenarioCalls.some((args) =>
            args.some(
              (arg, index) => arg === "--run" && args[index + 1] === runId,
            ),
          ),
          false,
        );
        continue;
      }
      const listed = scenarioCalls.find(
        (args) => args[0] === "orchestration" && args[1] === "task-list",
      );
      assert.equal(listed?.[listed.indexOf("--run") + 1], runId);
      const failed = scenarioCalls.find(
        (args) =>
          args[0] === "orchestration" &&
          args[1] === "task-update" &&
          args[args.indexOf("--status") + 1] === "failed",
      );
      assert.equal(failed?.[failed.indexOf("--id") + 1], failedTask);
      assert.equal(failed?.[failed.indexOf("--run") + 1], runId);
    }
  } finally {
    for (const name of environmentNames) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(temp, { recursive: true, force: true });
  }
});
