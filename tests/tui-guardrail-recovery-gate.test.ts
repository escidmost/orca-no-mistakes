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
  isPaused(): boolean { return this.paused; }
  pause(): this { this.paused = true; return this; }
  resume(): this { this.paused = false; return this; }
  setRawMode(mode: boolean): this { this.isRaw = mode; return this; }
}

class FakeOutput extends EventEmitter {
  columns = 120;
  isTTY = true;
  rows = 30;
  readonly writes: string[] = [];
  write(chunk: string): boolean { this.writes.push(chunk); return true; }
}

const cleanScreen = (screen: string): string =>
  screen.replace(/\[[0-9;?]*[a-zA-Z]/gu, "").replace(/\r/gu, "");
const nextDraw = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

function guardrailGateSnapshot(autoFix: boolean): PresentationSnapshot {
  const options = ["approve", "fix", "stop"];
  const question =
    "[guardrails: strict] Fixer candidate abc123 is retained at /wt. Approve applies this exact candidate.";
  return {
    attempt: 1,
    currentStage: "review",
    gate: { gateKind: "guardrail", id: "gate-guardrail", options, question, round: 1, stage: "review", state: "open" },
    mode: { autoFix },
    runId: "run-guardrail-gate",
    sequence: 2,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: id === "review" ? 1 : 0,
      approvedFindings: 0,
      findings: id === "review"
        ? [{ description: "Original reviewer finding.", disposition: "open" as const, id: "orig-1", severity: "error" as const }]
        : [],
      fixedFindings: 0,
      id,
      openFindings: id === "review" ? 1 : 0,
      round: 1,
      status: id === "review" ? ("blocked" as const) : ("pending" as const),
      totalFindings: id === "review" ? 1 : 0,
    })),
    status: "in-progress",
    transition: { gateId: "gate-guardrail", gateKind: "guardrail", kind: "gate-opened", options, question, round: 1, stage: "review" },
    updatedAt: "2026-09-09T10:00:00.000Z",
    version: 1,
  };
}

test("guardrail recovery gate uses candidate-level options, not the findings editor", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const resolutions: string[] = [];
  const renderer = new RailTuiRenderer(input, output, "/unused", new Map(), async (_id, resolution) => {
    resolutions.push(resolution);
  });
  renderer.render(guardrailGateSnapshot(false));
  await nextDraw();
  input.emit("data", "g");
  await nextDraw();
  const screen = cleanScreen(output.writes.at(-1) ?? "");
  assert.match(screen, /Fixer candidate abc123/u);
  assert.match(screen, /Apply this exact candidate/u);
  assert.doesNotMatch(screen, /Choose F or A for each finding/u);

  input.emit("data", "[B");
  await nextDraw();
  input.emit("data", "\r");
  await nextDraw();
  input.emit("data", "\r");
  await nextDraw();
  assert.deepEqual(resolutions, ["fix"]);
  renderer.close();
});

test("auto-fix never resolves a guardrail recovery gate", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const resolutions: string[] = [];
  const renderer = new RailTuiRenderer(
    input, output, "/unused", new Map(),
    async (_id, resolution) => { resolutions.push(resolution); },
    undefined, undefined, undefined, undefined, true,
  );
  renderer.render(guardrailGateSnapshot(true));
  await nextDraw();
  assert.deepEqual(resolutions, []);
  renderer.close();
});
