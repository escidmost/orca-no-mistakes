import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { parseGateResolution } from "../scripts/orca-no-mistakes.ts";

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

function findingGate(count = 2): PresentationSnapshot {
  const snapshot = gateSnapshot("open", 1);
  const stage = snapshot.stages.find((item) => item.id === "review")!;
  stage.findings = Array.from({ length: count }, (_, index) => ({
    id: `finding-${index + 1}`,
    description: `Problem ${index + 1} needs a decision.`,
    disposition: "open" as const,
    severity: "warning" as const,
    file: "scripts/example.ts",
    line: index + 10,
  }));
  stage.openFindings = count;
  stage.actionableFindings = count;
  stage.totalFindings = count;
  return snapshot;
}

async function frame(output: FakeOutput): Promise<string> {
  await new Promise((resolve) => setImmediate(resolve));
  return stripVTControlCharacters(output.writes.at(-1) ?? "");
}

test("finding choices submit a selective canonical fix only after every choice and confirmation", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const resolutions: string[] = [];
  const toggles: boolean[] = [];
  const renderer = new RailTuiRenderer(input, output, "/unused", new Map(),
    async (_id, resolution) => { resolutions.push(resolution); },
    () => {}, (enabled) => { toggles.push(enabled); });
  const snapshot = findingGate();
  try {
    renderer.render(snapshot);
    assert.match(await frame(output), /Problem 1 needs a/);
    assert.match(await frame(output), /scripts\/example.ts:10/);
    input.emit("data", "F\r\r");
    assert.deepEqual(resolutions, []);
    assert.match(await frame(output), /Choose Fix or Approve/);
    input.emit("data", "\u001b[BA\r\r");
    assert.deepEqual(toggles, [], "A approves a finding instead of enabling auto-fix");
    assert.deepEqual(resolutions, [], "a pasted pair of Enter keys cannot confirm");
    assert.match(await frame(output), /Confirm 1 fix, 1 approve/);
    input.emit("data", "\r");
    input.emit("data", "AFr\r\u001b[B");
    assert.equal(resolutions.length, 1);
    assert.deepEqual(JSON.parse(resolutions[0]), { action: "fix", findingIds: ["finding-1"] });
    const parsed = parseGateResolution(resolutions[0], snapshot.stages.find((s) => s.id === "review")!.findings!
      .map((finding) => ({ ...finding, action: "ask-user" as const })));
    assert.equal(parsed.action, "fix");
    assert.deepEqual(parsed.selectedFindings.map((finding) => finding.id), ["finding-1"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(await frame(output), /Decision sent/);
  } finally { renderer.close(); }
});

test("all approvals submit approve and settled findings are excluded", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const resolutions: string[] = [];
  const renderer = new RailTuiRenderer(input, output, "/unused", new Map(),
    async (_id, resolution) => { resolutions.push(resolution); });
  const snapshot = findingGate(3);
  const findings = snapshot.stages.find((s) => s.id === "review")!.findings!;
  findings[1].disposition = "fixed";
  findings[2].disposition = "approved";
  try {
    renderer.render(snapshot);
    assert.doesNotMatch(await frame(output), /finding-[23]/);
    input.emit("data", "a\r");
    input.emit("data", "\r");
    assert.deepEqual(resolutions, ["approve"]);
  } finally { renderer.close(); }
});

test("failed submission retains choices and requires a fresh confirmation", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const resolutions: string[] = [];
  const renderer = new RailTuiRenderer(input, output, "/unused", new Map(),
    async (_id, resolution) => {
      resolutions.push(resolution);
      if (resolutions.length === 1) throw new Error("transport unavailable");
    });
  try {
    renderer.render(findingGate());
    input.emit("data", "f\u001b[Bf\r");
    input.emit("data", "\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(await frame(output), /Could not resolve gate/);
    input.emit("data", "\r\r");
    assert.equal(resolutions.length, 1);
    const confirmation = await frame(output);
    assert.match(confirmation, /Confirm 2 fix, 0 approve/);
    assert.doesNotMatch(confirmation, /Could not resolve gate/);
    input.emit("data", "\r");
    assert.equal(resolutions.length, 2);
    assert.deepEqual(JSON.parse(resolutions[1]), { action: "fix", findingIds: ["finding-1", "finding-2"] });
  } finally { renderer.close(); }
});

test("narrow finding editor navigates every finding and scrolls long descriptions", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 40;
  output.rows = 18;
  const renderer = new RailTuiRenderer(input, output, "/unused");
  const snapshot = findingGate(12);
  snapshot.stages.find((s) => s.id === "review")!.findings![0].description = "Long explanation. ".repeat(40) + "END OF FINDING";
  try {
    renderer.render(snapshot);
    await frame(output);
    let reachedEnd = false;
    for (let index = 0; index < 30; index++) {
      input.emit("data", "\u001b[6~");
      if ((await frame(output)).includes("END OF FINDING")) { reachedEnd = true; break; }
    }
    assert.ok(reachedEnd, "page scrolling exposes the end of the long description");
    input.emit("data", "\u001b[B".repeat(11));
    assert.match(await frame(output), /12\/12/);
    assert.match(await frame(output), /finding-12/);
    input.emit("data", "\u001b[A".repeat(11));
    assert.match(await frame(output), /DECISION REQUIRED/);
  } finally { renderer.close(); }
});

test("duplicate IDs share a visible decision because canonical fixes select IDs", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.rows = 40;
  const resolutions: string[] = [];
  const renderer = new RailTuiRenderer(input, output, "/unused", new Map(),
    async (_id, resolution) => { resolutions.push(resolution); });
  const snapshot = findingGate();
  snapshot.stages.find((s) => s.id === "review")!.findings![1].id = "finding-1";
  try {
    renderer.render(snapshot);
    assert.match(await frame(output), /Choice applies to all findings/);
    input.emit("data", "f\u001b[Ba\r");
    input.emit("data", "\r");
    assert.deepEqual(resolutions, ["approve"]);
  } finally { renderer.close(); }
});
