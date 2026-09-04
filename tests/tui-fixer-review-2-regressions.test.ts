import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PIPELINE_STEPS } from "../scripts/config.ts";
import { StageLog } from "../scripts/ledger.ts";
import type { PresentationSnapshot } from "../scripts/presentation.ts";
import { RailTuiRenderer } from "../scripts/tui.ts";

function snapshot(sequence: number, round = 0): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: "review",
    mode: { autoFix: true },
    runId: "run-tui-fixer-review-2",
    sequence,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      id,
      round,
      status: id === "review" ? "active" : "pending",
      totalFindings: 0,
    })),
    status: "in-progress",
    transition: { kind: "round-started", round: sequence, stage: "review" },
    updatedAt: new Date(0).toISOString(),
    version: 1,
  };
}

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

function screen(output: FakeOutput): string {
  return (output.writes.at(-1) ?? "").replaceAll(
    new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "gu"),
    "",
  );
}

async function renderOnce(
  artifactsDir: string,
  stageLogs: ReadonlyMap<string, StageLog> = new Map(),
): Promise<string> {
  const input = new FakeInput();
  const output = new FakeOutput();
  const renderer = new RailTuiRenderer(input, output, artifactsDir, stageLogs);
  try {
    renderer.render(snapshot(0));
    input.emit("data", "\r");
    await new Promise((resolve) => setImmediate(resolve));
    return screen(output);
  } finally {
    renderer.close();
  }
}

test("only coordinator-owned logs are displayed", async () => {
    const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-reader-"));
    const logPath = path.join(artifactsDir, "review_r0.log");
    const log = new StageLog(logPath);
    try {
      writeFileSync(logPath, "unregistered transcript\n");
      assert.doesNotMatch(await renderOnce(artifactsDir), /unregistered transcript/u);
      rmSync(logPath);
      await log.append("coordinator transcript\n");
      assert.match(
        await renderOnce(artifactsDir, new Map([[path.resolve(logPath), log]])),
        /coordinator transcript/u,
      );
    } finally {
      await log.close();
      rmSync(artifactsDir, { force: true, recursive: true });
    }
});

test("split escape sequences remain single navigation keys", async () => {
    const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-input-"));
    const input = new FakeInput();
    const output = new FakeOutput();
    const renderer = new RailTuiRenderer(input, output, artifactsDir);
    try {
      renderer.render(snapshot(1));
      renderer.render(snapshot(2));
      renderer.render(snapshot(3));
      input.emit("data", "\t");
      input.emit("data", "\u001b");
      input.emit("data", "[A");
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(screen(output), /> Review round 3/u);
      input.emit("data", "\u001b");
      input.emit("data", "[Z");
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(screen(output), /> STAGES/u);
    } finally {
      renderer.close();
      rmSync(artifactsDir, { force: true, recursive: true });
    }
});
