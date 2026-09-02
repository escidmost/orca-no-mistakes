import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PIPELINE_STEPS } from "../scripts/config.ts";
import type { PresentationSnapshot } from "../scripts/presentation.ts";
import { RailTuiRenderer } from "../scripts/tui.ts";

function snapshot(sequence: number): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: "review",
    mode: { autoFix: true },
    runId: "run-tui-string-reply",
    sequence,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      id,
      round: 1,
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
  return (output.writes.at(-1) ?? "")
    .replace(new RegExp("^.*\\x1b\\[H\\x1b\\[2J", "u"), "")
    .replaceAll(new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "gu"), "");
}

async function nextDraw(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("control keys terminate pending string replies", async () => {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-reply-"));
  const input = new FakeInput();
  const output = new FakeOutput();
  let cancels = 0;
  let autoFixCalls = 0;
  const renderer = new RailTuiRenderer(
    input,
    output,
    artifactsDir,
    new Map(),
    undefined,
    () => {
      cancels += 1;
    },
    () => {
      autoFixCalls += 1;
    },
  );
  try {
    renderer.render(snapshot(1));
    await nextDraw();

    input.emit("data", "\u001b]");
    input.emit("data", "\u0003");
    await nextDraw();
    assert.equal(cancels, 1);
    assert.equal(autoFixCalls, 0);
  } finally {
    renderer.close();
    rmSync(artifactsDir, { force: true, recursive: true });
  }
});

test("terminated string replies stay inert", async () => {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-reply-"));
  const input = new FakeInput();
  const output = new FakeOutput();
  let cancels = 0;
  let autoFixCalls = 0;
  const renderer = new RailTuiRenderer(
    input,
    output,
    artifactsDir,
    new Map(),
    undefined,
    () => {
      cancels += 1;
    },
    () => {
      autoFixCalls += 1;
    },
  );
  try {
    renderer.render(snapshot(1));
    await nextDraw();

    input.emit("data", "\u001b]11;crab;rgb:1/2/3\u0007");
    input.emit("data", "\u001bPcr$\u001b\\");
    await nextDraw();
    assert.equal(cancels, 0);
    assert.equal(autoFixCalls, 0);
    assert.doesNotMatch(screen(output), /CANCEL RUN/u);
  } finally {
    renderer.close();
    rmSync(artifactsDir, { force: true, recursive: true });
  }
});

test("aborted string replies do not leak body bytes as commands", async () => {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-reply-"));
  const input = new FakeInput();
  const output = new FakeOutput();
  let cancels = 0;
  let autoFixCalls = 0;
  const renderer = new RailTuiRenderer(
    input,
    output,
    artifactsDir,
    new Map(),
    undefined,
    () => {
      cancels += 1;
    },
    () => {
      autoFixCalls += 1;
    },
  );
  try {
    renderer.render(snapshot(1));
    await nextDraw();

    input.emit("data", "\u001bPac\u0003");
    await nextDraw();
    assert.equal(cancels, 1);
    assert.equal(autoFixCalls, 0);
  } finally {
    renderer.close();
    rmSync(artifactsDir, { force: true, recursive: true });
  }
});

test("oversized pending replies are dropped instead of absorbing keys", async () => {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-reply-"));
  const input = new FakeInput();
  const output = new FakeOutput();
  let cancels = 0;
  const renderer = new RailTuiRenderer(
    input,
    output,
    artifactsDir,
    new Map(),
    undefined,
    () => {
      cancels += 1;
    },
  );
  try {
    renderer.render(snapshot(1));
    await nextDraw();

    input.emit("data", `\u001b]${"a".repeat(5000)}`);
    input.emit("data", "c");
    await nextDraw();
    assert.equal(cancels, 0);
    assert.match(screen(output), /CANCEL RUN/u);

    input.emit("data", "\u0003");
    await nextDraw();
    assert.equal(cancels, 1);
  } finally {
    renderer.close();
    rmSync(artifactsDir, { force: true, recursive: true });
  }
});

test("abandoned string replies do not fire the escape action", async () => {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-reply-"));
  const input = new FakeInput();
  const output = new FakeOutput();
  const renderer = new RailTuiRenderer(input, output, artifactsDir);
  try {
    renderer.render(snapshot(1));
    await nextDraw();

    input.emit("data", "c");
    await nextDraw();
    assert.match(screen(output), /CANCEL RUN/u);

    input.emit("data", "\u001b]");
    await sleep(150);
    assert.match(screen(output), /CANCEL RUN/u);

    input.emit("data", "\u001b");
    await sleep(150);
    assert.doesNotMatch(screen(output), /CANCEL RUN/u);
  } finally {
    renderer.close();
    rmSync(artifactsDir, { force: true, recursive: true });
  }
});
