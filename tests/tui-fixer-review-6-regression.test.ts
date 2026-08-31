import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
    runId: "run-tui-fixer-review-6",
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

test("log reads stay bound across an ancestor swap at open", async (context) => {
  const temp = mkdtempSync(path.join(tmpdir(), "orca-tui-open-race-"));
  const artifactRoot = path.join(temp, "artifacts");
  const artifactsDir = path.join(artifactRoot, "run");
  const movedRoot = path.join(temp, "moved-artifacts");
  const outsideRoot = path.join(temp, "outside");
  const outsideRun = path.join(outsideRoot, "run");
  const logPath = path.join(artifactsDir, "review_r0.log");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(outsideRun, { recursive: true });
  writeFileSync(path.join(outsideRun, "review_r0.log"), "escaped log\n");
  const log = new StageLog(logPath);
  await log.append("trusted log\n");
  const input = new FakeInput();
  const output = new FakeOutput();
  const renderer = new RailTuiRenderer(
    input,
    output,
    artifactsDir,
    new Map([[path.resolve(logPath), log]]),
  );
  const originalOpenSync = fs.openSync;
  context.mock.method(fs, "openSync", (
    filePath: Parameters<typeof originalOpenSync>[0],
    flags: Parameters<typeof originalOpenSync>[1],
    mode: Parameters<typeof originalOpenSync>[2],
  ) => {
    if (path.resolve(String(filePath)) === path.resolve(logPath)) {
      renameSync(artifactRoot, movedRoot);
      symlinkSync(outsideRoot, artifactRoot);
    }
    return originalOpenSync(filePath, flags, mode);
  });
  syncBuiltinESMExports();
  try {
    renderer.render(snapshot());
    const screen = output.writes.at(-1) ?? "";
    assert.match(screen, /trusted log/u);
    assert.doesNotMatch(screen, /escaped log/u);
  } finally {
    renderer.close();
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await log.close();
    rmSync(temp, { force: true, recursive: true });
  }
});
