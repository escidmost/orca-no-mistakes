import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

function stageSnapshot(sequence: number): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: "review",
    mode: { autoFix: false },
    runId: "run-tui-fixer-review-1",
    sequence,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      id,
      round: 1,
      status: id === "review" ? "active" : "pending",
      totalFindings: 0,
    })),
    status: "in-progress",
    transition: { kind: "round-started", round: 1, stage: "review" },
    updatedAt: new Date(0).toISOString(),
    version: 1,
  };
}

function gateSnapshot(
  state: "open" | "resolved",
  sequence: number,
): PresentationSnapshot {
  const base = stageSnapshot(sequence);
  const options = ["approve", "fix", "skip", "stop"];
  return {
    ...base,
    gate: {
      id: "gate-review",
      options,
      question: "Choose a decision.",
      round: 1,
      stage: "review",
      state,
    },
    stages: base.stages.map((stage) =>
      stage.id === "review"
        ? { ...stage, status: state === "open" ? "blocked" : "active" }
        : stage,
    ),
    transition:
      state === "open"
        ? {
            gateId: "gate-review",
            kind: "gate-opened",
            options,
            question: "Choose a decision.",
            round: 1,
            stage: "review",
          }
        : {
            decision: "approve",
            gateId: "gate-review",
            kind: "gate-resolved",
            round: 1,
            stage: "review",
          },
  };
}

test("lone Escape cannot reopen a submitting gate", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const resolutions: string[] = [];
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const renderer = new RailTuiRenderer(
    input,
    output,
    "/unused",
    new Map(),
    async (_gateId, resolution) => {
      resolutions.push(resolution);
      await pending;
    },
  );

  try {
    renderer.render(stageSnapshot(0));
    input.emit("data", "\r");
    renderer.render(gateSnapshot("open", 1));
    input.emit("data", "\r\r");
    assert.deepEqual(resolutions, []);
    input.emit("data", "\r");
    input.emit("data", "\u001b");
    await new Promise((resolve) => setTimeout(resolve, 120));
    input.emit("data", "g\r\r");
    assert.deepEqual(resolutions, ["approve"]);
    assert.match(output.writes.at(-1) ?? "", /DECISION REQUIRED/u);
    settle();
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    renderer.render(gateSnapshot("resolved", 2));
    assert.match(output.writes.at(-1) ?? "", /pinned Review/u);
  } finally {
    settle();
    await pending;
    renderer.close();
  }
});

test("resolved gate options cannot reopen the decision panel", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const renderer = new RailTuiRenderer(input, output, "/unused");

  try {
    renderer.render(gateSnapshot("open", 1));
    renderer.render(gateSnapshot("resolved", 2));
    input.emit("data", "g");
    assert.doesNotMatch(output.writes.at(-1) ?? "", /DECISION REQUIRED/u);
  } finally {
    renderer.close();
  }
});
