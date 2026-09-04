import assert from "node:assert/strict";
import test from "node:test";

import { DomainLedger } from "../scripts/ledger.ts";
import { PresentationPublisher } from "../scripts/presentation.ts";

test("duplicate approved and open occurrences preserve target identity when only still-open occurrence is re-reported", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    const runId = "duplicate-approved-target-retention";
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Verify duplicate approved and open occurrence identity retention.",
      policySha256: "0".repeat(64),
      repoRoot: "/repo",
      runId,
      submissionCommitOid: "1".repeat(40),
    });
    const publisher = new PresentationPublisher(ledger, runId);

    // Round 0: First occurrence is reported and approved
    publisher.publish("findings:0", {
      actionable: 1,
      findings: [
        { description: "Approved occurrence", file: "scripts/a.ts", id: "dup-id", line: 10, severity: "error" },
      ],
      kind: "findings-recorded",
      round: 0,
      stage: "review",
      total: 1,
    });

    publisher.publish("gate:0", {
      decision: "approve",
      gateId: "gate-0",
      kind: "gate-resolved",
      round: 0,
      stage: "review",
    });

    // Round 1: Reviewer re-reports approved occurrence alongside a new open occurrence with duplicate ID
    publisher.publish("findings:1", {
      actionable: 1,
      findings: [
        { description: "Approved occurrence", file: "scripts/a.ts", id: "dup-id", line: 10, severity: "error" },
        { description: "Target to fix", file: "scripts/b.ts", id: "dup-id", line: 20, severity: "error" },
      ],
      kind: "findings-recorded",
      round: 1,
      stage: "review",
      total: 2,
    });

    const priorState = publisher.current.stages.find((s) => s.id === "review");
    assert.equal(priorState?.approvedFindings, 1);
    assert.equal(priorState?.openFindings, 1);
    assert.equal(priorState?.findings?.[0].disposition, "approved");
    assert.equal(priorState?.findings?.[1].disposition, "open");

    // Fixer targets the open finding in round 2
    publisher.publish("fix:completed:2", {
      approvedFindings: 1,
      findingIds: ["dup-id"],
      kind: "fix-completed",
      round: 2,
      stage: "review",
    });

    // Reviewer re-analysis in round 2 reports ONLY the still-open target
    publisher.publish("findings:2", {
      actionable: 1,
      findings: [
        { description: "Target to fix", file: "scripts/b.ts", id: "dup-id", line: 20, severity: "error" },
      ],
      kind: "findings-recorded",
      round: 2,
      stage: "review",
      total: 2,
    });

    const verified = publisher.current.stages.find((s) => s.id === "review");
    assert.equal(verified?.fixedFindings, 0, "target must not be falsely verified as fixed");
    assert.equal(verified?.openFindings, 1, "target remains open");
    assert.equal(verified?.approvedFindings, 1, "approved occurrence remains approved");
    assert.equal(verified?.actionableFindings, 1);
    assert.equal(verified?.status, "blocked", "stage remains blocked while target is open");

    const target = verified?.findings?.find((f) => f.description === "Target to fix");
    assert.equal(target?.disposition, "open");

    const approved = verified?.findings?.find((f) => f.description === "Approved occurrence");
    assert.equal(approved?.disposition, "approved");
  } finally {
    ledger.close();
  }
});

test("duplicate approved and open occurrences mark target fixed when only approved occurrence is re-reported", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    const runId = "duplicate-approved-target-fixed";
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Verify duplicate occurrence correctly moves to fixed when target disappears.",
      policySha256: "0".repeat(64),
      repoRoot: "/repo",
      runId,
      submissionCommitOid: "1".repeat(40),
    });
    const publisher = new PresentationPublisher(ledger, runId);

    // Round 0: First occurrence is reported and approved
    publisher.publish("findings:0", {
      actionable: 1,
      findings: [
        { description: "Approved occurrence", file: "scripts/a.ts", id: "dup-id", line: 10, severity: "error" },
      ],
      kind: "findings-recorded",
      round: 0,
      stage: "review",
      total: 1,
    });

    publisher.publish("gate:0", {
      decision: "approve",
      gateId: "gate-0",
      kind: "gate-resolved",
      round: 0,
      stage: "review",
    });

    // Round 1: Reviewer re-reports approved occurrence alongside a new open occurrence
    publisher.publish("findings:1", {
      actionable: 1,
      findings: [
        { description: "Approved occurrence", file: "scripts/a.ts", id: "dup-id", line: 10, severity: "error" },
        { description: "Target to fix", file: "scripts/b.ts", id: "dup-id", line: 20, severity: "error" },
      ],
      kind: "findings-recorded",
      round: 1,
      stage: "review",
      total: 2,
    });

    // Fixer targets the open finding in round 2
    publisher.publish("fix:completed:2", {
      approvedFindings: 1,
      findingIds: ["dup-id"],
      kind: "fix-completed",
      round: 2,
      stage: "review",
    });

    // Reviewer re-analysis in round 2 reports ONLY the approved occurrence (target disappeared = fixed)
    publisher.publish("findings:2", {
      actionable: 0,
      findings: [
        { description: "Approved occurrence", file: "scripts/a.ts", id: "dup-id", line: 10, severity: "error" },
      ],
      kind: "findings-recorded",
      round: 2,
      stage: "review",
      total: 2,
    });

    const verified = publisher.current.stages.find((s) => s.id === "review");
    assert.equal(verified?.fixedFindings, 1, "target moves to fixed");
    assert.equal(verified?.openFindings, 0, "no findings remain open");
    assert.equal(verified?.approvedFindings, 1, "approved occurrence remains approved");
    assert.equal(verified?.actionableFindings, 0);
    assert.equal(verified?.status, "active", "stage is active when only approved findings remain");

    const target = verified?.findings?.find((f) => f.description === "Target to fix");
    assert.equal(target?.disposition, "fixed");

    const approved = verified?.findings?.find((f) => f.description === "Approved occurrence");
    assert.equal(approved?.disposition, "approved");
  } finally {
    ledger.close();
  }
});

test("non-exact duplicate ID matches prefer currently open occurrences before approved occurrences", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    const runId = "duplicate-non-exact-prefer-open";
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Verify non-exact duplicate ID matching prefers open occurrences.",
      policySha256: "0".repeat(64),
      repoRoot: "/repo",
      runId,
      submissionCommitOid: "1".repeat(40),
    });
    const publisher = new PresentationPublisher(ledger, runId);

    // Round 0: First occurrence is reported and approved
    publisher.publish("findings:0", {
      actionable: 1,
      findings: [
        { description: "Approved occurrence", file: "scripts/a.ts", id: "dup-id", line: 10, severity: "error" },
      ],
      kind: "findings-recorded",
      round: 0,
      stage: "review",
      total: 1,
    });

    publisher.publish("gate:0", {
      decision: "approve",
      gateId: "gate-0",
      kind: "gate-resolved",
      round: 0,
      stage: "review",
    });

    // Round 1: Reviewer re-reports approved occurrence alongside open occurrence
    publisher.publish("findings:1", {
      actionable: 1,
      findings: [
        { description: "Approved occurrence", file: "scripts/a.ts", id: "dup-id", line: 10, severity: "error" },
        { description: "Target to fix", file: "scripts/b.ts", id: "dup-id", line: 20, severity: "error" },
      ],
      kind: "findings-recorded",
      round: 1,
      stage: "review",
      total: 2,
    });

    publisher.publish("fix:completed:2", {
      approvedFindings: 1,
      findingIds: ["dup-id"],
      kind: "fix-completed",
      round: 2,
      stage: "review",
    });

    // Reviewer re-analysis reports modified occurrence with changed line/description
    publisher.publish("findings:2", {
      actionable: 1,
      findings: [
        { description: "Target modified", file: "scripts/b.ts", id: "dup-id", line: 25, severity: "error" },
      ],
      kind: "findings-recorded",
      round: 2,
      stage: "review",
      total: 2,
    });

    const verified = publisher.current.stages.find((s) => s.id === "review");
    assert.equal(verified?.fixedFindings, 0, "open occurrence was not stolen by approved entry");
    assert.equal(verified?.openFindings, 1, "non-exact match preferred open occurrence");
    assert.equal(verified?.approvedFindings, 1, "approved occurrence retained");
  } finally {
    ledger.close();
  }
});
