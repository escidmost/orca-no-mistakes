import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DomainLedger } from "../scripts/ledger.ts";
import {
  PresentationPublisher,
  type PresentationSnapshot,
} from "../scripts/presentation.ts";
import { pullRequestArtifacts } from "../scripts/orca-no-mistakes.ts";
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

test("branchIntents bounds accumulated intents to current branch incarnation after merged PR", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-branch-intents-"));
  const dbPath = path.join(temp, "ledger.sqlite");
  const ledger = new DomainLedger(dbPath);
  try {
    const repoRoot = "/repo";
    const branch = "feature";

    ledger.startRun({
      baseBranch: "main",
      branch,
      intent: "First incarnation intent",
      policySha256: "a".repeat(64),
      repoRoot,
      runId: "run-1",
      submissionCommitOid: "1".repeat(40),
    });

    const genToken = ledger.acquireLease({ branch, repoRoot, runId: "run-1" });
    ledger.startAttempt({
      actorIdentity: "operator",
      attemptId: "att-1",
      coordinatorIdentity: "coordinator",
      generationToken: genToken,
      runId: "run-1",
      startedAt: "2026-09-02T10:00:00.000Z",
    });

    const obsSha = ledger.recordRemoteObservation({
      attemptId: "att-1",
      kind: "pull-request",
      observedAt: "2026-09-02T12:00:00.000Z",
      payload: {
        baseBranch: "main",
        bodySha256: "c".repeat(64),
        candidateCommitOid: "1".repeat(40),
        forgeHost: "github.com",
        headBranch: branch,
        headOwner: "owner",
        headRepositoryId: "repo",
        number: 101,
        pullRequestNodeId: "PR_node1",
        state: "merged",
        titleSha256: "d".repeat(64),
      },
      runId: "run-1",
      subject: "github.com/owner/repo#101",
    });

    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO remote_receipts (
         receipt_id, run_id, kind, candidate_commit_oid,
         authoritative_post_observation_sha256, receipt_json, receipt_sha256, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      "run-1",
      "pull-request-binding",
      "1".repeat(40),
      obsSha,
      JSON.stringify({
        state: "merged",
      }),
      "e".repeat(64),
      "2026-09-02T12:00:00.000Z"
    );

    ledger.startRun({
      baseBranch: "main",
      branch,
      intent: "Second incarnation intent",
      policySha256: "f".repeat(64),
      repoRoot,
      runId: "run-2",
      submissionCommitOid: "2".repeat(40),
    });

    const intents = ledger.branchIntents(repoRoot, branch, "run-2");
    assert.deepEqual(intents, ["Second incarnation intent"]);

    const intentsNoRunId = ledger.branchIntents(repoRoot, branch);
    assert.deepEqual(intentsNoRunId, ["Second incarnation intent"]);
  } finally {
    ledger.close();
    await rm(temp, { force: true, recursive: true });
  }
});

test("pullRequestArtifacts rejects auxiliary artifacts with tampered digests", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "onm-test-artifacts-"));
  try {
    const artifactPath = "test-output.txt";
    const fullPath = path.join(dir, artifactPath);
    await writeFile(fullPath, "original valid content");

    const digest = createHash("sha256").update("original valid content").digest("hex");

    const validReport = {
      artifactDigests: { [artifactPath]: digest },
      artifacts: [artifactPath],
      findings: [],
      summary: "test passed",
    };

    const embedded = await pullRequestArtifacts(dir, validReport);
    assert.equal(embedded.length, 1);
    assert.equal(embedded[0]?.content, "original valid content");

    await writeFile(fullPath, "tampered malicious content");

    const tampered = await pullRequestArtifacts(dir, validReport);
    assert.equal(tampered.length, 0);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PresentationPublisher seeds RailTuiRenderer activity history from persisted snapshots on resume", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalRenderer = new RailTuiRenderer(input, output, "/unused");
  const snapshots: PresentationSnapshot[] = [];
  const store = {
    listPresentationSnapshots: () => [...snapshots],
    recordPresentationSnapshot: (_runId: string, _key: string, value: PresentationSnapshot) => {
      snapshots.push(value);
      return true;
    },
  };

  const publisher = new PresentationPublisher(store, "test-resume-activities", originalRenderer);

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
    findings: [{ description: "no change", id: "fixer-no-change", severity: "error" }],
    kind: "fix-blocked",
    round: 1,
    stage: "review",
    total: 1,
  });

  originalRenderer.close();

  const freshInput = new FakeInput();
  const freshOutput = new FakeOutput();
  freshOutput.columns = 140;
  freshOutput.rows = 30;
  const resumedRenderer = new RailTuiRenderer(freshInput, freshOutput, "/unused");
  const resumedPublisher = new PresentationPublisher(store, "test-resume-activities", resumedRenderer);

  resumedPublisher.publish("attempt-2", {
    attempt: 2,
    kind: "attempt-started",
  });

  await nextDraw();
  const screen = cleanScreen(freshOutput.writes.at(-1) ?? "");
  assert.match(screen, /Review fix 1\s+· blocked/u);
  assert.match(screen, /Review analysis 1/u);
  resumedRenderer.close();
});

test("rereported approved findings do not inflate found count in activity", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 140;
  output.rows = 30;
  const renderer = new RailTuiRenderer(input, output, "/unused");
  const snapshots: PresentationSnapshot[] = [];
  const publisher = new PresentationPublisher(
    {
      listPresentationSnapshots: () => snapshots,
      recordPresentationSnapshot: (_runId, _key, value) => (snapshots.push(value), true),
    },
    "test-reconciled-analysis-count",
    renderer,
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
    findings: [
      { description: "f1", id: "f1", severity: "error" },
      { description: "f2", id: "f2", severity: "error" },
    ],
    kind: "findings-recorded",
    round: 0,
    stage: "review",
    total: 2,
  });

  publisher.publish("gate-1-resolved", {
    decision: "fix",
    gateId: "g1",
    kind: "gate-resolved",
    round: 1,
    stage: "review",
    targetFindingIds: ["f2"],
  });
  publisher.publish("fix-1", {
    kind: "round-started",
    role: "fixer",
    round: 1,
    stage: "review",
    targetFindingIds: ["f2"],
  });
  publisher.publish("fix-1-done", {
    approvedFindings: 1,
    findingIds: ["f2"],
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
    actionable: 2,
    analysis: 2,
    findings: [
      { description: "f1", id: "f1", severity: "error" },
      { description: "f2", id: "f2", severity: "error" },
    ],
    kind: "findings-recorded",
    round: 1,
    stage: "review",
    total: 2,
  });

  await nextDraw();
  const screen = cleanScreen(output.writes.at(-1) ?? "");
  assert.match(screen, /Review analysis 2\s+· 1 found/u);
  renderer.close();
});

test("blocked fixer phase does not render fixing glyph in detail panel", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 140;
  output.rows = 30;
  const renderer = new RailTuiRenderer(input, output, "/unused");
  const snapshots: PresentationSnapshot[] = [];
  const publisher = new PresentationPublisher(
    {
      listPresentationSnapshots: () => snapshots,
      recordPresentationSnapshot: (_runId, _key, value) => (snapshots.push(value), true),
    },
    "test-blocked-fixing-glyph",
    renderer,
  );

  publisher.publish("stage", { kind: "stage-started", stage: "review" });
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
      {
        description: "Policy violation on protected test",
        id: "fixer-policy-violation",
        severity: "error",
      },
    ],
    kind: "fix-blocked",
    round: 1,
    stage: "review",
    total: 1,
  });

  await nextDraw();
  const screen = cleanScreen(output.writes.at(-1) ?? "");
  // Blocked heading should be retained: REVIEW  blocked · fix 1
  assert.match(screen, /REVIEW\s+blocked\s+·\s+fix 1/u);
  // Fixing glyph `*` should not be rendered for blocked findings; should be open `○`
  assert.doesNotMatch(screen, /\*\s+fixer-policy-violation/u);
  renderer.close();
});
