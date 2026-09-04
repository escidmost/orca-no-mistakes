import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PIPELINE_STEPS } from "../scripts/config.ts";
import { StageLog } from "../scripts/ledger.ts";
import type { PresentationSnapshot } from "../scripts/presentation.ts";
import { RailTuiRenderer } from "../scripts/tui.ts";

class FakeInput extends EventEmitter {
  readonly failure?: "pause" | "raw";
  isRaw = false;
  isTTY = true;
  paused = true;
  pauseCalls = 0;

  constructor(failure?: "pause" | "raw") {
    super();
    this.failure = failure;
  }

  isPaused(): boolean {
    return this.paused;
  }

  pause(): this {
    this.pauseCalls += 1;
    if (this.failure === "pause") throw new Error("pause failed");
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  setRawMode(mode: boolean): this {
    if (!mode && this.failure === "raw") throw new Error("raw restore failed");
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
    runId: "run-tui-fixer-review-5",
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

test("terminal output restoration survives input cleanup failures", () => {
  for (const failure of ["raw", "pause"] as const) {
    const input = new FakeInput(failure);
    const output = new FakeOutput();
    const renderer = new RailTuiRenderer(input, output, "/unused");
    assert.doesNotThrow(() => renderer.close());
    assert.equal(input.pauseCalls, 1);
    assert.equal(output.writes.at(-1), "\u001b[?25h\u001b[?1049l");
  }
});

test("terminal controls cannot reconstruct a known secret", async () => {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-controls-"));
  const logPath = path.join(artifactsDir, "review_r0.log");
  const log = new StageLog(logPath);
  const input = new FakeInput();
  const output = new FakeOutput();
  const secretName = "TUI_ANSI_REDACTION_TEST_TOKEN";
  const secret = "abcd1234";
  const previous = process.env[secretName];
  process.env[secretName] = secret;
  await log.append("abcd\u001b[31m1234\n");
  const renderer = new RailTuiRenderer(
    input,
    output,
    artifactsDir,
    new Map([[path.resolve(logPath), log]]),
  );
  try {
    renderer.render(snapshot());
    input.emit("data", "\r");
    await new Promise((resolve) => setImmediate(resolve));
    const screen = output.writes.at(-1) ?? "";
    assert.doesNotMatch(screen, new RegExp(secret, "u"));
    assert.doesNotMatch(screen, /abcd|1234/u);
    assert.match(screen, /\[REDACTED\]/u);
  } finally {
    renderer.close();
    await log.close();
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
    rmSync(artifactsDir, { force: true, recursive: true });
  }
});
