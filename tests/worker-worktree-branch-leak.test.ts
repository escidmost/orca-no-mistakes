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

// Stands in for Orca around a worker worktree that is created, detached onto a
// pinned commit, and then torn down when its terminal never appears. The fake
// keeps real git state so `worktree list` reports no branch once the child is
// detached, exactly as Orca does — the window in which custody must be claimed.
async function seedWorker(
  prefix: string,
  branch: string,
  options: { adopts?: boolean } = {},
) {
  const adopts = options.adopts ?? false;
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const repo = path.join(temp, "repo");
  const worker = path.join(temp, "worker");
  const fakeOrca = path.join(temp, "orca");
  git(temp, "-c", "init.templateDir=", "init", "-b", "feature", "repo");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, "README.md"), "seed\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "seed");
  const commitOid = git(repo, "rev-parse", "HEAD");

  await writeFile(
    fakeOrca,
    `#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
const repo = ${JSON.stringify(repo)}
const worker = ${JSON.stringify(worker)}
if (args[0] === 'worktree' && args[1] === 'create') {
  execFileSync('git', ['worktree', 'add', '-b', ${JSON.stringify(branch)}, worker], { cwd: repo })
  out({ worktree: { id: ${JSON.stringify(WORKTREE_ID)}, path: worker } })
} else if (args[0] === 'worktree' && args[1] === 'list') {
  let branch = ''
  try {
    branch = execFileSync('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: worker, encoding: 'utf8' }).trim()
  } catch {}
  out({ worktrees: [{ id: ${JSON.stringify(WORKTREE_ID)}, branch }] })
} else if (args[0] === 'worktree' && args[1] === 'rm') {
  ${adopts ? `try { execFileSync('git', ['worktree', 'add', ${JSON.stringify(path.join(temp, "pinned"))}, ${JSON.stringify(branch)}], { cwd: repo }) } catch {}` : ''}
  try { execFileSync('git', ['worktree', 'remove', '--force', worker], { cwd: repo }) } catch {}
  out({ ok: true })
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
  const start = () =>
    orca.startWorker("task-review", {
      commitOid,
      name: "no-mistakes-review-1",
      prompt: "review",
      role: "reviewer",
      stage: "review",
      worktree: "new-child",
    });
  return { orca, repo, start, temp };
}

test("a detached worker worktree still releases the branch Orca minted", async () => {
  const branch = "evs/no-mistakes-review-1-7";
  const { repo, start, temp } = await seedWorker("orca-worker-branch-", branch);
  try {
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
  const { orca, start, temp } = await seedWorker(
    "orca-worker-branch-stuck-",
    branch,
    { adopts: true },
  );
  try {
    // Another checkout adopts the branch during teardown, so `git branch -D`
    // refuses it and the ref genuinely outlives the worktree.
    await assert.rejects(start());
    await assert.rejects(
      orca.removeWorktree(WORKTREE_ID),
      /outlived its worktree/,
    );
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test("an unreadable branch list fails cleanup instead of assuming removal", async () => {
  const branch = "evs/no-mistakes-review-1-9";
  const { orca, repo, start, temp } = await seedWorker(
    "orca-worker-branch-probe-",
    branch,
  );
  try {
    // Breaks `git branch --list` (exit 128, empty stdout) without hiding the ref.
    git(repo, "config", "branch.sort", "bogus");
    // Deletion may well have worked; without a readable probe cleanup cannot
    // prove it, and an unprovable release is reported rather than assumed.
    await assert.rejects(start());
    await assert.rejects(
      orca.removeWorktree(WORKTREE_ID),
      /could not confirm removal/,
    );
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});
