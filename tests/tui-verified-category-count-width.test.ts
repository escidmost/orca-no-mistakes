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

function baseSnapshot(): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: "review",
    mode: { autoFix: true },
    runId: "tui-verified-truncation-run",
    sequence: 1,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      id,
      round: 0,
      status: id === "review" ? "active" : "pending",
      totalFindings: 0,
    })),
    status: "in-progress",
    transition: { kind: "run-started" },
    updatedAt: new Date(0).toISOString(),
    version: 1,
  };
}

for (const columns of [140, 200]) {
  test(`RailTuiRenderer does not truncate approved count when all verified categories are present at ${columns} columns`, async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = columns;
    const renderer = new RailTuiRenderer(input, output, "/unused");
    const base = baseSnapshot();

    try {
      renderer.render({
        ...base,
        stages: base.stages.map((s) =>
          s.id === "review"
            ? {
                ...s,
                approvedFindings: 1,
                findings: [
                  { description: "Approved item", disposition: "approved" as const, id: "item-approved", severity: "error" as const },
                  { description: "Open item 1", disposition: "open" as const, id: "item-fixed", severity: "error" as const },
                  { description: "Open item 2", disposition: "open" as const, id: "item-open", severity: "error" as const },
                ],
                openFindings: 2,
                totalFindings: 3,
              }
            : s,
        ),
        transition: { actionable: 2, kind: "findings-recorded", round: 0, stage: "review", total: 3 },
      });

      renderer.render({
        ...base,
        stages: base.stages.map((s) =>
          s.id === "review"
            ? {
                ...s,
                approvedFindings: 1,
                findings: [
                  { description: "Approved item", disposition: "approved" as const, id: "item-approved", severity: "error" as const },
                  { description: "Open item 1", disposition: "open" as const, id: "item-fixed", severity: "error" as const },
                  { description: "Open item 2", disposition: "open" as const, id: "item-open", severity: "error" as const },
                ],
                openFindings: 2,
                totalFindings: 3,
              }
            : s,
        ),
        transition: {
          approvedFindings: 1,
          findingIds: ["item-fixed", "item-open"],
          kind: "fix-completed",
          round: 1,
          stage: "review",
        },
      });

      renderer.render({
        ...base,
        stages: base.stages.map((s) =>
          s.id === "review"
            ? {
                ...s,
                approvedFindings: 1,
                findings: [
                  { description: "Approved item", disposition: "approved" as const, id: "item-approved", severity: "error" as const },
                  { description: "Open item 1", disposition: "fixed" as const, id: "item-fixed", severity: "error" as const },
                  { description: "Open item 2", disposition: "open" as const, id: "item-open", severity: "error" as const },
                ],
                fixedFindings: 1,
                openFindings: 1,
                totalFindings: 3,
              }
            : s,
        ),
        transition: { actionable: 1, kind: "findings-recorded", round: 1, stage: "review", total: 3 },
      });

      await new Promise((resolve) => setImmediate(resolve));
      const screen = cleanScreen(output.writes.at(-1) ?? "");
      assert.match(screen, /Review fix 1\s+· 1 fixed · 1 still open · 1 approved/u);
      assert.doesNotMatch(screen, /1 appro~/u);
    } finally {
      renderer.close();
    }
  });
}
