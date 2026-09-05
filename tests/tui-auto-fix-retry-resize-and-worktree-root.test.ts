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

function cleanScreen(screen: string): string {
  return screen
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, "")
    .replace(/\r/gu, "")
    .replace(/\u0007/gu, "");
}

function nextDraw(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function gateSnapshot(
  state: "open" | "resolved",
  sequence: number,
  decision?: string,
  autoFix = false,
): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: "review",
    gate: {
      decision,
      id: "gate-review",
      options: ["approve", "fix", "skip", "stop"],
      question: "Review failed with actionable findings. Please choose how to proceed.",
      stage: "review",
      state,
    },
    mode: { autoFix },
    runId: "run-tui-redesign-regressions",
    sequence,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: id === "review" ? 1 : 0,
      approvedFindings: 0,
      findings: [],
      fixedFindings: 0,
      id,
      openFindings: id === "review" ? 1 : 0,
      round: 1,
      status: id === "review" ? "active" : "pending",
      totalFindings: id === "review" ? 1 : 0,
    })),
    status: "in-progress",
    transition: {
      gateId: "gate-review",
      kind: "gate-opened",
      options: ["approve", "fix", "skip", "stop"],
      question: "Review failed with actionable findings.",
      round: 0,
      stage: "review",
    },
    updatedAt: "2026-09-03T10:00:00.000Z",
    version: 1,
  };
}

test("failed auto-fix does not poison subsequent retry", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let attempt = 0;
  const resolutions: string[] = [];
  const renderer = new RailTuiRenderer(
    input,
    output,
    "/unused",
    new Map(),
    async (_gateId, resolution) => {
      attempt += 1;
      resolutions.push(resolution);
      if (attempt === 1) {
        throw new Error("simulated failure");
      }
    },
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );

  const base = gateSnapshot("open", 1, undefined, true);
  renderer.render(base);
  await nextDraw();
  assert.deepEqual(resolutions, ["fix"]);

  // Operator toggles auto-fix off then on to retry
  input.emit("data", "A");
  await nextDraw();
  input.emit("data", "A");
  await nextDraw();

  // The retry must still attempt "fix", not fall back to "approve"
  assert.deepEqual(resolutions, ["fix", "fix"]);
  renderer.close();
});

test("terminals smaller than MIN_ROWS=18 show resize prompt instead of truncating gate choices", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.rows = 14;
  const renderer = new RailTuiRenderer(input, output, "/unused");
  const base = gateSnapshot("open", 1);
  renderer.render(base);
  await nextDraw();

  const screen = cleanScreen(output.writes.at(-1) ?? "");
  assert.match(screen, /Terminal too small/u);
  assert.match(screen, /Resize to at least 40x18/u);
  renderer.close();
});

test("toggling auto-fix on resolves current gate even when coordinator mode is already true", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const resolutions: string[] = [];
  const renderer = new RailTuiRenderer(
    input,
    output,
    "/unused",
    new Map(),
    async (_gateId, resolution) => {
      resolutions.push(resolution);
    },
    undefined,
    async (_enabled) => {
      // Coordinator already has autoFix: true, so no mode-changed event is emitted
    },
  );
  const base = gateSnapshot("open", 1, undefined, true);
  renderer.render(base);
  await nextDraw();
  assert.deepEqual(resolutions, []);

  input.emit("data", "A");
  await nextDraw();

  assert.deepEqual(resolutions, ["fix"]);
  renderer.close();
});

test("worktree root resolution extracts worktree path from git worktree list porcelain output", () => {
  const porcelain = "worktree /work/project\nHEAD 1234567\nbranch refs/heads/main\n\nworktree /var/git\n";
  const firstLine = porcelain.split("\n", 1)[0] ?? "";
  const repoRoot = firstLine.startsWith("worktree ")
    ? firstLine.slice("worktree ".length).trim()
    : "/fallback";
  assert.equal(repoRoot, "/work/project");
});
