import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCliCommand, PreflightError } from "../scripts/adapters.ts";
import { CliOrca, GitShell } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("Kimi prompt mode omits the incompatible auto flag", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-kimi-contract-"));
  const kimi = path.join(temp, "kimi");
  try {
    await writeFile(
      kimi,
      `#!/bin/sh
auto=
prompt=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --auto) auto=1 ;;
    --prompt) prompt=1; shift ;;
  esac
  shift
done
[ -z "$auto" ] || [ -z "$prompt" ] || exit 64
[ -n "$prompt" ] || exit 65
`,
    );
    await chmod(kimi, 0o755);
    const command = `${buildCliCommand("Kimi", { nonInteractive: true })} --prompt task`;
    execFileSync("/bin/sh", ["-c", command], {
      env: { ...process.env, PATH: `${temp}:${process.env.PATH ?? ""}` },
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

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
} else if (args[0] === 'terminal' && args[1] === 'read' && args.includes('--cursor')) {
  out({ terminal: { nextCursor: '1', status: 'running', tail: ['error: login required'] } })
} else if (args[0] === 'terminal' && args[1] === 'read') {
  out({ terminal: { nextCursor: '0', status: 'running', tail: [] } })
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
    assert.ok(!sent?.[sent.indexOf("--text") + 1]?.includes("--auto"));
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
