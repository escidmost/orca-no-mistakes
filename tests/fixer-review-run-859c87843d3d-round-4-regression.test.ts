import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function seedRepo(temp: string, name: string): Promise<string> {
  const origin = path.join(temp, `${name}.git`);
  const repo = path.join(temp, name);
  git(temp, "-c", "init.templateDir=", "init", "--bare", origin);
  git(temp, "-c", "init.templateDir=", "init", "-b", "main", repo);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, "README.md"), "seed\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "seed");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  git(repo, "checkout", "-b", "feature");
  return await realpath(repo);
}

test("configured roots reject no-mistakes and registered checkout state", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-configured-root-ownership-"));
  const config = path.join(temp, "config.json");
  const home = path.join(temp, "home");
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousConfig = process.env.ORCA_NO_MISTAKES_USER_CONFIG;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  try {
    const repoA = await seedRepo(temp, "repo-a");
    const repoB = await seedRepo(temp, "repo-b");
    process.env.ORCA_CLI_COMMAND = path.join(temp, "forbidden-orca");
    process.env.ORCA_NO_MISTAKES_USER_CONFIG = config;
    process.env.ORCA_NO_MISTAKES_HOME = home;

    const artifacts = path.join(home, "artifacts");
    await writeFile(
      config,
      JSON.stringify({ worktree_roots: { [repoA]: artifacts } }),
    );
    await assert.rejects(
      main([
        "run",
        `--repo=${repoA}`,
        "--base=main",
        "--intent=Reject owned state.",
      ]),
      /configured worktree root must be outside no-mistakes state/,
    );
    assert.equal(existsSync(artifacts), false);

    const nestedRoot = path.join(repoB, ".runs");
    await writeFile(
      config,
      JSON.stringify({
        worktree_roots: {
          [repoA]: nestedRoot,
          [repoB]: path.join(temp, "repo-b-runs"),
        },
      }),
    );
    await assert.rejects(
      main([
        "run",
        `--repo=${repoA}`,
        "--base=main",
        "--intent=Reject another checkout.",
      ]),
      /configured worktree root must be outside repository/,
    );
    assert.equal(existsSync(nestedRoot), false);
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousCommand;
    if (previousConfig === undefined)
      delete process.env.ORCA_NO_MISTAKES_USER_CONFIG;
    else process.env.ORCA_NO_MISTAKES_USER_CONFIG = previousConfig;
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});
