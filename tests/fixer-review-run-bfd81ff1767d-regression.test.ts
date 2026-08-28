import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GitShell } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("strict guardrails protect arbitrary global test modifiers", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-test-modifier-"));
  const repo = path.join(temp, "repo");
  const worker = path.join(temp, "worker");
  try {
    await mkdir(repo);
    git(repo, "init", "-b", "feature");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "core.hooksPath", "/dev/null");
    await mkdir(path.join(repo, "src"));
    await writeFile(
      path.join(repo, "src/math.ts"),
      'const setup = 1;\ntest.fails("math", () => expect(setup + 1).toBe(3));\n',
    );
    git(repo, "add", ".");
    git(repo, "commit", "-m", "add co-located test");
    const expectedHead = git(repo, "rev-parse", "HEAD");

    git(repo, "worktree", "add", "--detach", worker, expectedHead);
    await writeFile(
      path.join(worker, "src/math.ts"),
      'const setup = 2;\ntest.fails("math", () => expect(setup + 1).toBe(3));\n',
    );
    git(worker, "add", "src/math.ts");
    git(worker, "commit", "-m", "change setup");

    await assert.rejects(
      new GitShell({ repo }).assertFixerChangesAllowed(
        worker,
        expectedHead,
        git(worker, "rev-parse", "HEAD"),
      ),
      /fixer modified co-located test assertions or skip markers: src\/math\.ts/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
