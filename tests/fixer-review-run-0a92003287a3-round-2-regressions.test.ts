import assert from "node:assert/strict";
import test from "node:test";

import { DomainLedger } from "../scripts/ledger.ts";
import { PresentationPublisher } from "../scripts/presentation.ts";

test("selective fix preserves approved findings when re-reported by reviewer", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    const runId = "selective-approval-preservation";
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Verify selective approval retention across rounds.",
      policySha256: "0".repeat(64),
      repoRoot: "/repo",
      runId,
      submissionCommitOid: "1".repeat(40),
    });
    const publisher = new PresentationPublisher(ledger, runId);

    // Round 0: findings A and B are reported
    publisher.publish("findings:0", {
      actionable: 2,
      findings: [
        { description: "Issue to fix", id: "finding-A", severity: "error" },
        { description: "Issue to approve", id: "finding-B", severity: "warning" },
      ],
      kind: "findings-recorded",
      round: 0,
      stage: "review",
      total: 2,
    });

    const initial = publisher.current.stages.find((s) => s.id === "review");
    assert.equal(initial?.openFindings, 2);
    assert.equal(initial?.approvedFindings, 0);

    // Operator fixes A and approves B
    publisher.publish("gate:0", {
      decision: "fix",
      gateId: "gate-0",
      kind: "gate-resolved",
      round: 0,
      stage: "review",
      targetFindingIds: ["finding-A"],
    });

    const resolved = publisher.current.stages.find((s) => s.id === "review");
    assert.equal(resolved?.openFindings, 1);
    assert.equal(resolved?.approvedFindings, 1);

    // Fixer completes round 1
    publisher.publish("fix:completed:1", {
      approvedFindings: 1,
      findingIds: ["finding-A"],
      kind: "fix-completed",
      round: 1,
      stage: "review",
    });

    // Reviewer re-analysis: A disappeared (fixed), B is reported again
    publisher.publish("findings:1", {
      actionable: 0,
      findings: [
        { description: "Issue to approve", id: "finding-B", severity: "warning" },
      ],
      kind: "findings-recorded",
      round: 1,
      stage: "review",
      total: 2,
    });

    const verified = publisher.current.stages.find((s) => s.id === "review");
    assert.equal(verified?.fixedFindings, 1, "disappeared finding A moves to fixed");
    assert.equal(verified?.approvedFindings, 1, "re-reported finding B remains approved");
    assert.equal(verified?.openFindings, 0, "no findings remain open");
    assert.equal(verified?.actionableFindings, 0);
    assert.equal(verified?.status, "active", "stage is not blocked when only approved findings remain");

    const findingB = verified?.findings?.find((f) => f.id === "finding-B");
    assert.equal(findingB?.disposition, "approved");
  } finally {
    ledger.close();
  }
});

test("re-reported fixed occurrences reopen while approved occurrences remain approved", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    const runId = "reopened-fixed-finding";
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Verify fixed finding reopening.",
      policySha256: "0".repeat(64),
      repoRoot: "/repo",
      runId,
      submissionCommitOid: "1".repeat(40),
    });
    const publisher = new PresentationPublisher(ledger, runId);

    // Round 0
    publisher.publish("findings:0", {
      actionable: 2,
      findings: [
        { description: "Fixed issue", id: "finding-fixed", severity: "error" },
        { description: "Approved issue", id: "finding-approved", severity: "warning" },
      ],
      kind: "findings-recorded",
      round: 0,
      stage: "review",
      total: 2,
    });

    // Gate resolves
    publisher.publish("gate:0", {
      decision: "fix",
      gateId: "gate-0",
      kind: "gate-resolved",
      round: 0,
      stage: "review",
      targetFindingIds: ["finding-fixed"],
    });

    publisher.publish("fix:completed:1", {
      approvedFindings: 1,
      findingIds: ["finding-fixed"],
      kind: "fix-completed",
      round: 1,
      stage: "review",
    });

    // Round 1: finding-fixed disappeared
    publisher.publish("findings:1", {
      actionable: 0,
      findings: [
        { description: "Approved issue", id: "finding-approved", severity: "warning" },
      ],
      kind: "findings-recorded",
      round: 1,
      stage: "review",
      total: 2,
    });

    const round1 = publisher.current.stages.find((s) => s.id === "review");
    assert.equal(round1?.fixedFindings, 1);
    assert.equal(round1?.approvedFindings, 1);

    // Round 2: finding-fixed regresses and is reported again alongside finding-approved
    publisher.publish("findings:2", {
      actionable: 1,
      findings: [
        { description: "Fixed issue regressed", id: "finding-fixed", severity: "error" },
        { description: "Approved issue", id: "finding-approved", severity: "warning" },
      ],
      kind: "findings-recorded",
      round: 2,
      stage: "review",
      total: 2,
    });

    const round2 = publisher.current.stages.find((s) => s.id === "review");
    assert.equal(round2?.fixedFindings, 0, "regressed finding is no longer fixed");
    assert.equal(round2?.approvedFindings, 1, "approved finding remains approved");
    assert.equal(round2?.openFindings, 1, "regressed finding reopens as open");
  } finally {
    ledger.close();
  }
});
