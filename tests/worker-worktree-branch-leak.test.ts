import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CliOrca } from "../scripts/orca-no-mistakes.ts";

const WORKTREE_ID = "repo::/worker";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// A worker worktree whose creation succeeds but whose terminal never appears:
// the prepare-failure path tears the worktree down, which must also release
// the branch Orca minted for it.
async function seedWorker(prefix: string, branch: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const repo = path.join(temp, "repo");
  const fakeOrca = path.join(temp, "orca");
  git(temp, "-c", "init.templateDir=", "init", "-b", "feature", "repo");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, "README.md"), "seed\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "seed");
  await writeFile(
    fakeOrca,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'worktree' && args[1] === 'create') {
  out({ worktree: { id: ${JSON.stringify(WORKTREE_ID)}, path: ${JSON.stringify(path.join(temp, "worker"))} } })
} else if (args[0] === 'worktree' && args[1] === 'list') {
  out({ worktrees: [{ id: ${JSON.stringify(WORKTREE_ID)}, branch: 'refs/heads/${branch}' }] })
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
  const start = () =>
    new CliOrca({ command: fakeOrca, cwd: repo }).startWorker("task-review", {
      name: "no-mistakes-review-1",
      prompt: "review",
      role: "reviewer",
      stage: "review",
      worktree: "new-child",
    });
  return { repo, start, temp };
}

test("worker worktree teardown deletes the branch Orca minted for it", async () => {
  const branch = "evs/no-mistakes-review-1-7";
  const { repo, start, temp } = await seedWorker("orca-worker-branch-", branch);
  try {
    git(repo, "branch", branch);
    await assert.rejects(start());
    assert.equal(
      git(repo, "branch", "--list", branch),
      "",
      "worker branch must not outlive its worktree",
    );
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test("a worker branch that outlives its worktree fails cleanup", async () => {
  const branch = "evs/no-mistakes-review-1-8";
  const { repo, start, temp } = await seedWorker(
    "orca-worker-branch-stuck-",
    branch,
  );
  try {
    // Checking the branch out elsewhere makes `git branch -D` refuse it, so the
    // branch genuinely survives instead of merely being absent.
    git(repo, "worktree", "add", "-b", branch, path.join(temp, "pinned"));
    await assert.rejects(start(), /outlived its worktree/);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test("an unreadable branch list fails cleanup instead of assuming removal", async () => {
  const branch = "evs/no-mistakes-review-1-9";
  const { repo, start, temp } = await seedWorker(
    "orca-worker-branch-probe-",
    branch,
  );
  try {
    git(repo, "branch", branch);
    // Breaks `git branch --list` (exit 128, empty stdout) without hiding the ref.
    git(repo, "config", "branch.sort", "bogus");
    // Deletion may well have worked; without a readable probe cleanup cannot
    // prove it, and an unprovable release is reported rather than assumed.
    await assert.rejects(start(), /could not confirm removal/);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});
