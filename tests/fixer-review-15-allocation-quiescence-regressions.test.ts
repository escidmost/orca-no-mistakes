import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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

import { DomainLedger, main } from "../scripts/orca-no-mistakes.ts";

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

async function seed(prefix: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const repo = path.join(temp, "repo");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  const origin = path.join(temp, "origin.git");
  git(temp, "-c", "init.templateDir=", "init", "--bare", origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  git(repo, "checkout", "-b", "feature");
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

test("launcher allocation publishes a durable process receipt", async () => {
  const seeded = await seed("onm-launch-quiescence-");
  const home = path.join(seeded.temp, "home");
  const capture = path.join(seeded.temp, "marker.json");
  const config = path.join(seeded.temp, "config.json");
  const command = path.join(seeded.temp, "orca");
  await writeFile(
    command,
    `#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
const dir = path.join(${JSON.stringify(seeded.repo)}, ".orca", "no-mistakes")
const name = fs.readdirSync(dir).find((entry) => entry.startsWith("gate-") && entry.endsWith(".json"))
const marker = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ marker, pid: process.pid }))
process.exit(1)
`,
  );
  await chmod(command, 0o755);
  await writeFile(config, "{}");
  const restore = setEnv(home, command);
  const previousConfig = process.env.ORCA_NO_MISTAKES_USER_CONFIG;
  process.env.ORCA_NO_MISTAKES_USER_CONFIG = config;
  try {
    await assert.rejects(
      main([
        "run",
        `--repo=${seeded.repo}`,
        "--base=main",
        "--intent=observe allocation receipt",
      ]),
    );
    const captured = JSON.parse(await readFile(capture, "utf8")) as {
      marker: { allocationPid?: number; allocationProtocol?: string };
      pid: number;
    };
    assert.equal(captured.marker.allocationProtocol, "gated-v1");
    assert.equal(captured.marker.allocationPid, captured.pid);
  } finally {
    restore();
    if (previousConfig === undefined)
      delete process.env.ORCA_NO_MISTAKES_USER_CONFIG;
    else process.env.ORCA_NO_MISTAKES_USER_CONFIG = previousConfig;
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

test("stranded cleanup retains a live worker allocation", async () => {
  const seeded = await seed("onm-worker-quiescence-");
  const home = path.join(seeded.temp, "home");
  const gatePath = path.join(seeded.temp, "gate");
  git(seeded.repo, "worktree", "add", "-b", "gate", gatePath);
  const gate = await realpath(gatePath);
  const gateId = `repo::${gate}`;
  const runId = "run-worker-quiescence";
  const head = git(seeded.repo, "rev-parse", "HEAD");
  const marker = markerPath(seeded.repo, gateId);
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  assert.ok(live.pid);
  await writeFile(
    marker,
    JSON.stringify({
      allocationProtocol: "gated-v1",
      createdAt: new Date().toISOString(),
      gate: { branch: "gate", id: gateId, kind: "orca", path: gate },
      originWorktree: seeded.repo,
      pid: 2_147_483_647,
      runId,
      workerAllocationPids: { pending: [live.pid] },
      workerAllocations: ["pending"],
    }),
  );
  const ledger = new DomainLedger(path.join(home, "ledger.db"));
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "worker quiescence",
    policySha256: "policy",
    repoRoot: seeded.repo,
    runId,
    submissionCommitOid: head,
  });
  ledger.acquireLease({ branch: "feature", repoRoot: seeded.repo, runId });
  ledger.close();
  const command = path.join(seeded.temp, "orca");
  await writeFile(
    command,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [
  { id: "repo::" + ${JSON.stringify(seeded.repo)}, path: ${JSON.stringify(seeded.repo)}, branch: "refs/heads/feature", head: ${JSON.stringify(head)} },
  { id: ${JSON.stringify(gateId)}, path: ${JSON.stringify(gate)}, branch: "refs/heads/gate", head: ${JSON.stringify(head)}, parentWorktreeId: "repo::" + ${JSON.stringify(seeded.repo)} }
] })
else if (args[0] === "terminal" && args[1] === "list") out({ terminals: [] })
else { console.error(JSON.stringify({ error: { code: "unexpected", args } })); process.exit(1) }
`,
  );
  await chmod(command, 0o755);
  const restore = setEnv(home, command);
  try {
    await main(["prune", "--stranded", "--repo", seeded.repo]);
    assert.equal(existsSync(marker), true);
    const retained = JSON.parse(await readFile(marker, "utf8")) as {
      workerAllocations?: string[];
    };
    assert.deepEqual(retained.workerAllocations, ["pending"]);
  } finally {
    restore();
    live.kill();
    git(seeded.repo, "worktree", "remove", "--force", gatePath);
    await rm(seeded.temp, { force: true, recursive: true });
  }
});
