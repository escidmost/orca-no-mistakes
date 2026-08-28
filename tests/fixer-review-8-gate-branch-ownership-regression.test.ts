import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
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
  main,
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

test("abort and stranded prune retain a gate branch owned by a raw worktree", async () => {
  const aborted = await seedGate("onm-abort-raw-gate-owner-");
  let restore = setHome(path.join(aborted.temp, "home"));
  let ledger = new DomainLedger();
  try {
    const runId = "run-abort-raw-owner";
    ledger.startRun({
      baseBranch: "feature",
      branch: "feature",
      intent: "abort raw owner",
      policySha256: "f".repeat(64),
      repoRoot: aborted.origin,
      runId,
      submissionCommitOid: aborted.baseOid,
    });
    ledger.acquireLease({ branch: "feature", repoRoot: aborted.origin, runId });
    await installAbortReaping({
      gate: aborted.gate,
      ledger,
      notify: async () => {},
      orcaCommand: aborted.fakeOrca,
      originWorktree: aborted.origin,
      pid: process.pid,
    });
    const rawPath = path.join(aborted.temp, "raw-gate-owner");
    git(aborted.origin, "worktree", "remove", "--force", aborted.gate.path);
    git(aborted.origin, "worktree", "add", rawPath, aborted.gate.branch);
    await registerAbortRunContext({
      deliveryGit: new GitShell({ repo: aborted.origin }),
      git: new GitShell({ repo: rawPath }),
      ledger,
      runId,
    });

    await reapAbortedRun("test abort");

    assert.equal(existsSync(aborted.gate.path), false);
    assert.equal(existsSync(rawPath), true);
    assert.equal(
      git(aborted.origin, "rev-parse", `refs/heads/${aborted.gate.branch}`),
      aborted.gateHead,
    );
    assert.equal(existsSync(markerPath(aborted.origin, aborted.gate.id)), true);
  } finally {
    ledger.close();
    restore();
    await rm(aborted.temp, { force: true, recursive: true });
  }

  const stranded = await seedGate("onm-prune-raw-gate-owner-");
  restore = setHome(path.join(stranded.temp, "home"), stranded.fakeOrca);
  ledger = new DomainLedger();
  try {
    const runId = "run-prune-raw-owner";
    ledger.startRun({
      baseBranch: "feature",
      branch: "feature",
      intent: "prune raw owner",
      policySha256: "f".repeat(64),
      repoRoot: stranded.origin,
      runId,
      submissionCommitOid: stranded.baseOid,
    });
    ledger.acquireLease({ branch: "feature", repoRoot: stranded.origin, runId });
    assert.equal(ledger.settleRun(runId, "cancelled"), true);
    git(
      stranded.origin,
      "update-ref",
      `refs/no-mistakes/recover/${runId}`,
      stranded.gateHead,
    );
    await mkdir(path.dirname(markerPath(stranded.origin, stranded.gate.id)), {
      recursive: true,
    });
    const dead = spawnSync(process.execPath, ["-e", ""]);
    assert.ok(dead.pid !== undefined);
    await writeFile(
      markerPath(stranded.origin, stranded.gate.id),
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate: stranded.gate,
        originWorktree: stranded.origin,
        pid: dead.pid,
        runId,
      }),
    );
    const rawPath = path.join(stranded.temp, "raw-gate-owner");
    git(stranded.origin, "worktree", "remove", "--force", stranded.gate.path);
    git(stranded.origin, "worktree", "add", rawPath, stranded.gate.branch);

    await main(["prune", "--stranded", `--repo=${stranded.origin}`]);

    assert.equal(existsSync(stranded.gate.path), false);
    assert.equal(existsSync(rawPath), true);
    assert.equal(
      git(stranded.origin, "rev-parse", `refs/heads/${stranded.gate.branch}`),
      stranded.gateHead,
    );
    assert.equal(existsSync(markerPath(stranded.origin, stranded.gate.id)), true);
  } finally {
    ledger.close();
    restore();
    await rm(stranded.temp, { force: true, recursive: true });
  }
});
