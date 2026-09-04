import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PIPELINE_STEPS } from "../scripts/config.ts";
import { DomainLedger } from "../scripts/ledger.ts";
import {
  reconcileReportWithPreservedDispositions,
  type StageReport,
} from "../scripts/orca-no-mistakes.ts";
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

test("RailTuiRenderer does not let earlier approved occurrence steal target quota", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const renderer = new RailTuiRenderer(input, output, "/unused");

  const base: PresentationSnapshot = {
    attempt: 1,
    currentStage: "review",
    mode: { autoFix: true },
    runId: "tui-duplicate-quota-run",
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
    // Stage findings ordered [approved dup-id, open dup-id]
    renderer.render({
      ...base,
      stages: base.stages.map((s) =>
        s.id === "review"
          ? {
              ...s,
              approvedFindings: 1,
              findings: [
                { description: "Approved item", disposition: "approved" as const, id: "dup-id", severity: "error" as const },
                { description: "Open target", disposition: "open" as const, id: "dup-id", severity: "error" as const },
              ],
              openFindings: 1,
              totalFindings: 2,
            }
          : s,
      ),
      transition: { actionable: 1, kind: "findings-recorded", round: 0, stage: "review", total: 2 },
    });

    // Fix targets dup-id
    renderer.render({
      ...base,
      stages: base.stages.map((s) =>
        s.id === "review"
          ? {
              ...s,
              approvedFindings: 1,
              findings: [
                { description: "Approved item", disposition: "approved" as const, id: "dup-id", severity: "error" as const },
                { description: "Open target", disposition: "open" as const, id: "dup-id", severity: "error" as const },
              ],
              openFindings: 1,
              totalFindings: 2,
            }
          : s,
      ),
      transition: {
        approvedFindings: 1,
        findingIds: ["dup-id"],
        kind: "fix-completed",
        round: 1,
        stage: "review",
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    let screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, /Review fix 1\s+·  1 fixes applied ·  1 approved/u);

    // Analysis verifies target was fixed; only approved item remains
    renderer.render({
      ...base,
      stages: base.stages.map((s) =>
        s.id === "review"
          ? {
              ...s,
              approvedFindings: 1,
              findings: [
                { description: "Approved item", disposition: "approved" as const, id: "dup-id", severity: "error" as const },
                { description: "Open target", disposition: "fixed" as const, id: "dup-id", severity: "error" as const },
              ],
              fixedFindings: 1,
              openFindings: 0,
              totalFindings: 2,
            }
          : s,
      ),
      transition: { actionable: 0, kind: "findings-recorded", round: 1, stage: "review", total: 2 },
    });

    await new Promise((resolve) => setImmediate(resolve));
    screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, /Review fix 1\s+·  1 fixed ·  1 approved/u);
    assert.doesNotMatch(screen, /Review fix 1.*applied.*fixed/u);
  } finally {
    renderer.close();
  }
});

test("reconcileReportWithPreservedDispositions marks re-reported approved findings as no-op", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    const runId = "reconcile-approved-findings-run";
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Verify re-reported approved findings do not keep control loop open.",
      policySha256: "0".repeat(64),
      repoRoot: "/repo",
      runId,
      submissionCommitOid: "1".repeat(40),
    });
    const publisher = new PresentationPublisher(ledger, runId);

    // Round 0: report has finding A and finding B
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

    // Operator fixes A and approves B
    publisher.publish("gate:0", {
      decision: "fix",
      gateId: "gate-0",
      kind: "gate-resolved",
      round: 0,
      stage: "review",
      targetFindingIds: ["finding-A"],
    });

    // Round 1 fix completed
    publisher.publish("fix:completed:1", {
      approvedFindings: 1,
      findingIds: ["finding-A"],
      kind: "fix-completed",
      round: 1,
      stage: "review",
    });

    // Reviewer in round 1 reports finding-B again
    const rawReport: StageReport = {
      findings: [
        {
          action: "auto-fix",
          description: "Issue to approve",
          id: "finding-B",
          severity: "warning",
        },
      ],
      summary: "Reviewer round 1 findings",
    };

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

    const reconciled = reconcileReportWithPreservedDispositions(
      rawReport,
      "review",
      publisher,
    );

    assert.equal(
      reconciled.findings.filter((f) => f.action !== "no-op").length,
      0,
      "re-reported approved finding must be converted to no-op so control loop exits",
    );
    assert.equal(reconciled.findings[0].action, "no-op");
  } finally {
    ledger.close();
  }
});

test("reconcileReportWithPreservedDispositions keeps open occurrences actionable when duplicate ID exists", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    const runId = "reconcile-duplicate-id-run";
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Verify duplicate ID open occurrences remain actionable.",
      policySha256: "0".repeat(64),
      repoRoot: "/repo",
      runId,
      submissionCommitOid: "1".repeat(40),
    });
    const publisher = new PresentationPublisher(ledger, runId);

    // Initial findings with duplicate ID
    publisher.publish("findings:0", {
      actionable: 1,
      findings: [
        { description: "Approved occurrence", file: "a.ts", id: "dup-id", line: 10, severity: "error" },
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

    // Round 1: reviewer reports approved occurrence and open occurrence
    publisher.publish("findings:1", {
      actionable: 1,
      findings: [
        { description: "Approved occurrence", file: "a.ts", id: "dup-id", line: 10, severity: "error" },
        { description: "Open target", file: "b.ts", id: "dup-id", line: 20, severity: "error" },
      ],
      kind: "findings-recorded",
      round: 1,
      stage: "review",
      total: 2,
    });

    const rawReport: StageReport = {
      findings: [
        { action: "auto-fix", description: "Approved occurrence", file: "a.ts", id: "dup-id", line: 10, severity: "error" },
        { action: "auto-fix", description: "Open target", file: "b.ts", id: "dup-id", line: 20, severity: "error" },
      ],
      summary: "Reviewer round 1 findings",
    };

    const reconciled = reconcileReportWithPreservedDispositions(
      rawReport,
      "review",
      publisher,
    );

    const actionable = reconciled.findings.filter((f) => f.action !== "no-op");
    assert.equal(actionable.length, 1, "only open target should remain actionable");
    assert.equal(actionable[0].description, "Open target");
    assert.equal(reconciled.findings.find((f) => f.description === "Approved occurrence")?.action, "no-op");
  } finally {
    ledger.close();
  }
});
