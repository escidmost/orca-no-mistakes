import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

function snapshot(sequence: number): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: "review",
    mode: { autoFix: true },
    runId: "run-tui-fixer-review-4",
    sequence,
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

test("log reads stay bound when artifact ancestors are replaced", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "orca-tui-identity-"));
  const artifactRoot = path.join(temp, "artifacts");
  const artifactsDir = path.join(artifactRoot, "run");
  const movedRoot = path.join(temp, "moved-artifacts");
  const outsideRoot = path.join(temp, "outside");
  const outsideRun = path.join(outsideRoot, "run");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(outsideRun, { recursive: true });
  const logPath = path.join(artifactsDir, "review_r0.log");
  const log = new StageLog(logPath);
  await log.append("trusted log\n");
  writeFileSync(path.join(outsideRun, "review_r0.log"), "escaped log\n");
  const input = new FakeInput();
  const output = new FakeOutput();
  const renderer = new RailTuiRenderer(
    input,
    output,
    artifactsDir,
    new Map([[path.resolve(logPath), log]]),
  );
  try {
    renderer.render(snapshot(1));
    input.emit("data", "\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(output.writes.at(-1) ?? "", /trusted log/u);

    renameSync(artifactRoot, movedRoot);
    symlinkSync(outsideRoot, artifactRoot);
    renderer.render(snapshot(2));
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(output.writes.at(-1) ?? "", /trusted log/u);
    assert.doesNotMatch(output.writes.at(-1) ?? "", /escaped log/u);

    unlinkSync(artifactRoot);
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(path.join(artifactsDir, "review_r0.log"), "replacement log\n");
    renderer.render(snapshot(3));
    await new Promise((resolve) => setImmediate(resolve));
    assert.doesNotMatch(output.writes.at(-1) ?? "", /replacement log/u);
  } finally {
    renderer.close();
    await log.close();
    rmSync(temp, { force: true, recursive: true });
  }
});
