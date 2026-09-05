import assert from "node:assert/strict";
import test from "node:test";

import {
  PresentationPublisher,
  type PresentationSnapshot,
} from "../scripts/presentation.ts";
import {
  pullRequestPipelineRounds,
  recoverFixRecords,
} from "../scripts/orca-no-mistakes.ts";
import { pullRequestContent } from "../scripts/pull-request.ts";

test("no-change fixer followed by protected-path failure retires superseded blocker while preserving original findings, gate counts, and restored snapshots", async () => {
  const snapshots: PresentationSnapshot[] = [];
  const store = {
    listPresentationSnapshots: () => snapshots,
    recordPresentationSnapshot: (_runId: string, _key: string, value: PresentationSnapshot) => {
      snapshots.push(value);
      return true;
    },
  };

  const publisher = new PresentationPublisher(store, "test-blocker-reconciliation");

  const originalFinding = {
    action: "auto-fix" as const,
    description: "real defect",
    file: "src/main.ts",
    id: "f1",
    line: 42,
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
    actionable: 1,
    analysis: 1,
    findings: [originalFinding],
    kind: "findings-recorded",
    round: 0,
    stage: "review",
    total: 1,
  });

  publisher.publish("fix-1", {
    kind: "round-started",
    role: "fixer",
    round: 1,
    stage: "review",
    targetFindingIds: ["f1"],
  });

  const noChangeBlocker = {
    action: "ask-user" as const,
    description: "review fixer did not commit a change. Fixer summary: none. Select approve or skip if the original findings are not valid, or select them to retry.",
    id: "fixer-no-change",
    severity: "error" as const,
  };

  publisher.publish("fix-1-blocked", {
    actionable: 2,
    findings: [originalFinding, noChangeBlocker],
    kind: "fix-blocked",
    round: 1,
    stage: "review",
    total: 2,
  });

  const afterNoChange = publisher.current.stages.find((s) => s.id === "review");
  assert.equal(afterNoChange?.openFindings, 2);
  assert.equal(afterNoChange?.actionableFindings, 2);
  assert.equal(afterNoChange?.totalFindings, 2);
  assert.equal(afterNoChange?.fixedFindings, 0);
  assert.equal(afterNoChange?.approvedFindings, 0);

  publisher.publish("gate-1-resolved", {
    decision: "fix",
    gateId: "g1",
    kind: "gate-resolved",
    round: 1,
    stage: "review",
  });

  publisher.publish("fix-2", {
    kind: "round-started",
    role: "fixer",
    round: 2,
    stage: "review",
  });

  const policyBlocker = {
    action: "ask-user" as const,
    description: "Fixer commit rejected by protected-path policy: modified protected test. Select the original findings to retry them without protected-path changes.",
    id: "fixer-policy-violation",
    severity: "error" as const,
  };

  publisher.publish("fix-2-blocked", {
    actionable: 2,
    findings: [originalFinding, policyBlocker],
    kind: "fix-blocked",
    round: 2,
    stage: "review",
    total: 2,
  });

  const afterPolicy = publisher.current.stages.find((s) => s.id === "review");
  assert.equal(afterPolicy?.openFindings, 2);
  assert.equal(afterPolicy?.actionableFindings, 2);
  assert.equal(afterPolicy?.totalFindings, 2);
  assert.equal(afterPolicy?.fixedFindings, 0);
  assert.equal(afterPolicy?.approvedFindings, 0);

  const findingIds = afterPolicy?.findings?.map((f) => f.id);
  assert.deepEqual(findingIds, ["f1", "fixer-policy-violation"]);

  const restoredPublisher = new PresentationPublisher(store, "test-blocker-reconciliation");
  const restoredStage = restoredPublisher.current.stages.find((s) => s.id === "review");
  assert.equal(restoredStage?.openFindings, 2);
  assert.equal(restoredStage?.actionableFindings, 2);
  assert.equal(restoredStage?.totalFindings, 2);
  assert.deepEqual(
    restoredStage?.findings?.map((f) => f.id),
    ["f1", "fixer-policy-violation"],
  );

  publisher.publish("gate-2-resolved", {
    decision: "fix",
    gateId: "g2",
    kind: "gate-resolved",
    round: 2,
    stage: "review",
    targetFindingIds: ["f1"],
  });

  const afterTargetedGate = publisher.current.stages.find((s) => s.id === "review");
  assert.equal(afterTargetedGate?.openFindings, 1);
  assert.equal(afterTargetedGate?.approvedFindings, 1);

  publisher.publish("fix-3", {
    kind: "round-started",
    role: "fixer",
    round: 3,
    stage: "review",
    targetFindingIds: ["f1"],
  });
  publisher.publish("fix-3-done", {
    approvedFindings: 1,
    findingIds: ["f1"],
    kind: "fix-completed",
    round: 3,
    stage: "review",
    summary: "fixed f1",
  });
  publisher.publish("analysis-2", {
    analysis: 2,
    kind: "round-started",
    role: "reviewer",
    round: 3,
    stage: "review",
  });
  publisher.publish("findings-clean", {
    actionable: 0,
    analysis: 2,
    findings: [],
    kind: "findings-recorded",
    round: 3,
    stage: "review",
    total: 0,
  });

  const finalStage = publisher.current.stages.find((s) => s.id === "review");
  assert.equal(finalStage?.openFindings, 0);
  assert.equal(finalStage?.fixedFindings, 1);
  assert.equal(finalStage?.approvedFindings, 1);
});

test("user findings sharing synthetic blocker ID are not retired", async () => {
  const snapshots: PresentationSnapshot[] = [];
  const store = {
    listPresentationSnapshots: () => snapshots,
    recordPresentationSnapshot: (_runId: string, _key: string, value: PresentationSnapshot) => {
      snapshots.push(value);
      return true;
    },
  };

  const publisher = new PresentationPublisher(store, "test-user-finding-preservation");

  const userBlockerFinding = {
    action: "auto-fix" as const,
    description: "user issue in code",
    file: "src/worker.ts",
    id: "fixer-no-change",
    line: 15,
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
    actionable: 1,
    analysis: 1,
    findings: [userBlockerFinding],
    kind: "findings-recorded",
    round: 0,
    stage: "review",
    total: 1,
  });

  const noChangeBlocker = {
    action: "ask-user" as const,
    description: "review fixer did not commit a change. Fixer summary: none. Select approve or skip if the original findings are not valid, or select them to retry.",
    id: "fixer-no-change",
    severity: "error" as const,
  };
  publisher.publish("fix-1", {
    kind: "round-started",
    role: "fixer",
    round: 1,
    stage: "review",
    targetFindingIds: [userBlockerFinding.id],
  });
  publisher.publish("fix-1-blocked", {
    actionable: 2,
    findings: [userBlockerFinding, noChangeBlocker],
    kind: "fix-blocked",
    round: 1,
    stage: "review",
    total: 2,
  });
  const afterNoChange = publisher.current.stages.find((s) => s.id === "review");
  assert.deepEqual(afterNoChange?.findings, [
    { ...userBlockerFinding, disposition: "open" },
    { ...noChangeBlocker, disposition: "open" },
  ]);
  assert.equal(afterNoChange?.openFindings, 2);
  assert.equal(afterNoChange?.totalFindings, 2);

  publisher.publish("gate-1-resolved", {
    decision: "fix",
    gateId: "g1",
    kind: "gate-resolved",
    round: 1,
    stage: "review",
  });
  publisher.publish("fix-2", {
    kind: "round-started",
    role: "fixer",
    round: 2,
    stage: "review",
  });

  const policyBlocker = {
    action: "ask-user" as const,
    description: "Fixer commit rejected by protected-path policy: changed guarded file. Select the original findings to retry them without protected-path changes.",
    id: "fixer-policy-violation",
    severity: "error" as const,
  };

  publisher.publish("fix-2-blocked", {
    actionable: 2,
    // Omit the reviewer finding so re-adding it cannot hide ID-only retirement.
    findings: [policyBlocker],
    kind: "fix-blocked",
    round: 2,
    stage: "review",
    total: 2,
  });

  const stage = publisher.current.stages.find((s) => s.id === "review");
  assert.equal(stage?.openFindings, 2);
  assert.equal(stage?.totalFindings, 2);
  const preservedUserFinding = stage?.findings?.find((f) => f.file === "src/worker.ts");
  assert.ok(preservedUserFinding);
  assert.equal(preservedUserFinding.id, "fixer-no-change");
  assert.equal(preservedUserFinding.disposition, "open");
  assert.deepEqual(stage?.findings, [
    { ...userBlockerFinding, disposition: "open" },
    { ...policyBlocker, disposition: "open" },
  ]);
  assert.equal(stage?.actionableFindings, 2);
  assert.equal(stage?.fixedFindings, 0);
  assert.equal(stage?.approvedFindings, 0);
});

test("recoverFixRecords reconciles mixed legacy summaries, structured records, and durable snapshot transitions", () => {
  const snapshots: PresentationSnapshot[] = [
    {
      attempt: 1,
      mode: { autoFix: false },
      runId: "mixed-recovery",
      sequence: 1,
      status: "in-progress",
      version: 1,
      stages: [],
      updatedAt: "2026-09-05T00:00:00.000Z",
      transition: {
        analysis: 1,
        kind: "round-started",
        role: "reviewer",
        round: 0,
        stage: "review",
      },
    },
    {
      attempt: 1,
      mode: { autoFix: false },
      runId: "mixed-recovery",
      sequence: 2,
      status: "in-progress",
      version: 1,
      stages: [],
      updatedAt: "2026-09-05T00:01:00.000Z",
      transition: {
        analysis: 1,
        fixAttempt: 0,
        kind: "fix-completed",
        round: 1,
        stage: "review",
        summary: "legacy repair",
        approvedFindings: 0,
        findingIds: ["legacy-issue"],
      },
    },
    {
      attempt: 1,
      mode: { autoFix: false },
      runId: "mixed-recovery",
      sequence: 3,
      status: "in-progress",
      version: 1,
      stages: [],
      updatedAt: "2026-09-05T00:02:00.000Z",
      transition: {
        analysis: 2,
        kind: "round-started",
        role: "reviewer",
        round: 1,
        stage: "review",
      },
    },
    {
      attempt: 1,
      mode: { autoFix: false },
      runId: "mixed-recovery",
      sequence: 4,
      status: "in-progress",
      version: 1,
      stages: [],
      updatedAt: "2026-09-05T00:03:00.000Z",
      transition: {
        analysis: 2,
        fixAttempt: 0,
        kind: "fix-completed",
        round: 2,
        stage: "review",
        summary: "new repair",
        approvedFindings: 0,
        findingIds: ["new-issue"],
      },
    },
  ];

  const stageState = {
    fixRecords: [{ analysis: 2, fixAttempt: 0, summary: "new repair" }],
    fixSummaries: ["legacy repair", "new repair"],
  };

  const recovered = recoverFixRecords("review", stageState, snapshots);
  assert.equal(recovered.length, 2);
  assert.deepEqual(recovered[0], {
    analysis: 1,
    fixAttempt: 0,
    summary: "legacy repair",
  });
  assert.deepEqual(recovered[1], {
    analysis: 2,
    fixAttempt: 0,
    summary: "new repair",
  });
});

test("recoverFixRecords retains unknown-provenance legacy summaries alongside structured records without duplicate publication", () => {
  const snapshots: PresentationSnapshot[] = [
    {
      attempt: 1,
      mode: { autoFix: false },
      runId: "unknown-provenance",
      sequence: 1,
      status: "in-progress",
      version: 1,
      stages: [],
      updatedAt: "2026-09-05T00:03:00.000Z",
      transition: {
        analysis: 2,
        fixAttempt: 0,
        kind: "fix-completed",
        round: 2,
        stage: "review",
        summary: "new structured repair",
        approvedFindings: 0,
        findingIds: ["d2"],
      },
    },
  ];

  const stageState = {
    fixRecords: [{ analysis: 2, fixAttempt: 0, summary: "new structured repair" }],
    fixSummaries: ["unprovable legacy repair", "new structured repair"],
  };

  const recovered = recoverFixRecords("review", stageState, snapshots);
  assert.equal(recovered.length, 2);
  assert.equal(recovered[0], "unprovable legacy repair");
  assert.deepEqual(recovered[1], {
    analysis: 2,
    fixAttempt: 0,
    summary: "new structured repair",
  });

  const reports = [
    { findings: [{ action: "auto-fix" as const, description: "defect 1", id: "d1", severity: "error" as const }], summary: "analysis 1" },
    { findings: [{ action: "auto-fix" as const, description: "defect 2", id: "d2", severity: "error" as const }], summary: "analysis 2" },
    { findings: [], summary: "analysis 3" },
  ];

  const rounds = pullRequestPipelineRounds(reports, recovered, [
    { description: "defect 1", disposition: "fixed", id: "d1", severity: "error" },
    { description: "defect 2", disposition: "fixed", id: "d2", severity: "error" },
  ]);

  assert.equal(rounds.length, 3);
  assert.equal(rounds[0].fixSummary, undefined);
  assert.equal(rounds[1].fixSummary, undefined);
  assert.equal(rounds[2].fixSummary, "new structured repair");
  assert.deepEqual(rounds[2].historicalFixSummaries, ["unprovable legacy repair"]);

  const content = pullRequestContent("feat: test mixed recovery", {
    candidateCommitOid: "a".repeat(40),
    pipelineSteps: [
      {
        name: "review",
        rounds,
        status: "completed",
      },
    ],
    risk: { level: "low", rationale: "none" },
    testing: { artifacts: [], summary: "passed", tested: [] },
    whatChanged: "mixed legacy and structured fix summary testing",
  });

  assert.match(content.body, /🔧 Fix: new structured repair/);
  assert.match(content.body, /🔧 Historical fix: unprovable legacy repair/);
});

test("recoverFixRecords handles repeated identical summary strings preserving exact occurrence order", () => {
  const snapshots: PresentationSnapshot[] = [
    {
      attempt: 1,
      mode: { autoFix: false },
      runId: "repeated-summaries",
      sequence: 1,
      status: "in-progress",
      version: 1,
      stages: [],
      updatedAt: "2026-09-05T00:00:00.000Z",
      transition: {
        analysis: 1,
        kind: "round-started",
        role: "reviewer",
        round: 0,
        stage: "review",
      },
    },
    {
      attempt: 1,
      mode: { autoFix: false },
      runId: "repeated-summaries",
      sequence: 2,
      status: "in-progress",
      version: 1,
      stages: [],
      updatedAt: "2026-09-05T00:01:00.000Z",
      transition: {
        analysis: 1,
        fixAttempt: 0,
        kind: "fix-completed",
        round: 1,
        stage: "review",
        summary: "fixed duplicate issue",
        approvedFindings: 0,
        findingIds: ["duplicate-issue"],
      },
    },
    {
      attempt: 1,
      mode: { autoFix: false },
      runId: "repeated-summaries",
      sequence: 3,
      status: "in-progress",
      version: 1,
      stages: [],
      updatedAt: "2026-09-05T00:02:00.000Z",
      transition: {
        analysis: 2,
        kind: "round-started",
        role: "reviewer",
        round: 1,
        stage: "review",
      },
    },
    {
      attempt: 1,
      mode: { autoFix: false },
      runId: "repeated-summaries",
      sequence: 4,
      status: "in-progress",
      version: 1,
      stages: [],
      updatedAt: "2026-09-05T00:03:00.000Z",
      transition: {
        analysis: 2,
        fixAttempt: 0,
        kind: "fix-completed",
        round: 2,
        stage: "review",
        summary: "fixed duplicate issue",
        approvedFindings: 0,
        findingIds: ["duplicate-issue"],
      },
    },
  ];

  const stageState = {
    fixRecords: [{ analysis: 2, fixAttempt: 0, summary: "fixed duplicate issue" }],
    fixSummaries: ["fixed duplicate issue", "fixed duplicate issue"],
  };

  const recovered = recoverFixRecords("review", stageState, snapshots);
  assert.equal(recovered.length, 2);
  assert.deepEqual(recovered[0], {
    analysis: 1,
    fixAttempt: 0,
    summary: "fixed duplicate issue",
  });
  assert.deepEqual(recovered[1], {
    analysis: 2,
    fixAttempt: 0,
    summary: "fixed duplicate issue",
  });
});

test("recoverFixRecords handles structured-only state and repeated restoration/rendering deterministically", () => {
  const snapshots: PresentationSnapshot[] = [];
  const recA = { analysis: 1, fixAttempt: 0, summary: "repair A" };
  const recB = { analysis: 2, fixAttempt: 0, summary: "repair B" };
  const stageState = {
    fixRecords: [recA, recB],
    fixSummaries: ["repair A", "repair B"],
  };

  const first = recoverFixRecords("review", stageState, snapshots);
  const second = recoverFixRecords("review", stageState, snapshots);

  assert.deepEqual(first, [recA, recB]);
  assert.deepEqual(second, [recA, recB]);
});
