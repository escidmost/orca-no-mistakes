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

test("abort path journals cancelled pending outcome before settling domain run", async () => {
  const source = await readFile(
    new URL("../scripts/orca-no-mistakes.ts", import.meta.url),
    "utf8",
  );
  const reapIdx = source.indexOf("export async function reapAbortedRun(");
  assert.ok(reapIdx >= 0, "reapAbortedRun must exist");
  const markIdx = source.indexOf('await markOutcomeDeliveryPending("cancelled", summary);', reapIdx);
  const settleIdx = source.indexOf('cancelled = ledger.settleRun(', reapIdx);
  assert.ok(markIdx >= 0, "markOutcomeDeliveryPending must be called in reapAbortedRun");
  assert.ok(settleIdx >= 0, "ledger.settleRun must be called in reapAbortedRun");
  assert.ok(
    markIdx < settleIdx,
    "markOutcomeDeliveryPending must be called before ledger.settleRun in reapAbortedRun",
  );
});

test("runPipeline writes pending outcome with custody note during and after lease mutation", async () => {
  const source = await readFile(
    new URL("../scripts/orca-no-mistakes.ts", import.meta.url),
    "utf8",
  );
  const finalizeIdx = source.indexOf("ledger.finalizePassedRunWithLeaseMutation(");
  assert.ok(finalizeIdx >= 0, "finalizePassedRunWithLeaseMutation must be called");
  const endFinalizeIdx = source.indexOf("return { attestation, custodyNote };", finalizeIdx);
  assert.ok(endFinalizeIdx > finalizeIdx);
  const finalizeBlock = source.slice(finalizeIdx, endFinalizeIdx);
  assert.ok(
    finalizeBlock.includes('await markOutcomeDeliveryPending(\n                "passed",\n                `${passedSummary}\\n${note}`,') ||
    finalizeBlock.includes('markOutcomeDeliveryPending(\n                "passed",'),
    "finalizePassedRunWithLeaseMutation callback must journal custody note before committing",
  );
  assert.ok(
    finalizeBlock.includes('await markOutcomeDeliveryPending(\n        "passed",\n        `${passedSummary}\\n${custodyNote}`,'),
    "runPipeline must journal custody note upon return from finalizePassedRunWithLeaseMutation",
  );
});

test("deliverPendingOutcome reconstructs custody note and recovery instructions when missing from passed pending outcome", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-custody-reconstruct-"));
  const repo = path.join(temp, "repo");
  const runsRoot = path.join(temp, "runs");
  const logFile = path.join(temp, "orca-calls.log");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  await mkdir(runsRoot);
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  const canonicalRepo = await realpath(repo);
  const canonicalRunsRoot = await realpath(runsRoot);
  const runId = "run-custody-reconstruct";
  const gatePath = path.join(canonicalRunsRoot, runId);
  git(canonicalRepo, "worktree", "add", "-b", `no-mistakes-gate-${runId}`, gatePath);

  const orcaCommand = path.join(temp, "orca");
  await writeFile(
    orcaCommand,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.ORCA_TEST_LOG, JSON.stringify(process.argv) + "\\n");
const out = (result) => console.log(JSON.stringify({ result }));
out({ accepted: true });
`,
  );
  await chmod(orcaCommand, 0o755);
  process.env.ORCA_TEST_LOG = logFile;
  const restore = setEnv(path.join(temp, "home"), orcaCommand);

  const headOid = git(canonicalRepo, "rev-parse", "HEAD");
  const ledger = new DomainLedger({ repositoryPath: canonicalRepo });
  ledger.startRun({
    baseBranch: "main",
    branch: `no-mistakes-gate-${runId}`,
    intent: "test custody note reconstruction",
    policySha256: "b".repeat(64),
    repoRoot: canonicalRepo,
    runId,
    submissionCommitOid: headOid,
  });
  ledger.finishRun(runId, "passed", headOid);
  ledger.close();

  const gate = {
    branch: `no-mistakes-gate-${runId}`,
    intentTaskId: "task-intent",
    kind: "configured" as const,
    path: gatePath,
    root: canonicalRunsRoot,
    runId,
  };
  const marker = markerPath(canonicalRepo, gatePath);
  await writeFile(
    marker,
    JSON.stringify({
      allocationProtocol: "gated-v1",
      createdAt: new Date().toISOString(),
      gate,
      notifyHandle: "term_test_handle",
      originWorktree: canonicalRepo,
      pendingOutcome: "passed",
      pendingSummary: `Run ${runId} passed all 4 stages.\nCandidate commit: ${headOid}.`,
      pid: 99999999,
      runId,
    }),
  );

  try {
    await main(["prune", "--stranded", "--repo", canonicalRepo]);
    assert.equal(existsSync(logFile), true, "orca should have been called");
    const logContent = await readFile(logFile, "utf8");
    const parsedCalls = logContent
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const notifyCall = parsedCalls.find((args) => args.includes("orchestration") && args.includes("send"));
    assert.ok(notifyCall, "orchestration send should have been called");
    const bodyIdx = notifyCall.indexOf("--body");
    assert.ok(bodyIdx >= 0, "--body must be passed");
    const body = notifyCall[bodyIdx + 1];
    assert.ok(
      body.includes("advanced branch") ||
      body.includes("already at submission commit") ||
      body.includes("operator checkout diverged"),
      `expected custody status in delivered body, got: ${body}`,
    );
  } finally {
    delete process.env.ORCA_TEST_LOG;
    restore();
    await rm(temp, { force: true, recursive: true });
  }
});
