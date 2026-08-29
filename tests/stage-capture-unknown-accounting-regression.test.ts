import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { StageLog } from "../scripts/ledger.ts";

test("a compacted log without accounting preserves bytes and reports unknown accounting", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-unknown-accounting-"));
  const logPath = path.join(temp, "artifacts", "run", "review_r1.log");
  try {
    const first = new StageLog(logPath, 2_048);
    await first.append("A".repeat(3_000));
    await first.close();
    const compacted = await readFile(logPath, "utf8");
    await rm(`${logPath}.meta`);

    const reopened = new StageLog(logPath, 2_048);
    await reopened.append("new suffix");
    await reopened.close();

    const transcript = await readFile(logPath, "utf8");
    assert.equal(transcript.startsWith(compacted), true);
    assert.match(
      transcript,
      /new suffix\n\[no-mistakes: log accounting unavailable; original bytes unknown; retained ranges unknown\]\n$/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("an under-cap log without accounting preserves all output", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-unknown-under-cap-"));
  const logPath = path.join(temp, "artifacts", "run", "review_r1.log");
  try {
    const first = new StageLog(logPath, 2_048);
    await first.append("A".repeat(1_500));
    await first.close();
    await rm(`${logPath}.meta`);

    const reopened = new StageLog(logPath, 2_048);
    await reopened.append("B".repeat(100));
    await reopened.close();

    const transcript = await readFile(logPath, "utf8");
    assert.equal(transcript.startsWith(`${"A".repeat(1_500)}${"B".repeat(100)}`), true);
    assert.doesNotMatch(transcript, /log truncated/);
    assert.match(transcript, /log accounting unavailable; original bytes unknown/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
