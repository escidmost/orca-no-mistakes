import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
  CliOrca,
  main,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(origin: string, identity: string): string {
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 32);
  return path.join(origin, ".orca", "no-mistakes", `gate-${digest}.json`);
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

async function seed(prefix: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const repo = path.join(temp, "repo");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  git(repo, "-c", "init.templateDir=", "init", "-b", "feature");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  return { repo: await realpath(repo), temp };
}

function setEnv(home: string, orcaCommand: string): () => void {
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousOrca = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  process.env.ORCA_CLI_COMMAND = orcaCommand;
  return () => {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    if (previousOrca === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousOrca;
  };
}

test("reconstructed workers require durable shutdown proof", async () => {
  const worker: WorkerResult = {
    dispatchId: "acp-stranded",
    report: { findings: [], summary: "stranded" },
    taskId: "task-stranded",
  };
  await assert.rejects(
    new CliOrca({ command: "/usr/bin/false", cwd: process.cwd() }).finishWorker(
      worker,
      "release",
    ),
    /shutdown cannot be verified/,
  );
  assert.equal(worker.shutdownConfirmed, undefined);
});

test("stranded cleanup retains unknown live gate terminals", async () => {
  const seeded = await seed("onm-unknown-gate-terminal-");
  const gateBranch = "no-mistakes-gate-unknown-terminal";
  const gatePath = path.join(seeded.temp, gateBranch);
  git(seeded.repo, "worktree", "add", "-b", gateBranch, gatePath);
  const gate = await realpath(gatePath);
  const gateId = `repo::${gate}`;
  const originId = `repo::${seeded.repo}`;
  const head = git(seeded.repo, "rev-parse", "HEAD");
  const marker = markerPath(seeded.repo, gateId);
  const live = path.join(seeded.temp, "terminal-live");
  const calls = path.join(seeded.temp, "calls.jsonl");
  const command = path.join(seeded.temp, "orca");
  await writeFile(live, "live");
  await writeFile(
    marker,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      gate: { branch: gateBranch, id: gateId, kind: "orca", path: gate },
      originWorktree: seeded.repo,
      pid: deadPid(),
      runId: "run-unknown-terminal",
      workers: [],
    }),
  );
  await writeFile(
    command,
    `#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, unlinkSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [
  { id: ${JSON.stringify(originId)}, path: ${JSON.stringify(seeded.repo)}, branch: "refs/heads/feature", head: ${JSON.stringify(head)} },
  { id: ${JSON.stringify(gateId)}, path: ${JSON.stringify(gate)}, branch: ${JSON.stringify(`refs/heads/${gateBranch}`)}, head: ${JSON.stringify(head)}, parentWorktreeId: ${JSON.stringify(originId)} }
] })
else if (args[0] === "terminal" && args[1] === "list") out({ terminals: existsSync(${JSON.stringify(live)}) ? [{ connected: true, handle: "term-unrelated" }] : [] })
else if (args[0] === "terminal" && args[1] === "close") { unlinkSync(${JSON.stringify(live)}); out({ closed: true }) }
else if (args[0] === "worktree" && args[1] === "rm") { execFileSync("git", ["worktree", "remove", ${JSON.stringify(gate)}], { cwd: ${JSON.stringify(seeded.repo)} }); out({ removed: true }) }
else out({ ok: true })
`,
  );
  await chmod(command, 0o755);
  const restore = setEnv(path.join(seeded.temp, "home"), command);
  try {
    await main(["prune", "--stranded", "--repo", seeded.repo]);
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(gate), true);
    const recorded = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      recorded.some(
        (args) => args[0] === "terminal" && args[1] === "close",
      ),
      false,
    );
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("launcher recovery resolves a unique namespaced branch", async () => {
  const seeded = await seed("onm-namespaced-launcher-");
  const launcherId = "launcher-namespaced";
  const gateBranch = "no-mistakes-gate-namespaced";
  const namespacedBranch = `evs/${gateBranch}`;
  const head = git(seeded.repo, "rev-parse", "HEAD");
  git(seeded.repo, "branch", namespacedBranch);
  git(
    seeded.repo,
    "update-ref",
    `refs/no-mistakes/recover/${launcherId}`,
    head,
  );
  const marker = markerPath(seeded.repo, `orca-launcher:${launcherId}`);
  await writeFile(
    marker,
    JSON.stringify({
      allocationProtocol: "gated-v1",
      createdAt: new Date().toISOString(),
      gateBranch,
      kind: "orca-launcher",
      launcherId,
      originWorktree: seeded.repo,
      pid: deadPid(),
    }),
  );
  const command = path.join(seeded.temp, "orca");
  await writeFile(
    command,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [{
  id: ${JSON.stringify(`repo::${seeded.repo}`)},
  path: ${JSON.stringify(seeded.repo)},
  branch: "refs/heads/feature",
  head: ${JSON.stringify(head)}
}] })
else { console.error(JSON.stringify({ error: { code: "unexpected", args } })); process.exit(1) }
`,
  );
  await chmod(command, 0o755);
  const restore = setEnv(path.join(seeded.temp, "home"), command);
  try {
    await main(["prune", "--stranded", "--repo", seeded.repo]);
    assert.equal(existsSync(marker), false);
    assert.equal(git(seeded.repo, "branch", "--list", namespacedBranch), "");
  } finally {
    restore();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});
