import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { STAGE_LOG_TAIL_BYTES, StageLog } from "../scripts/ledger.ts";
import { registeredStageLog } from "../scripts/orca-no-mistakes.ts";

test("registered StageLog preserves the prior in-memory tail", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-stage-log-handoff-"));
  const logPath = path.join(temp, "review_r1.log");
  const stageLogs = new Map<string, StageLog>();
  try {
    const fixerLog = registeredStageLog(stageLogs, logPath);
    await fixerLog.append("fixer output\n");
    await fixerLog.close();
    await writeFile(logPath, "worker-writable pathname content\n");

    const reviewerLog = registeredStageLog(stageLogs, logPath);
    assert.equal(
      reviewerLog.tail(STAGE_LOG_TAIL_BYTES).toString(),
      "fixer output\n",
    );
    await reviewerLog.append("reviewer output\n");
    assert.equal(
      reviewerLog.tail(STAGE_LOG_TAIL_BYTES).toString(),
      "fixer output\nreviewer output\n",
    );
    await reviewerLog.close();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("registered StageLog redacts a secret split across handoff", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-stage-log-secret-handoff-"));
  const logPath = path.join(temp, "review_r1.log");
  const stageLogs = new Map<string, StageLog>();
  const secretName = "ONM_STAGE_LOG_HANDOFF_SECRET";
  const previousSecret = process.env[secretName];
  process.env[secretName] = "abcd1234";
  try {
    const fixerLog = registeredStageLog(stageLogs, logPath);
    await fixerLog.append("abcd");
    await fixerLog.close();

    const reviewerLog = registeredStageLog(stageLogs, logPath);
    await reviewerLog.append("1234\n");
    await reviewerLog.close();

    const content = await readFile(logPath, "utf8");
    assert.doesNotMatch(content, /abcd1234/u);
    assert.match(content, /\[REDACTED\]/u);
  } finally {
    if (previousSecret === undefined) delete process.env[secretName];
    else process.env[secretName] = previousSecret;
    await rm(temp, { recursive: true, force: true });
  }
});
