import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  GitShell,
  installAbortReaping,
  reapAbortedRun,
  registerAbortRunContext,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(origin: string, gateId: string): string {
  const digest = createHash("sha256").update(gateId).digest("hex").slice(0, 32);
  return path.join(origin, ".orca", "no-mistakes", `gate-${digest}.json`);
}

async function seedGate(prefix: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  git(temp, "-c", "init.templateDir=", "init", "-b", "feature", "origin");
  const origin = await realpath(path.join(temp, "origin"));
  git(origin, "config", "user.email", "test@example.com");
  git(origin, "config", "user.name", "Test User");
  git(origin, "config", "commit.gpgsign", "false");
  git(origin, "config", "core.hooksPath", "/dev/null");
  await writeFile(path.join(origin, "README.md"), "seed\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "seed");
  const baseOid = git(origin, "rev-parse", "HEAD");
  const gatePath = path.join(temp, "gate");
  const gateBranch = path.basename(gatePath);
  git(origin, "worktree", "add", "-b", gateBranch, gatePath);
  await writeFile(path.join(gatePath, "work.txt"), "work\n");
  git(gatePath, "add", ".");
  git(gatePath, "commit", "-m", "gate work");
  const gateHead = git(gatePath, "rev-parse", "HEAD");
  const gateId = `repo::${gatePath}`;
  const originId = `repo::${origin}`;
  const fakeOrca = path.join(temp, "orca");
  await writeFile(
    fakeOrca,
    `#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") {
  const worktrees = [{ id: ${JSON.stringify(originId)}, path: ${JSON.stringify(origin)}, branch: "refs/heads/feature", head: ${JSON.stringify(baseOid)} }]
  if (existsSync(${JSON.stringify(gatePath)})) worktrees.push({ id: ${JSON.stringify(gateId)}, path: ${JSON.stringify(gatePath)}, branch: ${JSON.stringify(`refs/heads/${gateBranch}`)}, head: ${JSON.stringify(gateHead)}, parentWorktreeId: ${JSON.stringify(originId)} })
  out({ worktrees })
} else if (args[0] === "worktree" && args[1] === "rm") {
  try { execFileSync("git", ["worktree", "remove", "--force", ${JSON.stringify(gatePath)}], { cwd: ${JSON.stringify(origin)} }) } catch {}
  out({ removed: true })
} else {
  out({ ok: true })
}
`,
  );
  await chmod(fakeOrca, 0o755);
  return {
    baseOid,
    fakeOrca,
    gate: { branch: gateBranch, id: gateId, kind: "orca" as const, path: gatePath },
    gateHead,
    origin,
    temp,
  };
}

function setHome(home: string, orcaCommand?: string): () => void {
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousOrca = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  if (orcaCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
  else process.env.ORCA_CLI_COMMAND = orcaCommand;
  return () => {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    if (previousOrca === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousOrca;
  };
}

test("a failed marker refresh preserves the previous marker", async () => {
  const seeded = await seedGate("onm-marker-refresh-failure-");
  const restore = setHome(path.join(seeded.temp, "home"));
  const ledger = new DomainLedger();
  const marker = markerPath(seeded.origin, seeded.gate.id);
  const markerDirectory = path.dirname(marker);
  try {
    await installAbortReaping({
      gate: seeded.gate,
      originWorktree: seeded.origin,
      pid: process.pid,
    });
    const before = await readFile(marker);
    await chmod(markerDirectory, 0o555);

    await assert.rejects(
      registerAbortRunContext({
        deliveryGit: new GitShell({ repo: seeded.origin }),
        git: new GitShell({ repo: seeded.gate.path }),
        ledger,
        runId: "run-marker-refresh-failure",
      }),
    );

    assert.deepEqual(await readFile(marker), before);
  } finally {
    await chmod(markerDirectory, 0o755).catch(() => {});
    ledger.close();
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("a raw worktree racing branch deletion gets its branch restored", async () => {
  const seeded = await seedGate("onm-gate-delete-race-");
  const restore = setHome(path.join(seeded.temp, "home"));
  const ledger = new DomainLedger();
  const previousPath = process.env.PATH;
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const rawPath = path.join(seeded.temp, "raw-gate-owner");
  const gitWrapperDirectory = path.join(seeded.temp, "bin");
  const gitWrapper = path.join(gitWrapperDirectory, "git");
  try {
    await mkdir(gitWrapperDirectory, { recursive: true });
    await writeFile(
      gitWrapper,
      `#!/usr/bin/env node
import { spawnSync } from "node:child_process"
const args = process.argv.slice(2)
if (args.includes("update-ref") && args.includes("-d") && args.includes(${JSON.stringify(`refs/heads/${seeded.gate.branch}`)})) {
  const added = spawnSync(${JSON.stringify(realGit)}, ["-C", ${JSON.stringify(seeded.origin)}, "worktree", "add", ${JSON.stringify(rawPath)}, ${JSON.stringify(seeded.gate.branch)}], { encoding: "utf8" })
  if (added.status !== 0) {
    process.stderr.write(added.stderr || added.stdout || "raw worktree add failed")
    process.exit(added.status ?? 1)
  }
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { encoding: "utf8" })
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
process.exit(result.status ?? 1)
`,
    );
    await chmod(gitWrapper, 0o755);
    process.env.PATH = `${gitWrapperDirectory}${path.delimiter}${previousPath ?? ""}`;

    const runId = "run-gate-delete-race";
    ledger.startRun({
      baseBranch: "feature",
      branch: "feature",
      intent: "gate delete race",
      policySha256: "f".repeat(64),
      repoRoot: seeded.origin,
      runId,
      submissionCommitOid: seeded.baseOid,
    });
    ledger.acquireLease({
      branch: "feature",
      repoRoot: seeded.origin,
      runId,
    });
    await installAbortReaping({
      gate: seeded.gate,
      ledger,
      notify: async () => {},
      orcaCommand: seeded.fakeOrca,
      originWorktree: seeded.origin,
      pid: process.pid,
    });
    await registerAbortRunContext({
      deliveryGit: new GitShell({ repo: seeded.origin }),
      git: new GitShell({ repo: seeded.gate.path }),
      ledger,
      runId,
    });

    await reapAbortedRun("test branch deletion race");

    assert.equal(existsSync(rawPath), true);
    assert.equal(
      git(seeded.origin, "rev-parse", `refs/heads/${seeded.gate.branch}`),
      seeded.gateHead,
    );
    assert.equal(git(rawPath, "rev-parse", "HEAD"), seeded.gateHead);
    assert.equal(
      git(rawPath, "symbolic-ref", "HEAD"),
      `refs/heads/${seeded.gate.branch}`,
    );
    assert.doesNotThrow(() => git(rawPath, "status", "--porcelain=v1"));
    assert.equal(existsSync(markerPath(seeded.origin, seeded.gate.id)), true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    ledger.close();
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});
