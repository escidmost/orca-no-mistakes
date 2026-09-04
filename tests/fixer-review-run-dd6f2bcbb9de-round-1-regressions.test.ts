import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PIPELINE_STEPS, type StageName } from "../scripts/config.ts";
import {
  PresentationPublisher,
  type PresentationSnapshot,
} from "../scripts/presentation.ts";
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

function cleanScreen(output: string): string {
  const screen = output.split("\u001b[H\u001b[2J").at(-1) ?? output;
  return screen
    .replaceAll(new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "gu"), "")
    .replaceAll("\r", "");
}

async function nextDraw(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function baseSnapshot(stage: StageName = "review"): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: stage,
    mode: { autoFix: true },
    runId: "run_dd6f2bcbb9de",
    sequence: 1,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      id,
      round: 0,
      status: id === stage ? "active" : "pending",
      totalFindings: 0,
    })),
    status: "in-progress",
    transition: { kind: "stage-started", stage },
    updatedAt: new Date(0).toISOString(),
    version: 1,
  };
}

test("TUI treats explicit stage.phase as authoritative over historical autoFixedStages", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let resolvedGateDecision: string | undefined;

  const renderer = new RailTuiRenderer(
    input,
    output,
    "/unused",
    undefined,
    async (_gateId, decision) => {
      resolvedGateDecision = decision;
    },
  );

  const base = baseSnapshot("review");

  // Enable autoFix in TUI via mode-changed transition
  renderer.render({
    ...base,
    mode: { autoFix: true },
    transition: { enabled: true, kind: "mode-changed", source: "operator" },
  });

  // Round 0 reviewer starts
  renderer.render({
    ...base,
    stages: base.stages.map((s) =>
      s.id === "review"
        ? { ...s, phase: "reviewer" as const, round: 0, status: "active" as const }
        : s,
    ),
    transition: { kind: "round-started", role: "reviewer", round: 0, stage: "review" },
  });

  // Findings recorded and gate opens
  const finding1 = {
    action: "auto-fix" as const,
    description: "Sample finding",
    disposition: "open" as const,
    file: "scripts/tui.ts",
    id: "sample-finding-1",
    line: 10,
    severity: "warning" as const,
  };

  const gateSnapshot: PresentationSnapshot = {
    ...base,
    gate: {
      id: "gate-r0",
      options: ["approve", "fix", "skip", "stop"],
      question: "Findings needing resolution",
      round: 0,
      stage: "review",
      state: "open",
    },
    stages: base.stages.map((s) =>
      s.id === "review"
        ? {
            ...s,
            actionableFindings: 1,
            findings: [finding1],
            openFindings: 1,
            phase: "reviewer" as const,
            round: 0,
            status: "blocked" as const,
            totalFindings: 1,
          }
        : s,
    ),
    transition: {
      gateId: "gate-r0",
      kind: "gate-opened",
      options: ["approve", "fix", "skip", "stop"],
      question: "Findings needing resolution",
      round: 0,
      stage: "review",
    },
  };
  renderer.render(gateSnapshot);
  await nextDraw();
  assert.equal(resolvedGateDecision, "fix");

  // Fixer starts (role: "fixer", round: 1)
  const fixerSnapshot: PresentationSnapshot = {
    ...base,
    stages: base.stages.map((s) =>
      s.id === "review"
        ? {
            ...s,
            actionableFindings: 1,
            findings: [finding1],
            openFindings: 1,
            phase: "fixer" as const,
            round: 1,
            status: "active" as const,
            targetFindingIds: ["sample-finding-1"],
            totalFindings: 1,
          }
        : s,
    ),
    transition: {
      kind: "round-started",
      role: "fixer",
      round: 1,
      stage: "review",
      targetFindingIds: ["sample-finding-1"],
    },
  };
  renderer.render(fixerSnapshot);
  await nextDraw();

  let screen = cleanScreen(output.writes.at(-1) ?? "");
  assert.match(screen, /REVIEW.*fix 1/);

  // Now re-review starts (role: "reviewer", round: 1)
  const finding2 = {
    action: "auto-fix" as const,
    description: "Another finding in round 2",
    disposition: "open" as const,
    file: "scripts/tui.ts",
    id: "sample-finding-2",
    line: 20,
    severity: "error" as const,
  };

  const reReviewSnapshot: PresentationSnapshot = {
    ...base,
    stages: base.stages.map((s) =>
      s.id === "review"
        ? {
            ...s,
            actionableFindings: 1,
            findings: [finding2],
            openFindings: 1,
            phase: "reviewer" as const,
            round: 1,
            status: "active" as const,
            totalFindings: 1,
          }
        : s,
    ),
    transition: {
      kind: "round-started",
      role: "reviewer",
      round: 1,
      stage: "review",
    },
  };
  renderer.render(reReviewSnapshot);
  await nextDraw();

  screen = cleanScreen(output.writes.at(-1) ?? "");
  // Must authoritative say "round 2", NOT "fix 1"
  assert.match(screen, /REVIEW.*round 2/);
  assert.doesNotMatch(screen, /REVIEW.*fix 1/);
  // Finding must NOT have the fixing glyph 'F'
  assert.doesNotMatch(screen, /F\s+sample-finding-2/);

  renderer.close();
});

test("attempt-started clears phase and targetFindingIds for non-passed stages", () => {
  class MemoryStore {
    snapshots: PresentationSnapshot[] = [];
    listPresentationSnapshots(): PresentationSnapshot[] {
      return this.snapshots;
    }
    recordPresentationSnapshot(_runId: string, _key: string, snapshot: PresentationSnapshot): boolean {
      this.snapshots.push(snapshot);
      return true;
    }
  }

  const store = new MemoryStore();
  const publisher = new PresentationPublisher(
    store,
    "run_dd6f2bcbb9de",
    { render: () => {} },
    () => new Date(0),
  );

  // Step 1: Run starts, rebase passes
  publisher.publish("run-start", { kind: "run-started" });
  publisher.publish("rebase-start", { kind: "stage-started", stage: "rebase" });
  publisher.publish("rebase-complete", { kind: "stage-completed", round: 0, stage: "rebase" });

  // Step 2: Review stage starts fixer with targetFindingIds
  publisher.publish("review-start", { kind: "stage-started", stage: "review" });
  publisher.publish("round-fixer", {
    kind: "round-started",
    role: "fixer",
    round: 1,
    stage: "review",
    targetFindingIds: ["finding-abc"],
  });

  let current = publisher.current;
  let reviewStage = current.stages.find((s) => s.id === "review");
  assert.equal(reviewStage?.phase, "fixer");
  assert.deepEqual(reviewStage?.targetFindingIds, ["finding-abc"]);

  // Step 3: Error recorded (failed stage)
  publisher.publish("error", {
    kind: "error-recorded",
    resumable: true,
  });

  current = publisher.current;
  reviewStage = current.stages.find((s) => s.id === "review");
  assert.equal(reviewStage?.status, "failed");
  assert.equal(reviewStage?.phase, "fixer");

  // Step 4: Attempt-started resets non-passed stages
  publisher.publish("attempt-2", {
    attempt: 2,
    kind: "attempt-started",
  });

  current = publisher.current;
  reviewStage = current.stages.find((s) => s.id === "review");
  assert.equal(reviewStage?.status, "pending");
  assert.equal(reviewStage?.round, 0);
  assert.equal(reviewStage?.phase, undefined);
  assert.equal(reviewStage?.targetFindingIds, undefined);

  // Passed stage preserves passed status
  const rebaseStage = current.stages.find((s) => s.id === "rebase");
  assert.equal(rebaseStage?.status, "passed");
});
