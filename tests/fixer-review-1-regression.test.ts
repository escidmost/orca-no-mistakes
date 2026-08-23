import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function initialize(repo: string): Promise<void> {
  git(path.dirname(repo), "init", "-b", "feature", repo);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
}

test("validation policy references are protected transitively", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-policy-closure-"));
  const repo = path.join(temp, "repo");
  try {
    await initialize(repo);
    await mkdir(path.join(repo, ".github/workflows"), { recursive: true });
    await mkdir(path.join(repo, "tools/check"), { recursive: true });
    await mkdir(path.join(repo, "scripts"));
    await writeFile(
      path.join(repo, ".github/workflows/ci.yml"),
      "jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./tools/check\n",
    );
    await writeFile(
      path.join(repo, "tools/check/action.yml"),
      "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: ../../scripts/check.sh\n",
    );
    await writeFile(path.join(repo, "scripts/check.sh"), "./run-suite.sh\n");
    await writeFile(path.join(repo, "scripts/run-suite.sh"), "exit 1\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "validation chain");
    const expectedHead = git(repo, "rev-parse", "HEAD");

    const worker = path.join(temp, "worker");
    git(repo, "worktree", "add", "--detach", worker, expectedHead);
    await writeFile(path.join(worker, "scripts/run-suite.sh"), "exit 0\n");
    git(worker, "add", "scripts/run-suite.sh");
    git(worker, "commit", "-m", "weaken validation");

    const shell = new GitShell({ repo });
    await assert.rejects(
      shell.assertFixerChangesAllowed(
        worker,
        expectedHead,
        git(worker, "rev-parse", "HEAD"),
      ),
      /protected validation policy files: scripts\/run-suite\.sh/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("custody preserves edits started during transfer", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-custody-edit-"));
  const repo = path.join(temp, "repo");
  try {
    await initialize(repo);
    await writeFile(path.join(repo, "value.txt"), "original\n");
    git(repo, "add", "value.txt");
    git(repo, "commit", "-m", "original");
    const expectedHead = git(repo, "rev-parse", "HEAD");

    const worker = path.join(temp, "worker");
    git(repo, "worktree", "add", "--detach", worker, expectedHead);
    await writeFile(path.join(worker, "value.txt"), "worker\n");
    git(worker, "add", "value.txt");
    git(worker, "commit", "-m", "worker change");
    const sourceHead = git(worker, "rev-parse", "HEAD");

    const wrapperDir = path.join(temp, "bin");
    const wrapper = path.join(wrapperDir, "git");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    await mkdir(wrapperDir);
    await writeFile(
      wrapper,
      `#!/bin/sh
${quote(realGit)} "$@"
status=$?
if [ "$status" -eq 0 ] && [ "$1" = "-C" ] && [ "$2" = ${quote(repo)} ] && [ "$3" = "checkout" ] && [ "$4" = "--detach" ] && [ "$5" = ${quote(expectedHead)} ]; then
  printf 'operator edit\n' > ${quote(path.join(repo, "value.txt"))}
fi
exit "$status"
`,
    );
    await chmod(wrapper, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDir}:${previousPath ?? ""}`;
    try {
      assert.equal(
        await new GitShell({ repo }).applyWorktreeCommits(
          worker,
          expectedHead,
          sourceHead,
        ),
        false,
      );
    } finally {
      process.env.PATH = previousPath;
    }
    assert.equal(
      await readFile(path.join(repo, "value.txt"), "utf8"),
      "operator edit\n",
    );
    assert.equal(git(repo, "rev-parse", "HEAD"), expectedHead);
    assert.equal(git(repo, "rev-parse", "feature"), expectedHead);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
