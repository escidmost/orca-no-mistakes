import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PIPELINE_STEPS } from "../scripts/config.ts";
import type { PresentationSnapshot } from "../scripts/presentation.ts";
import {
  findUnclosedFence,
  pullRequestContent,
  type PullRequestReport,
} from "../scripts/pull-request.ts";
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

test("risk rationale fences are balanced after the inline risk label is added", () => {
  const report: PullRequestReport = {
    candidateCommitOid: "a".repeat(40),
    pipelineSteps: [{ name: "test", status: "passed" }],
    risk: { level: "low", rationale: "~~~text\nprose\n~~~" },
    testing: { artifacts: [], summary: "Tests completed.", tested: ["npm test"] },
    whatChanged: "Changed things.",
  };
  const { body } = pullRequestContent("Intent", report);
  assert.equal(findUnclosedFence(body), null);
  const testingIndex = body.indexOf("## Testing");
  assert.ok(testingIndex > 0);
  assert.equal(findUnclosedFence(body.slice(0, testingIndex)), null);
  assert.match(body, /## Risk Assessment\n\n✅ Low: ~~~text/u);
});

test("wide layout shows complete retry result counts at 140 columns", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const renderer = new RailTuiRenderer(input, output, "/unused");
  const findings = (aFixed: boolean) => [
    {
      description: "A",
      disposition: aFixed ? ("fixed" as const) : ("open" as const),
      id: "a",
      severity: "error" as const,
    },
    { description: "B", disposition: "open" as const, id: "b", severity: "error" as const },
    { description: "C", disposition: "approved" as const, id: "c", severity: "warning" as const },
  ];
  const base: PresentationSnapshot = {
    attempt: 1,
    currentStage: "review",
    mode: { autoFix: true },
    runId: "retry-width-run",
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
  const review = (aFixed: boolean, extra: Record<string, unknown>) =>
    base.stages.map((s) =>
      s.id === "review"
        ? {
            ...s,
            analysis: 1,
            approvedFindings: 1,
            findings: findings(aFixed),
            fixAttempt: 1,
            openFindings: aFixed ? 1 : 2,
            totalFindings: 3,
            ...extra,
          }
        : s,
    );
  try {
    renderer.render({
      ...base,
      stages: review(false, {}),
      transition: {
        approvedFindings: 1,
        findingIds: ["a", "b"],
        fixAttempt: 1,
        kind: "fix-completed",
        round: 1,
        stage: "review",
      },
    });
    renderer.render({
      ...base,
      sequence: 2,
      stages: review(true, { analysis: 2, fixedFindings: 1 }),
      transition: {
        actionable: 1,
        analysis: 2,
        kind: "findings-recorded",
        round: 1,
        stage: "review",
        total: 3,
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, /Review fix 1 retry 1 · 1 fixed · 1 still open · 1 approved/u);
  } finally {
    renderer.close();
  }
});
