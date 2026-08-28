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
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DomainLedger, main } from "../scripts/orca-no-mistakes.ts";

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

async function seedTerminalRetry(status: "failed" | "passed") {
  const temp = await mkdtemp(path.join(tmpdir(), `onm-${status}-branch-retry-`));
  const repo = path.join(temp, "repo");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  git(repo, "-c", "init.templateDir=", "init", "-b", "feature");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  const canonicalRepo = await realpath(repo);
  const runId = `run-${status}-branch-retry`;
  const gateName = `no-mistakes-gate-${runId}`;
  const branch = `evs/${gateName}`;
  const gatePath = path.join(temp, gateName);
  git(canonicalRepo, "worktree", "add", "-b", branch, gatePath);
  const canonicalGate = await realpath(gatePath);
  const gateHead = git(canonicalGate, "rev-parse", "HEAD");
  git(
    canonicalRepo,
    "update-ref",
    `refs/no-mistakes/recover/${runId}`,
    gateHead,
  );
  git(canonicalRepo, "worktree", "remove", canonicalGate);
  const gateId = `repo::${canonicalGate}`;
  const calls = path.join(temp, "calls.jsonl");
  const orcaCommand = path.join(temp, "orca");
  await writeFile(
    orcaCommand,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [{
  id: ${JSON.stringify(`repo::${canonicalRepo}`)},
  path: ${JSON.stringify(canonicalRepo)},
  branch: "refs/heads/feature",
  head: ${JSON.stringify(gateHead)}
}] })
else if (args[0] === "orchestration" && args[1] === "task-list") out({ tasks: [{ id: "task-failed", status: "ready" }] })
else if (args[0] === "orchestration" && args[1] === "task-update") out({ task: { id: "task-failed", status: "failed" } })
else out({ accepted: true })
`,
  );
  await chmod(orcaCommand, 0o755);
  const restore = setEnv(path.join(temp, "home"), orcaCommand);
  const ledger = new DomainLedger();
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "terminal branch cleanup retry",
    policySha256: "f".repeat(64),
    repoRoot: canonicalRepo,
    runId,
    submissionCommitOid: gateHead,
  });
  assert.equal(ledger.finishRun(runId, status, gateHead), true);
  ledger.close();
  const marker = markerPath(canonicalRepo, gateId);
  await writeFile(
    marker,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      gate: { branch, id: gateId, kind: "orca", path: canonicalGate },
      originWorktree: canonicalRepo,
      runId,
      terminalHandle: "term-dead",
    }),
  );
  return {
    branch,
    calls,
    gateHead,
    marker,
    repo: canonicalRepo,
    restore,
    runId,
    status,
    temp,
  };
}

for (const status of ["passed", "failed"] as const) {
  test(`stranded cleanup retries a namespaced branch after a run ${status}`, async () => {
    const seeded = await seedTerminalRetry(status);
    try {
      await main(["prune", "--stranded", "--repo", seeded.repo]);

      const ledger = new DomainLedger();
      try {
        assert.equal(ledger.runStatus(seeded.runId), status);
      } finally {
        ledger.close();
      }
      assert.equal(existsSync(seeded.marker), false);
      assert.equal(git(seeded.repo, "branch", "--list", seeded.branch), "");
      assert.equal(
        git(
          seeded.repo,
          "rev-parse",
          `refs/no-mistakes/recover/${seeded.runId}`,
        ),
        seeded.gateHead,
      );
      const calls = (await readFile(seeded.calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(
        calls.some((args) => args[0] === "orchestration"),
        status === "failed",
      );
    } finally {
      seeded.restore();
      await rm(seeded.temp, { force: true, recursive: true });
    }
  });
}

test("post-pass cleanup uses the attested candidate without another head read", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../scripts/orca-no-mistakes.ts", import.meta.url)),
    "utf8",
  );
  const start = source.indexOf("const result = await runPipeline(");
  const end = source.indexOf("await orca.notifyRunResult(", start);
  assert.ok(start >= 0 && end > start);
  const postPassSetup = source.slice(start, end);
  assert.match(
    postPassSetup,
    /gateCleanupOid = result\.attestation\?\.candidateCommitOid \?\? gateCleanupOid;/u,
  );
  assert.doesNotMatch(postPassSetup, /await git\.head\(\)/u);
});
