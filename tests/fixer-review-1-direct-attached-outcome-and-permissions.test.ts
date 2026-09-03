import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  installAbortReaping,
  main,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(repo: string, gateId: string): string {
  const digest = createHash("sha256")
    .update(gateId)
    .digest("hex")
    .slice(0, 32);
  return path.join(repo, ".orca", "no-mistakes", `gate-${digest}.json`);
}

test("direct attached run rejects --notify without a gate worktree", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-direct-notify-"));
  const repo = path.join(temp, "repo");
  const bare = path.join(temp, "origin.git");
  execFileSync("git", ["init", "-b", "main", bare, "--bare"], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  await writeFile(path.join(repo, "README.md"), "# Repo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "init");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  git(repo, "checkout", "-b", "feature");

  try {
    await assert.rejects(
      main([
        "run",
        "--attached",
        `--repo=${repo}`,
        "--base=main",
        "--intent=Direct attached notify should fail",
        "--notify=origin-term",
      ]),
      /--notify is not supported for direct attached runs/,
    );
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test("installAbortReaping rejects notifyHandle without a gate worktree", async () => {
  await assert.rejects(
    installAbortReaping({
      notifyHandle: "origin-term",
      pid: process.pid,
    }),
    /notification delivery requires a gate worktree/,
  );
});

test("writeMarker creates staging files and destination markers with 0600 permissions", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-marker-perms-"));
  const repo = path.join(temp, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  await writeFile(path.join(repo, "README.md"), "# Repo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "init");

  const gate = {
    branch: "test-gate-branch",
    id: "gate-1",
    kind: "orca" as const,
    path: repo,
  };

  try {
    await installAbortReaping({
      gate,
      originWorktree: repo,
      pid: process.pid,
    });

    const markerFile = markerPath(repo, "gate-1");
    assert.equal(existsSync(markerFile), true);
    const fileStat = await stat(markerFile);
    assert.equal(fileStat.mode & 0o777, 0o600);
  } finally {
    await installAbortReaping({});
    await rm(temp, { force: true, recursive: true });
  }
});
