import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PreflightError } from "../scripts/adapters.ts";
import { CliOrca, GitShell } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("Kimi immediate startup errors remain preflight failures", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-kimi-preflight-"));
  const fakeOrca = path.join(temp, "orca");
  const callsPath = path.join(temp, "calls.jsonl");
  const previousStartupDelay = process.env.WORKER_SHELL_STARTUP_DELAY_MS;
  const previousTimeout = process.env.WORKER_AGENT_READY_TIMEOUT_MS;
  process.env.WORKER_SHELL_STARTUP_DELAY_MS = "0";
  process.env.WORKER_AGENT_READY_TIMEOUT_MS = "100";
  try {
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'terminal' && args[1] === 'create') {
  out({ terminal: { handle: 'kimi-shell' } })
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  out({ dispatch: { id: 'dispatch-kimi', status: 'dispatched' }, preamble: 'authenticated' })
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, title: 'feature', preview: 'error: login required' } })
} else {
  out({ ok: true })
}
`,
    );
    await chmod(fakeOrca, 0o755);
    const orca = new CliOrca({ command: fakeOrca, cwd: temp });
    await assert.rejects(
      orca.startWorker("task-kimi", {
        agent: { harness: "Kimi" },
        name: "kimi-reviewer",
        prompt: "review",
        role: "reviewer",
        stage: "review",
        worktree: "current",
      }),
      (error: unknown) => {
        assert.ok(error instanceof PreflightError);
        assert.equal(error.failureClass, "auth");
        return true;
      },
    );
    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const sent = calls.find(
      (args) => args[0] === "terminal" && args[1] === "send",
    );
    assert.ok(sent?.[sent.indexOf("--text") + 1]?.includes("--auto"));
    assert.ok(!sent?.[sent.indexOf("--text") + 1]?.includes("--prompt"));
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "orchestration" && args[1] === "worker-abandon",
      ),
    );
  } finally {
    if (previousStartupDelay === undefined)
      delete process.env.WORKER_SHELL_STARTUP_DELAY_MS;
    else process.env.WORKER_SHELL_STARTUP_DELAY_MS = previousStartupDelay;
    if (previousTimeout === undefined)
      delete process.env.WORKER_AGENT_READY_TIMEOUT_MS;
    else process.env.WORKER_AGENT_READY_TIMEOUT_MS = previousTimeout;
    await rm(temp, { recursive: true, force: true });
  }
});

test("pre-commit manifests are protected from committed fixer changes", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-pre-commit-policy-"));
  const repo = path.join(temp, "repo");
  const worker = path.join(temp, "worker");
  try {
    await mkdir(repo);
    git(repo, "init", "-b", "feature");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "core.hooksPath", "/dev/null");
    await writeFile(
      path.join(repo, ".pre-commit-config.yaml"),
      "repos: [{repo: local, hooks: []}]\n",
    );
    git(repo, "add", ".pre-commit-config.yaml");
    git(repo, "commit", "-m", "add validation policy");
    const expectedHead = git(repo, "rev-parse", "HEAD");
    git(repo, "worktree", "add", "--detach", worker, expectedHead);
    await writeFile(path.join(worker, ".pre-commit-config.yaml"), "repos: []\n");
    git(worker, "add", ".pre-commit-config.yaml");
    git(worker, "commit", "-m", "remove validation hooks");

    await assert.rejects(
      new GitShell({ repo }).assertFixerChangesAllowed(
        worker,
        expectedHead,
        git(worker, "rev-parse", "HEAD"),
      ),
      /protected validation policy files: \.pre-commit-config\.yaml/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("advisory guardrail mode reports protected changes without rejecting custody", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-advisory-policy-"));
  const repo = path.join(temp, "repo");
  const worker = path.join(temp, "worker");
  try {
    await mkdir(repo);
    git(repo, "init", "-b", "feature");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "core.hooksPath", "/dev/null");
    await writeFile(
      path.join(repo, ".pre-commit-config.yaml"),
      "repos: [{repo: local, hooks: []}]\n",
    );
    git(repo, "add", ".pre-commit-config.yaml");
    git(repo, "commit", "-m", "add validation policy");
    const expectedHead = git(repo, "rev-parse", "HEAD");
    git(repo, "worktree", "add", "--detach", worker, expectedHead);
    await writeFile(path.join(worker, ".pre-commit-config.yaml"), "repos: []\n");
    git(worker, "add", ".pre-commit-config.yaml");
    git(worker, "commit", "-m", "remove validation hooks");

    const verdict = await new GitShell({ repo }).assertFixerChangesAllowed(
      worker,
      expectedHead,
      git(worker, "rev-parse", "HEAD"),
      "advisory",
    );
    assert.deepEqual(verdict, {
      changed: true,
      guardrailViolations: [
        "unexplained-policy-relaxation: fixer modified protected validation policy files: .pre-commit-config.yaml",
      ],
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("advisory guardrail mode still rejects fixer history rewrites", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-advisory-rewrite-"));
  const repo = path.join(temp, "repo");
  const worker = path.join(temp, "worker");
  try {
    await mkdir(repo);
    git(repo, "init", "-b", "feature");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "core.hooksPath", "/dev/null");
    await writeFile(path.join(repo, "app.ts"), "export const a = 1\n");
    git(repo, "add", "app.ts");
    git(repo, "commit", "-m", "first");
    await writeFile(path.join(repo, "app.ts"), "export const a = 2\n");
    git(repo, "commit", "-am", "second");
    const expectedHead = git(repo, "rev-parse", "HEAD");
    git(repo, "worktree", "add", "--detach", worker, expectedHead);
    git(worker, "reset", "--hard", `${expectedHead}^`);
    await writeFile(path.join(worker, "app.ts"), "export const a = 3\n");
    git(worker, "add", "app.ts");
    git(worker, "commit", "-m", "rewrite");

    await assert.rejects(
      new GitShell({ repo }).assertFixerChangesAllowed(
        worker,
        expectedHead,
        git(worker, "rev-parse", "HEAD"),
        "advisory",
      ),
      /rewrote history/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("zod-style refinement contexts do not freeze source files", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-inline-context-"));
  const repo = path.join(temp, "repo");
  const worker = path.join(temp, "worker");
  try {
    await mkdir(repo);
    git(repo, "init", "-b", "feature");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "core.hooksPath", "/dev/null");
    await mkdir(path.join(repo, "scripts"), { recursive: true });
    await writeFile(
      path.join(repo, "scripts", "config.ts"),
      "type Ctx = { addIssue(issue: object): void }\nexport const refine = (value: number, context: Ctx) => {\n  if (value < 0) context.addIssue({ code: \"custom\" })\n}\n",
    );
    git(repo, "add", ".");
    git(repo, "commit", "-m", "add refinement");
    const expectedHead = git(repo, "rev-parse", "HEAD");
    git(repo, "worktree", "add", "--detach", worker, expectedHead);
    await writeFile(
      path.join(worker, "scripts", "config.ts"),
      "type Ctx = { addIssue(issue: object): void }\nexport const refine = (value: number, context: Ctx) => {\n  if (value < 0) context.addIssue({ code: \"custom\", message: \"negative\" })\n}\n",
    );
    git(worker, "add", ".");
    git(worker, "commit", "-m", "adjust refinement message");

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

test("deferred ecosystem test and policy conventions stay protected", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-deferred-guardrails-"));
  const repo = path.join(temp, "repo");
  const worker = path.join(temp, "worker");
  const files = new Map([
    ["features/step_definitions/login.rb", "Given(\"a logged-in user\") do\nend\n"],
    ["features/steps/login.py", "def user_is_logged_in(context):\n    pass\n"],
    ["src/gtest-f.cc", "TEST_F(Fixture, Works) { EXPECT_EQ(1, 1); }\n"],
    ["src/gtest-p.cc", "TEST_P(Fixture, Works) { EXPECT_EQ(1, 1); }\n"],
    ["src/gtest-typed.cc", "TYPED_TEST(Fixture, Works) { EXPECT_EQ(1, 1); }\n"],
    ["src/gtest-typed-p.cc", "TYPED_TEST_P(Fixture, Works) { EXPECT_EQ(1, 1); }\n"],
    ["pytest.toml", "[tool.pytest.ini_options]\naddopts = \"-q\"\n"],
    [".pytest.toml", "[tool.pytest.ini_options]\naddopts = \"-q\"\n"],
    ["vite.config.ts", "export default { test: {} };\n"],
  ]);
  try {
    await mkdir(repo);
    git(repo, "init", "-b", "feature");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "core.hooksPath", "/dev/null");
    for (const [filePath, source] of files) {
      await mkdir(path.dirname(path.join(repo, filePath)), { recursive: true });
      await writeFile(path.join(repo, filePath), source);
    }
    git(repo, "add", ".");
    git(repo, "commit", "-m", "add deferred guardrail conventions");
    const expectedHead = git(repo, "rev-parse", "HEAD");
    git(repo, "worktree", "add", "--detach", worker, expectedHead);

    const assertProtected = async (
      paths: string[],
      pattern: RegExp,
    ): Promise<void> => {
      git(worker, "reset", "--hard", expectedHead);
      for (const filePath of paths) {
        await writeFile(
          path.join(worker, filePath),
          `${files.get(filePath)}changed\n`,
        );
      }
      git(worker, "add", "--", ...paths);
      git(worker, "commit", "-m", "mutate protected convention");
      await assert.rejects(
        new GitShell({ repo }).assertFixerChangesAllowed(
          worker,
          expectedHead,
          git(worker, "rev-parse", "HEAD"),
        ),
        (error: unknown) => {
          assert.match(String(error), pattern);
          return true;
        },
      );
    };

    await assertProtected(
      ["features/step_definitions/login.rb", "features/steps/login.py"],
      /fixer modified pre-existing test files: .*features\/step_definitions\/login\.rb.*features\/steps\/login\.py/,
    );
    await assertProtected(
      [
        "src/gtest-f.cc",
        "src/gtest-p.cc",
        "src/gtest-typed.cc",
        "src/gtest-typed-p.cc",
      ],
      /fixer modified co-located test assertions or skip markers: .*src\/gtest-f\.cc.*src\/gtest-p\.cc.*src\/gtest-typed-p\.cc.*src\/gtest-typed\.cc/,
    );
    await assertProtected(
      ["pytest.toml", ".pytest.toml", "vite.config.ts"],
      /unexplained-policy-relaxation: fixer modified protected validation policy files: .*\.pytest\.toml.*pytest\.toml.*vite\.config\.ts/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
