import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  PresentationPublisher,
  type PresentationSnapshot,
} from "../scripts/presentation.ts";
import { createRunRenderer } from "../scripts/tui.ts";

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
  columns = 140;
  isTTY = true;
  rows = 40;
  readonly writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

function cleanScreen(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[a-zA-Z]/gu, "");
}

function nextDraw(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("PresentationPublisher seeds createRunRenderer production wrapper and restores persisted ACTIVITY rows on resume", async () => {
  const snapshots: PresentationSnapshot[] = [];
  const store = {
    listPresentationSnapshots: () => [...snapshots],
    recordPresentationSnapshot: (
      _runId: string,
      _key: string,
      value: PresentationSnapshot,
    ) => {
      snapshots.push(value);
      return true;
    },
  };

  const initialInput = new FakeInput();
  const initialOutput = new FakeOutput();
  const initialRenderer = createRunRenderer(initialInput, initialOutput, "/unused");
  const publisher = new PresentationPublisher(
    store,
    "test-resume-activities-wrapper",
    initialRenderer,
  );

  publisher.publish("stage", { kind: "stage-started", stage: "review" });
  publisher.publish("analysis-1", {
    analysis: 1,
    kind: "round-started",
    role: "reviewer",
    round: 0,
    stage: "review",
  });
  publisher.publish("findings-1", {
    actionable: 2,
    analysis: 1,
    findings: [{ description: "f1", id: "f1", severity: "error" }],
    kind: "findings-recorded",
    round: 0,
    stage: "review",
    total: 2,
  });
  publisher.publish("fix-1", {
    kind: "round-started",
    role: "fixer",
    round: 1,
    stage: "review",
    targetFindingIds: ["f1"],
  });
  publisher.publish("fix-1-blocked", {
    actionable: 1,
    findings: [
      { description: "no change", id: "fixer-no-change", severity: "error" },
    ],
    kind: "fix-blocked",
    round: 1,
    stage: "review",
    total: 1,
  });

  initialRenderer.close?.();

  const freshInput = new FakeInput();
  const freshOutput = new FakeOutput();
  freshOutput.columns = 140;
  freshOutput.rows = 30;
  const resumedRenderer = createRunRenderer(freshInput, freshOutput, "/unused");
  assert.ok(
    typeof resumedRenderer.seed === "function",
    "createRunRenderer production wrapper must expose seed method",
  );

  const resumedPublisher = new PresentationPublisher(
    store,
    "test-resume-activities-wrapper",
    resumedRenderer,
  );

  resumedPublisher.publish("attempt-2", {
    attempt: 2,
    kind: "attempt-started",
  });

  await nextDraw();
  const screen = cleanScreen(freshOutput.writes.at(-1) ?? "");
  assert.match(screen, /Review fix 1\s+· blocked/u);
  assert.match(screen, /Review analysis 1/u);
  resumedRenderer.close?.();
});

test("createRunRenderer plain fallback does not expose seed hook or re-emit historical status lines", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  input.isTTY = false;
  const renderer = createRunRenderer(input, output, "/unused");
  assert.equal(renderer.seed, undefined);
  assert.equal(output.writes.length, 0);
});

test("createRunRenderer wrapper seed error switches to plain without re-emitting historical plain lines", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const failures: unknown[] = [];
  const renderer = createRunRenderer(
    input,
    output,
    "/unused",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (err) => failures.push(err),
  );
  assert.ok(typeof renderer.seed === "function");
  const invalidSnapshots = [null as unknown as PresentationSnapshot];
  renderer.seed(invalidSnapshots);
  assert.equal(failures.length, 1);
  assert.ok(
    !output.writes.some(
      (w) => w.includes("stage 1/8") || w.includes("stage 3/8"),
    ),
  );
  renderer.close?.();
});
