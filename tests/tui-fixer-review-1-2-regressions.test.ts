import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PIPELINE_STEPS } from "../scripts/config.ts";
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

function screen(output: FakeOutput): string {
  return (output.writes.at(-1) ?? "")
    .replace(new RegExp("^.*\\x1b\\[H\\x1b\\[2J", "u"), "")
    .replaceAll(new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "gu"), "");
}

async function nextDraw(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("rail keeps the retained marker inside the rail width", async () => {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-rail-"));
  const input = new FakeInput();
  const output = new FakeOutput();
  const snapshot: PresentationSnapshot = {
    attempt: 1,
    currentStage: "lint",
    mode: { autoFix: true },
    runId: "run-rail-retained",
    sequence: 1,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      id,
      retainedFixer: id === "document",
      round: 1,
      status:
        id === "document"
          ? "cancelled"
          : id === "lint"
            ? "active"
            : "pending",
      totalFindings: 0,
    })),
    status: "in-progress",
    transition: { kind: "round-started", round: 1, stage: "lint" },
    updatedAt: new Date(0).toISOString(),
    version: 1,
  };
  const renderer = new RailTuiRenderer(input, output, artifactsDir);
  try {
    renderer.render(snapshot);
    await nextDraw();
    assert.match(screen(output), /5\. Document cancelled retained/u);
  } finally {
    renderer.close();
    rmSync(artifactsDir, { force: true, recursive: true });
  }
});
