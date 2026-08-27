import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  main,
  selectedFindingIdsForGate,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("stop has no durable declined-finding provenance", () => {
  assert.equal(
    selectedFindingIdsForGate(
      { action: "stop", guidance: "", selectedFindings: [] },
      ["approve", "fix", "skip", "stop"],
    ),
    undefined,
  );
});

test("configured attached failures settle every open task", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-configured-attached-failure-"));
  const origin = path.join(temp, "origin.git");
  const repo = path.join(temp, "repo");
  const root = path.join(temp, "runs");
  const gatePath = path.join(root, "configured-run");
  const fakeOrca = path.join(temp, "orca");
  const callsPath = path.join(temp, "calls.jsonl");
  const gateBranch = "no-mistakes-gate-deadbeef";
  const environmentNames = [
    "NO_MISTAKES_DELIVERY_BRANCH",
    "NO_MISTAKES_GATE_BRANCH",
    "NO_MISTAKES_GATE_WORKTREE_ROOT",
    "NO_MISTAKES_INTENT_TASK_ID",
    "NO_MISTAKES_ORIGIN_WORKTREE",
    "NO_MISTAKES_RUN_ID",
    "ORCA_CLI_COMMAND",
    "ORCA_NO_MISTAKES_HOME",
  ] as const;
  const previous = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  const originalClose = DomainLedger.prototype.close;
  const originalConsoleError = console.error;
  const warnings: string[] = [];
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
    git(repo, "checkout", "-b", "feature");
    await mkdir(root);
    git(
      repo,
      "worktree",
      "add",
      "-b",
      gateBranch,
      gatePath,
      "feature",
    );
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const callsPath = ${JSON.stringify(callsPath)}
const args = process.argv.slice(2)
fs.appendFileSync(callsPath, JSON.stringify(args) + '\\n')
const calls = fs.readFileSync(callsPath, 'utf8').trim().split('\\n').map(JSON.parse)
const created = calls.filter((call) => call[0] === 'orchestration' && call[1] === 'task-create').length
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'orchestration' && args[1] === 'task-create') {
  if (created === 5) {
    process.stderr.write('injected task creation failure')
    process.exit(1)
  }
  out({ task: { id: 'task-stage-' + created } })
} else if (args[0] === 'orchestration' && args[1] === 'task-list') {
  out({ tasks: [
    { id: 'task-intent', status: 'completed' },
    ...Array.from({ length: 4 }, (_, index) => ({ id: 'task-stage-' + (index + 1), status: 'ready' }))
  ] })
} else {
  out({ accepted: true })
}
`,
    );
    await chmod(fakeOrca, 0o755);
    Object.assign(process.env, {
      NO_MISTAKES_DELIVERY_BRANCH: "feature",
      NO_MISTAKES_GATE_BRANCH: gateBranch,
      NO_MISTAKES_GATE_WORKTREE_ROOT: await realpath(root),
      NO_MISTAKES_INTENT_TASK_ID: "task-intent",
      NO_MISTAKES_ORIGIN_WORKTREE: await realpath(repo),
      NO_MISTAKES_RUN_ID: "configured-run",
      ORCA_CLI_COMMAND: fakeOrca,
      ORCA_NO_MISTAKES_HOME: path.join(temp, "home"),
    });
    DomainLedger.prototype.close = function () {
      originalClose.call(this);
      throw new Error("injected ledger close failure");
    };
    console.error = (...args) => warnings.push(args.map(String).join(" "));

    await assert.rejects(
      main([
        "run",
        "--attached",
        `--repo=${gatePath}`,
        "--base=main",
        "--intent=Settle configured task failures.",
      ]),
      /injected task creation failure/,
    );
    assert.ok(
      warnings.some((warning) =>
        warning.includes(
          "warning: could not close the domain ledger: Error: injected ledger close failure",
        ),
      ),
    );

    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const failures = calls.filter(
      (args) =>
        args[0] === "orchestration" &&
        args[1] === "task-update" &&
        args[args.indexOf("--status") + 1] === "failed",
    );
    assert.deepEqual(
      failures.map((args) => args[args.indexOf("--id") + 1]).sort(),
      ["task-stage-1", "task-stage-2", "task-stage-3", "task-stage-4"],
    );
    for (const args of failures) {
      const result = JSON.parse(args[args.indexOf("--result") + 1]) as {
        summary: string;
      };
      assert.match(
        result.summary,
        /^Configured coordinator failed: .*injected task creation failure$/,
      );
    }
    assert.equal(git(repo, "branch", "--list", gateBranch), "");
  } finally {
    DomainLedger.prototype.close = originalClose;
    console.error = originalConsoleError;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(temp, { recursive: true, force: true });
  }
});
