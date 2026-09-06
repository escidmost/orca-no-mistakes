import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { StageName } from "../scripts/config.ts";
import {
  DomainLedger,
  type Finding,
  type FixerChangesVerdict,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult,
  runPipeline,
  reconcileReportWithPreservedDispositions,
} from "../scripts/orca-no-mistakes.ts";
import { finalContiguousCheckpointByStage, evidenceSha256, sha256 } from "../scripts/ledger.ts";
import { terminalCandidate } from "../scripts/publication.ts";
import { PresentationPublisher } from "../scripts/presentation.ts";
import type { GithubAuthority } from "../scripts/github.ts";

const oid = (value: number): string => value.toString(16).padStart(40, "0");
const pass = (summary: string): StageReport => ({ findings: [], summary });
const AUTO_FIX_CONFIG =
  "auto_fix:\n  allow_review_autofix: true\n  guardrails: strict\n";

class MockGit implements GitOperations {
  readonly baseOid = oid(100);
  headOid: string;
  readonly root: string;
  readonly trustedConfig: string;

  constructor(root: string, headOid: string, trustedConfig = AUTO_FIX_CONFIG) {
    this.root = root;
    this.headOid = headOid;
    this.trustedConfig = trustedConfig;
  }

  async assertReady() {
    return {
      base: "main",
      baseOid: this.baseOid,
      branch: "feature",
      head: this.headOid,
      root: this.root,
    };
  }

  async assertClean(): Promise<void> {}
  async assertFixerChangesAllowed(): Promise<FixerChangesVerdict> {
    return { changed: true, guardrailViolations: [] };
  }
  async head(): Promise<string> {
    return this.headOid;
  }
  async diffBase(): Promise<string> {
    return "";
  }
  async rebase(): Promise<StageReport> {
    return { ...pass("rebased"), rebaseUpstreamHead: this.baseOid };
  }
  async resolveRefSha(): Promise<string> {
    return this.baseOid;
  }
  async showFile(): Promise<string | undefined> {
    return this.trustedConfig || undefined;
  }
  async pathExists(): Promise<boolean> {
    return this.trustedConfig.length > 0;
  }
  async policySha256(): Promise<string> {
    return "f".repeat(64);
  }
  async resolveBaseOid(): Promise<string> {
    return this.baseOid;
  }
  async applyWorktreeCommits(
    _sourcePath: string,
    expectedHead: string,
    targetCommitOid: string,
  ): Promise<boolean> {
    if (this.headOid !== expectedHead) return false;
    this.headOid = targetCommitOid;
    return true;
  }
  async anchorRecoveryRef(): Promise<void> {}
  async worktreeIsReusable(): Promise<boolean> { return false; }
  async verifyBranchSync(): Promise<void> {}
  async hasUntrackedChanges(): Promise<boolean> {
    return false;
  }
  async diffSummary(): Promise<string> {
    return "diff";
  }
  async headOf(): Promise<string> {
    return this.headOid;
  }
}

test("finalContiguousCheckpointByStage handles supersessions and retains historical candidate chain", () => {
  const stageIds = ["review", "test", "document", "lint"];
  const submission = oid(1);
  const headB = oid(2);
  const checkpoints = [
    { created_at: "2026-01-01T00:00:00Z", input_commit_oid: submission, output_commit_oid: submission, round_index: 0, run_id: "run", stage_id: "review" },
    { created_at: "2026-01-01T00:00:01Z", input_commit_oid: submission, output_commit_oid: submission, round_index: 0, run_id: "run", stage_id: "test" },
    { created_at: "2026-01-01T00:00:02Z", input_commit_oid: submission, output_commit_oid: headB, round_index: 0, run_id: "run", stage_id: "document" },
    { created_at: "2026-01-01T00:00:03Z", input_commit_oid: headB, output_commit_oid: headB, round_index: 1, run_id: "run", stage_id: "review" },
    { created_at: "2026-01-01T00:00:04Z", input_commit_oid: headB, output_commit_oid: headB, round_index: 1, run_id: "run", stage_id: "test" },
    { created_at: "2026-01-01T00:00:05Z", input_commit_oid: headB, output_commit_oid: headB, round_index: 1, run_id: "run", stage_id: "document" },
    { created_at: "2026-01-01T00:00:06Z", input_commit_oid: headB, output_commit_oid: headB, round_index: 0, run_id: "run", stage_id: "lint" },
  ];

  const evidence: { candidateCommitOid: string; roundIndex: number; stage: StageName }[] = [
    { candidateCommitOid: headB, roundIndex: 1, stage: "review" },
    { candidateCommitOid: headB, roundIndex: 1, stage: "test" },
    { candidateCommitOid: headB, roundIndex: 1, stage: "document" },
    { candidateCommitOid: headB, roundIndex: 0, stage: "lint" },
  ];

  const result = finalContiguousCheckpointByStage(stageIds, checkpoints, submission, evidence);
  assert.equal(result.get("review")?.output_commit_oid, headB);
  assert.equal(result.get("review")?.round_index, 1);
  assert.equal(result.get("test")?.output_commit_oid, headB);
  assert.equal(result.get("test")?.round_index, 1);
  assert.equal(result.get("document")?.output_commit_oid, headB);
  assert.equal(result.get("document")?.round_index, 1);
  assert.equal(result.get("lint")?.output_commit_oid, headB);
  assert.equal(result.get("lint")?.round_index, 0);

  const evidenceByStage: ReadonlyMap<StageName, { candidate_commit_oid: string; round_index: number }> = new Map(
    evidence.map((entry) => [entry.stage, { candidate_commit_oid: entry.candidateCommitOid, round_index: entry.roundIndex }]),
  );
  assert.deepEqual(
    finalContiguousCheckpointByStage(stageIds, checkpoints, submission, evidenceByStage),
    result,
  );
});

test("settleRemoteStage supports explicit supersession of historical open managed-comment PR settlement", () => {
  const ledger = new DomainLedger(":memory:");
  const runId = "test-pr-supersede";
  const candidate = oid(10);
  try {
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Upgrade managed comment PR to merged body.",
      policySha256: "f".repeat(64),
      repoRoot: "/repo",
      runId,
      stagePlan: [
        { requirement: "required", stageId: "push" },
        { requirement: "required", stageId: "pr" },
      ],
      submissionCommitOid: candidate,
    });
    ledger.acquireLease({ branch: "feature", repoRoot: "/repo", runId });
    ledger.startAttempt({
      actorIdentity: "coordinator",
      attemptId: "att-1",
      coordinatorIdentity: "coordinator",
      generationToken: 1,
      runId,
      startedAt: new Date().toISOString(),
    });
    const route = {
      actorId: "actor1",
      actorLogin: "owner",
      actorNodeId: "U_actor",
      backend: "gh" as const,
      backendVersion: "2.0.0",
      baseBranch: "main",
      baseRepositoryId: "R_base",
      baseRepositoryName: "owner/repo",
      baseRepositoryNodeId: "R_base",
      credentialSource: "GH_TOKEN" as const,
      forgeHost: "github.com" as const,
      headBranch: "feature",
      headOwner: "owner",
      headRepositoryId: "R_head",
      headRepositoryName: "owner/repo",
      headRepositoryNodeId: "R_head",
      networkRootRepositoryId: "R_base",
      observedAt: new Date().toISOString(),
      repoRoot: "/repo",
    };
    ledger.setRepositoryPublicationRoute(route);
    const routeFingerprint = ledger.recordStoredPublicationRoute(runId, "/repo");

    const makeEvidence = (stageId: "push" | "pr", roundIndex: number, summary: string) => {
      const e = {
        artifactPath: `/tmp/${stageId}-${roundIndex}.json`,
        artifactSha256: sha256(Buffer.from(`${stageId}-${roundIndex}`)),
        baseCommitOid: candidate,
        candidateCommitOid: candidate,
        exitCode: 0,
        roundIndex,
        runId,
        stageId,
        summary,
        workerIdentity: `coordinator:${stageId}`,
      };
      return {
        ...e,
        evidenceSha256: evidenceSha256({
          artifactSha256: e.artifactSha256,
          baseCommitOid: e.baseCommitOid,
          candidateCommitOid: e.candidateCommitOid,
          exitCode: e.exitCode,
          round: e.roundIndex,
          runId: e.runId,
          stage: e.stageId,
          summary: e.summary,
          workerIdentity: e.workerIdentity,
        }),
      };
    };
    ledger.recordPublicationBaseline({
      headCommitOid: null,
      observedAt: "2026-08-30T12:00:01.000Z",
      routeFingerprint,
      runId,
      transportUrl: "github.com/owner/repo",
    });

    const preRead = ledger.recordRemoteObservation({
      attemptId: "att-1",
      kind: "publication-head",
      observedAt: "2026-08-30T12:00:01.000Z",
      payload: {
        forgeHost: "github.com",
        headBranch: "feature",
        headOwner: "owner",
        repositoryId: "R_head",
        state: "absent",
      },
      runId,
      subject: "github.com/R_head:refs/heads/feature",
    });

    const pubIntent = ledger.recordMutationIntent({
      attemptId: "att-1",
      createdAt: "2026-08-30T12:00:02.000Z",
      kind: "candidate-publication",
      payload: { expected: "absent", update: candidate },
      runId,
      targetFingerprint: routeFingerprint,
    });

    const pushObservation = ledger.recordRemoteObservation({
      attemptId: "att-1",
      kind: "publication-head",
      observedAt: "2026-08-30T12:00:03.000Z",
      payload: {
        forgeHost: "github.com",
        headBranch: "feature",
        headOwner: "owner",
        oid: candidate,
        repositoryId: "R_head",
      },
      runId,
      subject: "github.com/R_head:refs/heads/feature",
    });

    const pushEvidence = makeEvidence("push", 0, "pushed candidate");
    ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 0 },
      evidence: pushEvidence,
      ownership: { branch: "feature", generationToken: 1, repoRoot: "/repo" },
      receipt: {
        authoritativePostObservationSha256: pushObservation,
        candidateCommitOid: candidate,
        kind: "candidate-publication",
        payload: {
          mutationIntent: pubIntent,
          outcome: "created",
          postRead: pushObservation,
          preRead,
          routeFingerprint,
        },
      },
      runId,
      stageId: "push",
    });

    // 1. Durably settle open PR stage at round 0
    const prFacts = {
      baseBranch: "main",
      baseRepositoryId: "R_base",
      candidateCommitOid: candidate,
      forgeHost: "github.com",
      headBranch: "feature",
      headOwner: "owner",
      headRepositoryId: "R_head",
    };
    const pr1Intent = ledger.recordMutationIntent({
      attemptId: "att-1",
      createdAt: "2026-08-30T12:00:04.000Z",
      kind: "pull-request",
      payload: { action: "ensure-open", ...prFacts },
      runId,
      targetFingerprint: routeFingerprint,
    });
    const pipelineEvidenceRoot = sha256("pipeline");
    const managedCommentBodySha256 = sha256("managed summary");
    const managedCommentIntent = ledger.recordMutationIntent({
      attemptId: "att-1",
      createdAt: "2026-08-30T12:00:04.500Z",
      kind: "managed-comment",
      payload: {
        action: "ensure-managed-summary",
        bodySha256: managedCommentBodySha256,
        managedCommentNodeId: "IC_comment",
        number: 42,
      },
      runId,
      targetFingerprint: routeFingerprint,
    });
    const pr1Observation = ledger.recordRemoteObservation({
      attemptId: "att-1",
      kind: "pull-request",
      observedAt: "2026-08-30T12:00:05.000Z",
      payload: {
        ...prFacts,
        managedCommentBodySha256,
        managedCommentNodeId: "IC_comment",
        number: 42,
        pullRequestNodeId: "PR_42",
        state: "open",
      },
      runId,
      subject: "github.com/R_base#42",
    });
    const pr1Evidence = makeEvidence("pr", 0, "open pr bound");
    const initialPrReceipt = ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 0 },
      evidence: pr1Evidence,
      ownership: { branch: "feature", generationToken: 1, repoRoot: "/repo" },
      receipt: {
        authoritativePostObservationSha256: pr1Observation,
        candidateCommitOid: candidate,
        kind: "pull-request-binding",
        payload: {
          managedCommentIntent,
          mutationIntent: pr1Intent,
          number: 42,
          outcome: "created",
          pipelineEvidenceRoot,
          postRead: pr1Observation,
          routeFingerprint,
        },
      },
      runId,
      stageId: "pr",
    });

    assert.equal(
      ledger.stageDispositions(runId).find((row) => row.stage_id === "pr")?.evidence_sha256,
      pr1Evidence.evidenceSha256,
    );

    // 2. Now PR merges and settles remote stage at round 1 with merged body
    const bodyText = "PR merged body content";
    const titleText = "PR merged title";
    const bodySha = sha256(bodyText);
    const titleSha = sha256(titleText);
    const pr2Intent = ledger.recordMutationIntent({
      attemptId: "att-1",
      createdAt: "2026-08-30T12:00:06.000Z",
      kind: "pull-request",
      payload: {
        action: "ensure-body-and-await-merge",
        body: bodyText,
        title: titleText,
        ...prFacts,
      },
      runId,
      targetFingerprint: routeFingerprint,
    });
    const pr2Observation = ledger.recordRemoteObservation({
      attemptId: "att-1",
      kind: "pull-request",
      observedAt: "2026-08-30T12:00:07.000Z",
      payload: {
        ...prFacts,
        bodySha256: bodySha,
        number: 42,
        pullRequestNodeId: "PR_node_1",
        state: "merged",
        titleSha256: titleSha,
      },
      runId,
      subject: "github.com/R_base#42",
    });
    const pr2Evidence = makeEvidence("pr", 1, "merged body bound");
    const mergedPrReceipt = ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 1 },
      evidence: pr2Evidence,
      ownership: { branch: "feature", generationToken: 1, repoRoot: "/repo" },
      receipt: {
        authoritativePostObservationSha256: pr2Observation,
        candidateCommitOid: candidate,
        kind: "pull-request-binding",
        payload: {
          bodySha256: bodySha,
          mutationIntent: pr2Intent,
          number: 42,
          outcome: "created",
          pipelineEvidenceRoot: sha256("pipeline"),
          postRead: pr2Observation,
          routeFingerprint,
          state: "merged",
          titleSha256: titleSha,
        },
      },
      runId,
      stageId: "pr",
      supersedesEvidenceSha256: pr1Evidence.evidenceSha256,
    });

    assert.notEqual(mergedPrReceipt.receiptSha256, initialPrReceipt.receiptSha256);
    // Historical receipt is retained
    assert.ok(ledger.remoteReceipt(runId, "pull-request-binding", initialPrReceipt.receiptSha256));
    assert.ok(ledger.remoteReceipt(runId, "pull-request-binding", mergedPrReceipt.receiptSha256));
    // Effective disposition names merged evidence
    assert.equal(
      ledger.stageDispositions(runId).find((row) => row.stage_id === "pr")?.evidence_sha256,
      pr2Evidence.evidenceSha256,
    );

    // 3. Unrelated conflicting settlement is rejected
    const pr3Evidence = makeEvidence("pr", 2, "conflicting pr");
    assert.throws(
      () =>
        ledger.settleRemoteStage({
          checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 2 },
          evidence: pr3Evidence,
          ownership: { branch: "feature", generationToken: 1, repoRoot: "/repo" },
          receipt: {
            authoritativePostObservationSha256: pr2Observation,
            candidateCommitOid: candidate,
            kind: "pull-request-binding",
            payload: {
              bodySha256: bodySha,
              mutationIntent: pr2Intent,
              number: 42,
              outcome: "created",
              pipelineEvidenceRoot: sha256("pipeline"),
              postRead: pr2Observation,
              routeFingerprint,
              state: "merged",
              titleSha256: titleSha,
            },
          },
          runId,
          stageId: "pr",
          supersedesEvidenceSha256: "wrong-sha",
        }),
      /already settled with a different disposition/,
    );
  } finally {
    ledger.close();
  }
});

test("presentation stage-reopened preserves cumulative history and fix records while invalidating candidate approvals", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "test",
      policySha256: "f".repeat(64),
      repoRoot: "/repo",
      runId: "test-reopened",
      stagePlan: [{ requirement: "required", stageId: "review" }],
      submissionCommitOid: oid(1),
    });
    const publisher = new PresentationPublisher(ledger, "test-reopened");

    publisher.publish("start", { kind: "run-started" });
    publisher.publish("stage:review:started", { kind: "stage-started", stage: "review" });
    publisher.publish("findings:1", {
      actionable: 2,
      findings: [
        { description: "finding A", file: "a.ts", id: "f-a", line: 10, severity: "error" },
        { description: "finding B", file: "b.ts", id: "f-b", line: 20, severity: "warning" },
      ],
      kind: "findings-recorded",
      round: 0,
      stage: "review",
      total: 2,
    });

    // User resolves gate by fixing finding A, approving B
    publisher.publish("gate:1:resolved", {
      decision: "fix",
      gateId: "g1",
      kind: "gate-resolved",
      round: 0,
      stage: "review",
      targetFindingIds: ["f-a"],
    });

    assert.equal(publisher.current.stages.find((s) => s.id === "review")?.approvedFindings, 1);

    // Fix completes
    publisher.publish("fix:1", {
      approvedFindings: 1,
      findingIds: ["f-a"],
      kind: "fix-completed",
      round: 0,
      stage: "review",
      summary: "fixed finding A",
    });

    // Round 1 reviewer runs: finding A is resolved, finding B is unchanged
    publisher.publish("findings:2", {
      actionable: 0,
      findings: [
        { description: "finding B", file: "b.ts", id: "f-b", line: 20, severity: "warning" },
      ],
      kind: "findings-recorded",
      round: 1,
      stage: "review",
      total: 2,
    });

    const reviewState = publisher.current.stages.find((s) => s.id === "review")!;
    assert.equal(reviewState.fixRecords?.length, 1);
    assert.equal(reviewState.fixSummaries?.length, 1);
    assert.equal(reviewState.fixedFindings, 1);

    // Now HEAD changes in document stage -> review is reopened
    publisher.publish("stage:review:reopened", { kind: "stage-reopened", stage: "review" });
    const reopenedReview = publisher.current.stages.find((s) => s.id === "review")!;
    assert.equal(reopenedReview.fixRecords?.length, 1, "fixRecords must be retained across reopen");
    assert.equal(reopenedReview.fixSummaries?.length, 1, "fixSummaries must be retained across reopen");
    assert.equal(reopenedReview.fixedFindings, 1, "fixed count must be retained across reopen");
    assert.equal(reopenedReview.approvedFindings, 0, "candidate approvals must be invalidated");
    assert.ok(
      reopenedReview.findings?.some((f) => f.id === "f-b" && f.disposition === "open"),
      "approved finding must revert to open on candidate change",
    );
  } finally {
    ledger.close();
  }
});

test("reconcileReportWithPreservedDispositions only reconciles exact unchanged findings", () => {
  const presentation = {
    stages: [
      {
        id: "review",
        findings: [
          { description: "exact desc", disposition: "approved", file: "a.ts", id: "f1", line: 10, severity: "error" },
        ],
      },
    ],
  } as any;

  // Exact match -> converted to no-op
  const exactReport: StageReport = {
    findings: [{ action: "auto-fix", description: "exact desc", file: "a.ts", id: "f1", line: 10, severity: "error" }],
    summary: "review",
  };
  const exactResult = reconcileReportWithPreservedDispositions(exactReport, "review", presentation);
  assert.equal(exactResult.findings[0]?.action, "no-op");

  // Materially changed line -> NOT converted to no-op
  const changedLineReport: StageReport = {
    findings: [{ action: "auto-fix", description: "exact desc", file: "a.ts", id: "f1", line: 99, severity: "error" }],
    summary: "review",
  };
  const changedResult = reconcileReportWithPreservedDispositions(changedLineReport, "review", presentation);
  assert.equal(changedResult.findings[0]?.action, "auto-fix");
});
