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

test("fixer protects multiline assertions and qualified test declarations", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-inline-tests-"));
  const repo = path.join(temp, "repo");
  try {
    git(temp, "-c", "init.templateDir=", "init", "-b", "feature", repo);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "core.hooksPath", "/dev/null");
    git(repo, "config", "commit.gpgsign", "false");
    await mkdir(path.join(repo, "src"));
    await writeFile(
      path.join(repo, "src/assertion.ts"),
      "assert.deepEqual(\n  actual,\n  expected,\n);\n",
    );
    await writeFile(
      path.join(repo, "src/deno-registration.ts"),
      'Deno.test("case", () => verify());\n',
    );
    await writeFile(
      path.join(repo, "src/vitest-registration.ts"),
      'vitest.test("case", () => verify());\n',
    );
    await writeFile(
      path.join(repo, "src/service-registration.ts"),
      'service.test("case", () => verify());\n',
    );
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

    await change(
      "src/assertion.ts",
      "assert.deepEqual(\n  actual,\n  actual,\n);\n",
    );
    await assert.rejects(
      assertWorkerChangesAllowed(),
      /co-located test assertions or skip markers: src\/assertion\.ts/,
    );

    for (const qualifier of ["deno", "vitest"]) {
      await change(`src/${qualifier}-registration.ts`, "verify();\n");
      await assert.rejects(
        assertWorkerChangesAllowed(),
        new RegExp(
          `co-located test assertions or skip markers: src/${qualifier}-registration\\.ts`,
        ),
      );
    }

    await change("src/service-registration.ts", "verify();\n");
    assert.equal(await assertWorkerChangesAllowed(), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
