import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs, {
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PIPELINE_STEPS } from "../scripts/config.ts";
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
  return output.writes.at(-1) ?? "";
}

function renderOnce(artifactsDir: string): string {
  const input = new FakeInput();
  const output = new FakeOutput();
  const renderer = new RailTuiRenderer(input, output, artifactsDir);
  try {
    renderer.render(snapshot(0));
    return screen(output);
  } finally {
    renderer.close();
  }
}

if (process.env.TUI_FIFO_FIXTURE === "1") {
  renderOnce(process.env.TUI_ARTIFACTS!);
} else {
  test("round zero logs reject worker-replaced paths", (context) => {
    const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-reader-"));
    const logPath = path.join(artifactsDir, "review_r0.log");
    const secretPath = path.join(artifactsDir, "secret.txt");
    try {
      writeFileSync(logPath, "round zero transcript\n");
      assert.match(renderOnce(artifactsDir), /round zero transcript/u);

      unlinkSync(logPath);
      writeFileSync(secretPath, "must not display\n");
      symlinkSync(secretPath, logPath);
      assert.doesNotMatch(renderOnce(artifactsDir), /must not display/u);

      unlinkSync(logPath);
      linkSync(secretPath, logPath);
      assert.doesNotMatch(renderOnce(artifactsDir), /must not display/u);

      unlinkSync(logPath);
      writeFileSync(logPath, "first\nsecond\nthird\n");
      const originalReadSync = fs.readSync;
      context.mock.method(
        fs,
        "readSync",
        (descriptor, buffer, offset, length, position) =>
          originalReadSync(
            descriptor,
            buffer,
            offset,
            Math.min(length, 3),
            position,
          ),
      );
      syncBuiltinESMExports();
      assert.match(renderOnce(artifactsDir), /third/u);
      context.mock.restoreAll();
      syncBuiltinESMExports();
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(artifactsDir, { force: true, recursive: true });
    }
  });

  test("FIFO logs cannot block rendering", { skip: process.platform === "win32" }, () => {
    const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-fifo-"));
    try {
      execFileSync("mkfifo", [path.join(artifactsDir, "review_r0.log")]);
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        env: {
          ...process.env,
          TUI_ARTIFACTS: artifactsDir,
          TUI_FIFO_FIXTURE: "1",
        },
        timeout: 2_000,
      });
      assert.equal(result.status, 0, result.error?.message);
    } finally {
      rmSync(artifactsDir, { force: true, recursive: true });
    }
  });

  test("split escape sequences remain single navigation keys", () => {
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
      assert.match(screen(output), /> Review round 2/u);
      input.emit("data", "\u001b");
      input.emit("data", "[Z");
      assert.match(screen(output), /> RAIL/u);
    } finally {
      renderer.close();
      rmSync(artifactsDir, { force: true, recursive: true });
    }
  });
}
