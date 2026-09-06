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

test("fixer guardrails allow prose edits but retain documentation assertions", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-document-guardrail-"));
  const repo = path.join(temp, "repo");
  const worker = path.join(temp, "worker");
  try {
    await mkdir(repo);
    git(repo, "init", "-b", "feature");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "core.hooksPath", "/dev/null");
    await mkdir(path.join(repo, "docs"));
    await writeFile(
      path.join(repo, "docs/current-architecture.md"),
      "# Architecture\n\nChai supports `value.should.not.equal(...)` assertions.\n",
    );
    git(repo, "add", ".");
    git(repo, "commit", "-m", "document test syntax");
    const expectedHead = git(repo, "rev-parse", "HEAD");

    git(repo, "worktree", "add", "--detach", worker, expectedHead);
    await writeFile(
      path.join(worker, "docs/current-architecture.md"),
      "# Current Architecture\n\nChai supports `value.should.not.equal(...)` assertions.\n",
    );
    git(worker, "add", "docs/current-architecture.md");
    git(worker, "commit", "-m", "clarify architecture heading");

    assert.deepEqual(
      await new GitShell({ repo }).assertFixerChangesAllowed(
        worker,
        expectedHead,
        git(worker, "rev-parse", "HEAD"),
      ),
      { changed: true, guardrailViolations: [] },
    );

    await writeFile(
      path.join(worker, "docs/current-architecture.md"),
      "# Current Architecture\n\nChai supports `value.should.equal(...)` assertions.\n",
    );
    git(worker, "add", "docs/current-architecture.md");
    git(worker, "commit", "-m", "weaken documented assertion");
    await assert.rejects(
      new GitShell({ repo }).assertFixerChangesAllowed(
        worker,
        expectedHead,
        git(worker, "rev-parse", "HEAD"),
      ),
      /fixer modified co-located test assertions or skip markers/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("fixer guardrails do not mistake prose 'check (' for a Catch2 macro", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-document-guardrail-"));
  const repo = path.join(temp, "repo");
  const worker = path.join(temp, "worker");
  try {
    await mkdir(repo);
    git(repo, "init", "-b", "feature");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "core.hooksPath", "/dev/null");
    await mkdir(path.join(repo, "docs"));
    await writeFile(
      path.join(repo, "docs/current-architecture.md"),
      "# Architecture\n\nOne finding per failing check (with its details URL) opens a gate.\n",
    );
    git(repo, "add", ".");
    git(repo, "commit", "-m", "document ci gate");
    const expectedHead = git(repo, "rev-parse", "HEAD");

    git(repo, "worktree", "add", "--detach", worker, expectedHead);
    await writeFile(
      path.join(worker, "docs/current-architecture.md"),
      "# Architecture\n\nSee ADR-0016 for the ci decision table.\n",
    );
    git(worker, "add", "docs/current-architecture.md");
    git(worker, "commit", "-m", "replace duplicate prose with a pointer");

    assert.deepEqual(
      await new GitShell({ repo }).assertFixerChangesAllowed(
        worker,
        expectedHead,
        git(worker, "rev-parse", "HEAD"),
      ),
      { changed: true, guardrailViolations: [] },
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
