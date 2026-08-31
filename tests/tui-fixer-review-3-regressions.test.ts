import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PIPELINE_STEPS } from "../scripts/config.ts";
import { StageLog } from "../scripts/ledger.ts";
import type { PresentationSnapshot } from "../scripts/presentation.ts";
import { RailTuiRenderer } from "../scripts/tui.ts";

class FakeInput extends EventEmitter {
  isRaw = false;
  isTTY = true;
  paused = true;

  isPaused(): boolean {
    return this.paused;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

class FakeOutput extends EventEmitter {
  columns = 100;
  isTTY = true;
  rows = 24;
  readonly writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

function snapshot(): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: "review",
    mode: { autoFix: true },
    runId: "run-tui-fixer-review-3",
    sequence: 1,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      id,
      round: 0,
      status: id === "review" ? "active" : "pending",
      totalFindings: 0,
    })),
    status: "in-progress",
    transition: { kind: "round-started", round: 0, stage: "review" },
    updatedAt: new Date(0).toISOString(),
    version: 1,
  };
}

test("live log redraws reuse StageLog redaction and stop on close", async () => {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-refresh-"));
  const logPath = path.join(artifactsDir, "review_r0.log");
  const log = new StageLog(logPath);
  const input = new FakeInput();
  const output = new FakeOutput();
  const secretName = "TUI_REDACTION_TEST_TOKEN";
  const secret = "stage-log-boundary-secret-value";
  const previous = process.env[secretName];
  process.env[secretName] = secret;
  await log.append(
    `${"x".repeat(100)}${secret}${"y".repeat(64 * 1024 - 16)}`,
  );
  const renderer = new RailTuiRenderer(
    input,
    output,
    artifactsDir,
    new Map([[path.resolve(logPath), log]]),
  );
  try {
    renderer.render(snapshot());
    const initial = output.writes.at(-1) ?? "";
    assert.doesNotMatch(initial, new RegExp(secret, "u"));
    assert.match(initial, /\[REDACTED\]/u);

    await log.append("\nupdated while running\n");
    const deadline = Date.now() + 1_000;
    while (!(output.writes.at(-1) ?? "").includes("updated while running")) {
      assert.ok(Date.now() < deadline, "live log did not refresh");
      await delay(25);
    }

    renderer.close();
    const writesAfterClose = output.writes.length;
    await log.append("must not redraw\n");
    await delay(300);
    assert.equal(output.writes.length, writesAfterClose);
  } finally {
    renderer.close();
    await log.close();
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
    rmSync(artifactsDir, { force: true, recursive: true });
  }
});
