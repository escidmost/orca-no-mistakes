import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PreflightError } from "../scripts/adapters.ts";
import { CliOrca } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("worker worktree teardown deletes the branch Orca minted for it", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-worker-branch-"));
  const repo = path.join(temp, "repo");
  const fakeOrca = path.join(temp, "orca");
  const callsPath = path.join(temp, "calls.jsonl");
  const workerBranch = "evs/no-mistakes-review-1-7";
  try {
    git(temp, "-c", "init.templateDir=", "init", "-b", "feature", "repo");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "commit.gpgsign", "false");
    await writeFile(path.join(repo, "README.md"), "seed\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "seed");
    git(repo, "branch", workerBranch);

    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'worktree' && args[1] === 'create') {
  out({ worktree: { id: 'repo::/worker', path: ${JSON.stringify(path.join(temp, "worker"))}, branch: 'refs/heads/${workerBranch}' } })
} else if (args[0] === 'terminal' && args[1] === 'list') {
  out({ terminals: [] })
} else if (args[0] === 'terminal' && args[1] === 'create') {
  out({})
} else {
  out({ ok: true })
}
`,
    );
    await chmod(fakeOrca, 0o755);

    const orca = new CliOrca({ command: fakeOrca, cwd: repo });
    await assert.rejects(
      orca.startWorker("task-review", {
        name: "no-mistakes-review-1",
        prompt: "review",
        role: "reviewer",
        stage: "review",
        worktree: "new-child",
      }),
      (error: unknown) => error instanceof PreflightError,
    );

    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(
      calls.some((args) => args[0] === "worktree" && args[1] === "rm"),
      "expected the leaked worker worktree to be removed",
    );
    assert.equal(
      git(repo, "branch", "--list", workerBranch),
      "",
      "worker branch must not outlive its worktree",
    );
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test("a worker branch that outlives its worktree surfaces as a cleanup failure", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-worker-branch-stuck-"));
  const repo = path.join(temp, "repo");
  const pinned = path.join(temp, "pinned");
  const fakeOrca = path.join(temp, "orca");
  const workerBranch = "evs/no-mistakes-review-1-8";
  try {
    git(temp, "-c", "init.templateDir=", "init", "-b", "feature", "repo");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "commit.gpgsign", "false");
    await writeFile(path.join(repo, "README.md"), "seed\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "seed");
    // Checking the branch out elsewhere makes `git branch -D` refuse it, so the
    // branch genuinely survives its worktree instead of merely being absent.
    git(repo, "worktree", "add", "-b", workerBranch, pinned);

    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'worktree' && args[1] === 'create') {
  out({ worktree: { id: 'repo::/worker', path: ${JSON.stringify(path.join(temp, "worker"))}, branch: 'refs/heads/${workerBranch}' } })
} else if (args[0] === 'terminal' && args[1] === 'list') {
  out({ terminals: [] })
} else if (args[0] === 'terminal' && args[1] === 'create') {
  out({})
} else {
  out({ ok: true })
}
`,
    );
    await chmod(fakeOrca, 0o755);

    const orca = new CliOrca({ command: fakeOrca, cwd: repo });
    await assert.rejects(
      orca.startWorker("task-review", {
        name: "no-mistakes-review-1",
        prompt: "review",
        role: "reviewer",
        stage: "review",
        worktree: "new-child",
      }),
      /outlived worktree/,
    );
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});
