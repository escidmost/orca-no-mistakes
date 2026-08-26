import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GitShell } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("fixer protects Python assertion continuations and doctest output", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-validation-blocks-"));
  const repo = path.join(temp, "repo");
  try {
    git(temp, "-c", "init.templateDir=", "init", "-b", "feature", repo);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "core.hooksPath", "/dev/null");
    git(repo, "config", "commit.gpgsign", "false");
    await mkdir(path.join(repo, "src"));
    const sources = {
      "src/assertion.py":
        "def validate(actual, expected):\n    assert actual == (\n        expected\n    )\n",
      "src/nested-assertion.py":
        "def validate(actual, expected):\n    assert actual == ((expected)\n    )\n",
      "src/doctest.py":
        'def square(value):\n    """\n    >>> square(2)\n    4\n    """\n    return value * value\n',
      "src/single-line.py":
        "def validate(value):\n    assert is_valid(value)\n    return value\n",
    };
    for (const [file, content] of Object.entries(sources)) {
      await writeFile(path.join(repo, file), content);
    }
    git(repo, "add", ".");
    git(repo, "commit", "-m", "validation sources");
    const expectedHead = git(repo, "rev-parse", "HEAD");

    const worker = path.join(temp, "worker");
    git(repo, "worktree", "add", "--detach", worker, expectedHead);
    const shell = new GitShell({ repo });
    const change = async (file: string, content: string): Promise<void> => {
      git(worker, "reset", "--hard", expectedHead);
      await writeFile(path.join(worker, file), content);
      git(worker, "add", file);
      git(worker, "commit", "-m", `change ${file}`);
    };
    const assertWorkerChangesAllowed = () =>
      shell.assertFixerChangesAllowed(
        worker,
        expectedHead,
        git(worker, "rev-parse", "HEAD"),
      );

    const weakened = {
      "src/assertion.py":
        "def validate(actual, expected):\n    assert actual == (\n        actual\n    )\n",
      "src/nested-assertion.py":
        "def validate(actual, expected):\n    assert actual == ((actual)\n    )\n",
      "src/doctest.py":
        'def square(value):\n    """\n    >>> square(2)\n    5\n    """\n    return value * value\n',
    };
    for (const [file, content] of Object.entries(weakened)) {
      await change(file, content);
      await assert.rejects(
        assertWorkerChangesAllowed(),
        /co-located test assertions or skip markers/,
      );
    }

    await change(
      "src/single-line.py",
      "def validate(value):\n    assert is_valid(value)\n    return normalize(value)\n",
    );
    assert.equal(await assertWorkerChangesAllowed(), true);

    // An untouched doctest leaves the surrounding runtime code fixable.
    await change(
      "src/doctest.py",
      'def square(value):\n    """\n    >>> square(2)\n    4\n    """\n    return value ** 2\n',
    );
    assert.equal(await assertWorkerChangesAllowed(), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
