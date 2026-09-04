import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PIPELINE_STEPS } from "../scripts/config.ts";
import { DomainLedger } from "../scripts/ledger.ts";
import { PresentationPublisher, type PresentationSnapshot } from "../scripts/presentation.ts";
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

test("fix-completed leaves selected findings open until findings-recorded verifies disappearance", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    const runId = "provisional-findings-lifecycle";
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Verify provisional findings lifecycle.",
      policySha256: "0".repeat(64),
      repoRoot: "/repo",
      runId,
      submissionCommitOid: "1".repeat(40),
    });
    const publisher = new PresentationPublisher(ledger, runId);
    publisher.publish("findings:0", {
      actionable: 2,
      findings: [
        { description: "Duplicate issue A", id: "dup-finding", severity: "error" },
        { description: "Duplicate issue B", id: "dup-finding", severity: "error" },
      ],
      kind: "findings-recorded",
      round: 0,
      stage: "review",
      total: 2,
    });

    const initialReview = publisher.current.stages.find((s) => s.id === "review");
    assert.equal(initialReview?.openFindings, 2);
    assert.equal(initialReview?.fixedFindings, 0);

    publisher.publish("gate:0", {
      decision: "fix",
      gateId: "gate-0",
      kind: "gate-resolved",
      round: 0,
      stage: "review",
      targetFindingIds: ["dup-finding", "dup-finding"],
    });

    publisher.publish("fix:completed:1", {
      approvedFindings: 0,
      findingIds: ["dup-finding", "dup-finding"],
      kind: "fix-completed",
      round: 1,
      stage: "review",
    });

    const postFixReview = publisher.current.stages.find((s) => s.id === "review");
    assert.equal(postFixReview?.fixedFindings, 0, "fix-completed must not mark findings fixed prematurely");
    assert.equal(postFixReview?.openFindings, 2, "selected findings remain open at fix-completed");
    assert.equal(postFixReview?.actionableFindings, 2);
    assert.deepEqual(
      postFixReview?.findings?.map((f) => f.disposition),
      ["open", "open"],
    );

    publisher.publish("findings:1", {
      actionable: 1,
      findings: [
        { description: "Duplicate issue B", id: "dup-finding", severity: "error" },
      ],
      kind: "findings-recorded",
      round: 1,
      stage: "review",
      total: 2,
    });

    const verifiedReview = publisher.current.stages.find((s) => s.id === "review");
    assert.equal(verifiedReview?.fixedFindings, 1, "disappeared occurrence moves to fixed");
    assert.equal(verifiedReview?.openFindings, 1, "re-reported occurrence remains open");
    assert.deepEqual(
      verifiedReview?.findings?.map((f) => f.disposition).sort(),
      ["fixed", "open"],
    );
  } finally {
    ledger.close();
  }
});

test("RailTuiRenderer shows provisional applied counts and reconciles to verified counts without duplicate labels", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const renderer = new RailTuiRenderer(input, output, "/unused");

  const base: PresentationSnapshot = {
    attempt: 1,
    currentStage: "review",
    mode: { autoFix: true },
    runId: "tui-reconciliation-run",
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

  try {
    renderer.render({
      ...base,
      stages: base.stages.map((s) =>
        s.id === "review"
          ? {
              ...s,
              findings: [
                { description: "Issue 1", disposition: "open" as const, id: "item-1", severity: "error" as const },
                { description: "Issue 2", disposition: "open" as const, id: "item-2", severity: "error" as const },
              ],
              openFindings: 2,
              totalFindings: 2,
            }
          : s,
      ),
      transition: { actionable: 2, kind: "findings-recorded", round: 0, stage: "review", total: 2 },
    });

    renderer.render({
      ...base,
      stages: base.stages.map((s) =>
        s.id === "review"
          ? {
              ...s,
              findings: [
                { description: "Issue 1", disposition: "open" as const, id: "item-1", severity: "error" as const },
                { description: "Issue 2", disposition: "open" as const, id: "item-2", severity: "error" as const },
              ],
              openFindings: 2,
              totalFindings: 2,
            }
          : s,
      ),
      transition: {
        approvedFindings: 0,
        findingIds: ["item-1", "item-2"],
        kind: "fix-completed",
        round: 1,
        stage: "review",
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    let screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, /Review fix 1\s+·  2 fixes applied/u);
    assert.doesNotMatch(screen, /Review fix 1.*applied.*fixed/u);

    renderer.render({
      ...base,
      stages: base.stages.map((s) =>
        s.id === "review"
          ? {
              ...s,
              findings: [
                { description: "Issue 1", disposition: "fixed" as const, id: "item-1", severity: "error" as const },
                { description: "Issue 2", disposition: "open" as const, id: "item-2", severity: "error" as const },
              ],
              fixedFindings: 1,
              openFindings: 1,
              totalFindings: 2,
            }
          : s,
      ),
      transition: { actionable: 1, kind: "findings-recorded", round: 1, stage: "review", total: 2 },
    });

    await new Promise((resolve) => setImmediate(resolve));
    screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, /Review fix 1\s+·  1 fixed ·  1 still open/u);
    assert.doesNotMatch(screen, /Review fix 1.*applied.*fixed/u);
  } finally {
    renderer.close();
  }
});
