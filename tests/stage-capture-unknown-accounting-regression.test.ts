import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { StageLog } from "../scripts/ledger.ts";

test("a compacted log without accounting replaces its stale marker", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-unknown-accounting-"));
  const logPath = path.join(temp, "artifacts", "run", "review_r1.log");
  try {
    const first = new StageLog(logPath, 2_048);
    await first.append("A".repeat(3_000));
    await first.close();
    await rm(`${logPath}.meta`);

    const reopened = new StageLog(logPath, 2_048);
    await reopened.append("new suffix");
    await reopened.close();

    const transcript = await readFile(logPath, "utf8");
    assert.match(transcript, /original bytes unknown/);
    assert.match(transcript, /new suffix/);
    assert.doesNotMatch(transcript, /original bytes 3000/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
