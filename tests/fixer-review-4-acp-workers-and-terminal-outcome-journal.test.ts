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

test("prune retains gate marker whose delivery state is unknown for settled passed run", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-unknown-delivery-"));
  const repo = path.join(temp, "repo");
  const runsRoot = path.join(temp, "runs");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await mkdir(runsRoot);
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  const canonicalRepo = await realpath(repo);
  const runId = "run-settled-passed";
  const gatePath = path.join(runsRoot, runId);
  git(canonicalRepo, "worktree", "add", "-b", `no-mistakes-gate-${runId}`, gatePath);

  const orcaCommand = path.join(temp, "orca");
  await writeFile(
    orcaCommand,
    `#!/usr/bin/env node
const out = (result) => console.log(JSON.stringify({ result }))
out({ accepted: true })
`,
  );
  await chmod(orcaCommand, 0o755);
  const restore = setEnv(path.join(temp, "home"), orcaCommand);

  const ledger = new DomainLedger({ repositoryPath: canonicalRepo });
  ledger.startRun({
    baseBranch: "main",
    branch: `no-mistakes-gate-${runId}`,
    intent: "test unknown delivery retention",
    policySha256: "a".repeat(64),
    repoRoot: canonicalRepo,
    runId,
    submissionCommitOid: git(canonicalRepo, "rev-parse", "HEAD"),
  });
  ledger.finishRun(runId, "passed", git(canonicalRepo, "rev-parse", "HEAD"));
  ledger.close();

  const gate = {
    branch: `no-mistakes-gate-${runId}`,
    intentTaskId: "task-intent",
    kind: "configured" as const,
    path: gatePath,
    root: runsRoot,
    runId,
  };
  const marker = markerPath(canonicalRepo, gatePath);
  await writeFile(
    marker,
    JSON.stringify({
      allocationProtocol: "gated-v1",
      createdAt: new Date().toISOString(),
      gate,
      originWorktree: canonicalRepo,
      pid: 99999999,
      runId,
    }),
  );

  try {
    await main(["prune", "--stranded", "--repo", canonicalRepo]);
    // The gate marker must be retained because run is passed but outcome delivery state is unknown
    assert.equal(existsSync(marker), true);
  } finally {
    restore();
    await rm(temp, { force: true, recursive: true });
  }
});

test("runPipeline writes pending outcome before finalizePassedRunWithLeaseMutation commits", async () => {
  const source = await readFile(
    new URL("../scripts/orca-no-mistakes.ts", import.meta.url),
    "utf8",
  );
  const markIdx = source.indexOf('await markOutcomeDeliveryPending("passed", passedSummary);');
  const finalizeIdx = source.indexOf("ledger.finalizePassedRunWithLeaseMutation(");
  assert.ok(markIdx >= 0, "markOutcomeDeliveryPending must be called");
  assert.ok(finalizeIdx >= 0, "finalizePassedRunWithLeaseMutation must be called");
  assert.ok(
    markIdx < finalizeIdx,
    "markOutcomeDeliveryPending must be called before finalizePassedRunWithLeaseMutation",
  );
});

test("ACP worker worktree creation applies run-scoped worker naming", async () => {
  const source = await readFile(
    new URL("../scripts/orca-no-mistakes.ts", import.meta.url),
    "utf8",
  );
  const startAcpIdx = source.indexOf("async #startAcpWorker(");
  const endAcpIdx = source.indexOf("async #claimWorkerBranch(", startAcpIdx);
  assert.ok(startAcpIdx >= 0 && endAcpIdx > startAcpIdx);
  const acpBlock = source.slice(startAcpIdx, endAcpIdx);
  assert.match(
    acpBlock,
    /"--name",\s*this\.#workerName\(launch\.name\)/u,
    "#startAcpWorker must pass this.#workerName(launch.name) to worktree create --name",
  );
});
