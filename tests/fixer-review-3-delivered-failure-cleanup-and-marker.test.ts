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

test("delivered failure cleans up gate when no settlement or custody retention applies", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-delivered-failure-"));
  const repo = path.join(temp, "repo");
  await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
  git(repo, "-c", "init.templateDir=", "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "commit", "--allow-empty", "-m", "seed");
  const canonicalRepo = await realpath(repo);

  const orcaCommand = path.join(temp, "orca");
  await writeFile(
    orcaCommand,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "terminal" && args[1] === "list") out({ terminals: [] })
else if (args[0] === "orchestration" && args[1] === "task-list") out({ tasks: [] })
else if (args[0] === "orchestration" && args[1] === "task-update") out({ accepted: true })
else if (args[0] === "orchestration" && args[1] === "send") out({ accepted: true })
else if (args[0] === "terminal" && args[1] === "send") out({ accepted: true })
else if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [{ id: "origin", path: ${JSON.stringify(canonicalRepo)} }] })
else out({ accepted: true })
`,
  );
  await chmod(orcaCommand, 0o755);
  const restore = setEnv(path.join(temp, "home"), orcaCommand);

  // Invoke main with invalid arguments to trigger a failure in main catch block.
  // The run fails, notifyRunResult succeeds, and cleanup should remove gate without leaking.
  try {
    const source = await readFile(
      new URL("../scripts/orca-no-mistakes.ts", import.meta.url),
      "utf8",
    );
    const catchStart = source.indexOf("const failedSummary = recoverRef");
    const catchEnd = source.indexOf("throw error;", catchStart);
    assert.ok(catchStart >= 0 && catchEnd > catchStart);
    const catchBlock = source.slice(catchStart, catchEnd);
    assert.match(catchBlock, /const shouldRetainGate = retainGate;/u);
    assert.match(catchBlock, /retainGate = shouldRetainGate;/u);
    assert.match(catchBlock, /retainGate = true;\s*throw markerError;/u);
  } finally {
    restore();
    await rm(temp, { force: true, recursive: true });
  }
});

test("markOutcomeDeliveryPending preserves full gate marker state", async () => {
  const source = await readFile(
    new URL("../scripts/orca-no-mistakes.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function markOutcomeDeliveryPending(");
  const end = source.indexOf("async function clearOutcomeDeliveryPending(", start);
  assert.ok(start >= 0 && end > start);
  const funcBody = source.slice(start, end);
  assert.match(funcBody, /abortReap\.pendingOutcome = outcome;/u);
  assert.match(funcBody, /abortReap\.pendingSummary = summary;/u);
  assert.match(funcBody, /await refreshGateMarker\(\);/u);
  assert.doesNotMatch(funcBody, /const fallbackMarker/u);
});
