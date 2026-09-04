import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

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

test("analysis-less findings-recorded during fixer phase does not create duplicate analysis or break blocked row", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 140;
  output.rows = 24;
  const renderer = new RailTuiRenderer(input, output, "/unused");
  const snapshots: PresentationSnapshot[] = [];
  const publisher = new PresentationPublisher(
    {
      listPresentationSnapshots: () => snapshots,
      recordPresentationSnapshot: (_runId, _key, value) =>
        (snapshots.push(value), true),
    },
    "blocked-fixer-evidence-test",
    renderer,
  );

  const findings = ["a", "b"].map((id) => ({
    description: id,
    id,
    severity: "error" as const,
  }));
  const policy = {
    description: "fixer changed protected tests",
    id: "fixer-policy-violation",
    severity: "error" as const,
  };

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
    findings,
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
    targetFindingIds: ["a", "b"],
  });
  publisher.publish("fix-1-completed", {
    approvedFindings: 0,
    findingIds: ["a"],
    kind: "fix-completed",
    round: 1,
    stage: "review",
  });
  publisher.publish("analysis-2", {
    analysis: 2,
    kind: "round-started",
    role: "reviewer",
    round: 1,
    stage: "review",
  });
  publisher.publish("findings-2", {
    actionable: 1,
    analysis: 2,
    findings: [findings[1]],
    kind: "findings-recorded",
    round: 1,
    stage: "review",
    total: 1,
  });
  publisher.publish("fix-2", {
    kind: "round-started",
    role: "fixer",
    round: 2,
    stage: "review",
    targetFindingIds: ["b"],
  });
  publisher.publish("fix-2-evidence", {
    actionable: 2,
    findings: [findings[1], policy],
    kind: "findings-recorded",
    round: 2,
    stage: "review",
    total: 2,
  });
  publisher.publish("fix-2-blocked", {
    actionable: 2,
    findings: [findings[1], policy],
    kind: "fix-blocked",
    round: 2,
    stage: "review",
    total: 2,
  });

  await nextDraw();
  const screen = cleanScreen(output.writes.at(-1) ?? "");
  assert.match(screen, /Review fix 2\s+· blocked/u);
  assert.doesNotMatch(screen, /Review analysis 3/u);
  renderer.close();
});

test("repeated fixer policy violation does not inherit approval from prior blocked round", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 140;
  output.rows = 24;
  const renderer = new RailTuiRenderer(input, output, "/unused");
  const snapshots: PresentationSnapshot[] = [];
  const publisher = new PresentationPublisher(
    {
      listPresentationSnapshots: () => snapshots,
      recordPresentationSnapshot: (_runId, _key, value) =>
        (snapshots.push(value), true),
    },
    "repeated-policy-violation-test",
    renderer,
  );

  const findings = ["a", "b"].map((id) => ({
    description: id,
    id,
    severity: "error" as const,
  }));
  const policy = {
    description: "fixer changed protected tests",
    id: "fixer-policy-violation",
    severity: "error" as const,
  };

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
    findings,
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
    targetFindingIds: ["a", "b"],
  });
  publisher.publish("fix-1-blocked", {
    actionable: 3,
    findings: [...findings, policy],
    kind: "fix-blocked",
    round: 1,
    stage: "review",
    total: 3,
  });

  publisher.publish("gate-2", {
    decision: "fix",
    gateId: "g2",
    kind: "gate-resolved",
    round: 1,
    stage: "review",
    targetFindingIds: ["a", "b"],
  });

  const afterGate = snapshots.at(-1)?.stages.find((s) => s.id === "review");
  assert.equal(afterGate?.openFindings, 2);
  assert.equal(afterGate?.approvedFindings, 1);

  publisher.publish("fix-2", {
    kind: "round-started",
    role: "fixer",
    round: 2,
    stage: "review",
    targetFindingIds: ["a", "b"],
  });

  const policy2 = {
    description: "fixer modified another protected file",
    id: "fixer-policy-violation",
    severity: "error" as const,
  };
  publisher.publish("fix-2-blocked", {
    actionable: 3,
    findings: [...findings, policy2],
    kind: "fix-blocked",
    round: 2,
    stage: "review",
    total: 3,
  });

  const afterBlocked = snapshots.at(-1)?.stages.find((s) => s.id === "review");
  assert.equal(afterBlocked?.openFindings, 3);
  assert.equal(afterBlocked?.approvedFindings, 1);
  assert.equal(afterBlocked?.actionableFindings, 3);
  assert.equal(afterBlocked?.totalFindings, 4);

  renderer.close();
});
