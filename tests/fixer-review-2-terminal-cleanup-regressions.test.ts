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
  CliOrca,
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

function markerPath(repo: string, identity: string): string {
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 32);
  return path.join(repo, ".orca", "no-mistakes", `gate-${digest}.json`);
}

async function seed(prefix: string) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const repo = path.join(temp, "repo");
  const root = path.join(temp, "gates");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await mkdir(root);
  git(repo, "-c", "init.templateDir=", "init", "-b", "feature");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  return { repo: await realpath(repo), root: await realpath(root), temp };
}

function recordPassedRun(
  ledger: DomainLedger,
  repo: string,
  runId: string,
): void {
  const head = git(repo, "rev-parse", "HEAD");
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "terminal cleanup",
    policySha256: "f".repeat(64),
    repoRoot: repo,
    runId,
    submissionCommitOid: head,
  });
  assert.equal(ledger.finishRun(runId, "passed", head), true);
}

async function fakeOrca(
  seeded: Awaited<ReturnType<typeof seed>>,
  gate?: { branch: string; id: string; path: string },
) {
  const calls = path.join(seeded.temp, "calls.jsonl");
  const command = path.join(seeded.temp, "orca");
  const head = git(seeded.repo, "rev-parse", "HEAD");
  await writeFile(
    command,
    `#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "terminal" && args[1] === "show") {
  console.log(JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } }))
  process.exit(1)
} else if (args[0] === "terminal" && args[1] === "list") out({ terminals: [] })
else if (args[0] === "terminal" && args[1] === "close") out({ closed: true })
else if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [
  { id: ${JSON.stringify(`repo::${seeded.repo}`)}, path: ${JSON.stringify(seeded.repo)}, branch: "refs/heads/feature", head: ${JSON.stringify(head)} },
  ...(${JSON.stringify(gate)} && existsSync(${JSON.stringify(gate?.path)}) ? [{
    id: ${JSON.stringify(gate?.id)}, path: ${JSON.stringify(gate?.path)}, branch: ${JSON.stringify(gate && `refs/heads/${gate.branch}`)}, head: ${JSON.stringify(head)}, parentWorktreeId: ${JSON.stringify(`repo::${seeded.repo}`)}
  }] : [])
] })
else if (args[0] === "worktree" && args[1] === "rm") {
  execFileSync("git", ["worktree", "remove", ${JSON.stringify(gate?.path)}], { cwd: ${JSON.stringify(seeded.repo)} })
  out({ removed: true })
} else if (args[0] === "orchestration" && args[1] === "task-list") out({ tasks: [] })
else if (args[0] === "orchestration" && args[1] === "task-create") out({ task: { id: "task-startup" } })
else out({ accepted: true })
`,
  );
  await chmod(command, 0o755);
  return { calls, command };
}

function setEnv(home: string, command: string): () => void {
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousOrca = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  process.env.ORCA_CLI_COMMAND = command;
  return () => {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    if (previousOrca === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousOrca;
  };
}

async function recordedCalls(file: string): Promise<string[][]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

test("late abort does not fail an already-passed Orca run", async () => {
  const seeded = await seed("onm-late-passed-abort-");
  const fake = await fakeOrca(seeded);
  const ledger = new DomainLedger(":memory:");
  const runId = "run-passed-abort";
  try {
    recordPassedRun(ledger, seeded.repo, runId);
    await installAbortReaping({
      ledger,
      orca: new CliOrca({ command: fake.command, cwd: seeded.repo, runId }),
      orcaCommand: fake.command,
      pid: process.pid,
    });
    await registerAbortRunContext({
      deliveryGit: new GitShell({ repo: seeded.repo }),
      git: new GitShell({ repo: seeded.repo }),
      ledger,
      runId,
    });

    await reapAbortedRun("late signal");

    assert.equal(ledger.runStatus(runId), "passed");
    assert.deepEqual(await recordedCalls(fake.calls), []);
  } finally {
    ledger.close();
    await rm(seeded.temp, { force: true, recursive: true });
  }
});

for (const kind of ["configured", "orca"] as const) {
  test(`stranded cleanup reaps a ${kind} gate after the run passes`, async () => {
    const seeded = await seed(`onm-passed-${kind}-gate-`);
    const runId = `run-passed-${kind}`;
    const branch = `no-mistakes-gate-${runId}`;
    const gatePath = path.join(seeded.root, kind === "configured" ? runId : branch);
    git(seeded.repo, "worktree", "add", "-b", branch, gatePath);
    const canonicalGate = await realpath(gatePath);
    const gateId = `repo::${canonicalGate}`;
    const fake = await fakeOrca(seeded, {
      branch,
      id: gateId,
      path: canonicalGate,
    });
    const home = path.join(seeded.temp, "home");
    const restore = setEnv(home, fake.command);
    const ledger = new DomainLedger({ repositoryPath: seeded.repo });
    const gate =
      kind === "configured"
        ? {
            branch,
            intentTaskId: "task-intent",
            kind,
            path: canonicalGate,
            root: seeded.root,
            runId,
          }
        : { branch, id: gateId, kind, path: canonicalGate };
    const marker = markerPath(
      seeded.repo,
      kind === "configured" ? canonicalGate : gateId,
    );
    try {
      recordPassedRun(ledger, seeded.repo, runId);
      git(
        seeded.repo,
        "update-ref",
        `refs/no-mistakes/recover/${runId}`,
        git(seeded.repo, "rev-parse", "HEAD"),
      );
      ledger.close();
      await writeFile(
        marker,
        JSON.stringify({
          createdAt: new Date().toISOString(),
          gate,
          originWorktree: seeded.repo,
          runId,
          terminalHandle: "term-dead",
        }),
      );

      await main(["prune", "--stranded", "--repo", seeded.repo]);

      const reopened = new DomainLedger({ repositoryPath: seeded.repo });
      try {
        assert.equal(reopened.runStatus(runId), "passed");
      } finally {
        reopened.close();
      }
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(canonicalGate), false);
      assert.equal(git(seeded.repo, "branch", "--list", branch), "");
      assert.equal(
        (await recordedCalls(fake.calls)).some(
          (args) => args[0] === "orchestration",
        ),
        false,
      );
    } finally {
      restore();
      await rm(seeded.temp, { force: true, recursive: true });
    }
  });
}
