import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DomainLedger,
  buildPipelineCompletionAttestation,
  canonicalJson,
  evidenceSha256,
  isAuthoritativeStageEvidence,
  sha256,
  type StageEvidenceManifestEntry,
} from "../scripts/ledger.ts";

const base = "a".repeat(40);
const candidate = "b".repeat(40);
const submission = "c".repeat(40);
const policy = "d".repeat(64);
const stages = ["intent", "rebase", "review", "test", "document", "lint", "push", "pr"];

async function createCompletionFixture() {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-v2-fixture-"));
  const dbPath = path.join(temp, "ledger.sqlite");
  const ledger = new DomainLedger(dbPath);
  const runId = `v2-retained-${randomUUID().slice(0, 8)}`;
  const intent = "Retain exact completion provenance.";
  const artifact = Buffer.from("{}");
  const entries: (StageEvidenceManifestEntry & { artifactPath: string })[] = [];
  for (const [round, stage] of stages.entries()) {
    const artifactPath = path.join(temp, `${stage}.json`);
    await writeFile(artifactPath, artifact);
    const entry = {
      artifactPath,
      artifactSha256: sha256(artifact),
      baseCommitOid: base,
      candidateCommitOid: candidate,
      evidenceSha256: "",
      exitCode: 0,
      round,
      stage,
      summary: `${stage} completed.`,
      workerIdentity: "coordinator",
    };
    entry.evidenceSha256 = evidenceSha256({ ...entry, runId });
    entries.push(entry);
  }
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent,
    policySha256: policy,
    repoRoot: "/repo",
    runId,
    stagePlan: stages.map((stageId) => ({ requirement: "required", stageId })),
    submissionCommitOid: submission,
  });
  const generationToken = ledger.acquireLease({ branch: "feature", repoRoot: "/repo", runId });
  for (const entry of entries) {
    ledger.recordStageDisposition({
      disposition: "satisfied",
      evidenceSha256: entry.evidenceSha256,
      runId,
      stageId: entry.stage,
    });
    if (entry.stage !== "push" && entry.stage !== "pr") {
      ledger.recordEvidence({
        artifactPath: entry.artifactPath,
        artifactSha256: entry.artifactSha256,
        baseCommitOid: entry.baseCommitOid,
        candidateCommitOid: entry.candidateCommitOid,
        evidenceSha256: entry.evidenceSha256,
        exitCode: entry.exitCode,
        roundIndex: entry.round,
        runId,
        stageId: entry.stage,
        summary: entry.summary,
        workerIdentity: entry.workerIdentity,
      });
    }
  }
  const publicationRoute = {
    baseBranch: "main",
    baseRepositoryId: "R_base",
    forgeHost: "github.com",
    headBranch: "feature",
    headOwner: "owner",
    headRepositoryId: "R_head",
  };
  const routeFingerprint = ledger.recordPublicationRoute({ ...publicationRoute, runId });
  ledger.startAttempt({
    actorIdentity: "operator",
    attemptId: `${runId}-attempt`,
    coordinatorIdentity: "coordinator",
    generationToken,
    runId,
    startedAt: "2026-08-30T12:00:00.000Z",
  });
  const attemptId = `${runId}-attempt`;
  const pushEntry = entries.find((entry) => entry.stage === "push")!;
  const pushEvidence = {
    artifactPath: pushEntry.artifactPath,
    artifactSha256: pushEntry.artifactSha256,
    baseCommitOid: base,
    candidateCommitOid: candidate,
    evidenceSha256: pushEntry.evidenceSha256,
    exitCode: 0,
    roundIndex: pushEntry.round,
    runId,
    stageId: "push",
    summary: pushEntry.summary,
    workerIdentity: pushEntry.workerIdentity,
  };
  ledger.recordPublicationBaseline({
    headCommitOid: null,
    observedAt: "2026-08-30T12:00:00.000Z",
    routeFingerprint,
    runId,
    transportUrl: "github.com/owner/repo",
  });
  const preRead = ledger.recordRemoteObservation({
    attemptId,
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
  const publicationIntent = ledger.recordMutationIntent({
    attemptId,
    createdAt: "2026-08-30T12:00:02.000Z",
    kind: "candidate-publication",
    payload: { expected: "absent", update: candidate },
    runId,
    targetFingerprint: routeFingerprint,
  });
  const postRead = ledger.recordRemoteObservation({
    attemptId,
    kind: "publication-head",
    observedAt: "2026-08-30T12:00:04.000Z",
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
  const publicationReceipt = ledger.settleRemoteStage({
    checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 6 },
    evidence: pushEvidence,
    receipt: {
      authoritativePostObservationSha256: postRead,
      candidateCommitOid: candidate,
      kind: "candidate-publication",
      payload: {
        mutationIntent: publicationIntent,
        outcome: "created",
        postRead,
        preRead,
        routeFingerprint,
      },
    },
    ownership: { branch: "feature", generationToken, repoRoot: "/repo" },
    runId,
    stageId: "push",
  }).receiptSha256;
  const pullRequestIntent = ledger.recordMutationIntent({
    attemptId,
    createdAt: "2026-08-30T12:00:05.000Z",
    kind: "pull-request",
    payload: {
      action: "ensure-open",
      baseBranch: "main",
      baseRepositoryId: "R_base",
      candidateCommitOid: candidate,
      forgeHost: "github.com",
      headBranch: "feature",
      headOwner: "owner",
      headRepositoryId: "R_head",
    },
    runId,
    targetFingerprint: routeFingerprint,
  });
  const pullRequestObservation = ledger.recordRemoteObservation({
    attemptId,
    kind: "pull-request",
    observedAt: "2026-08-30T12:00:06.000Z",
    payload: {
      baseBranch: "main",
      baseRepositoryId: "R_base",
      candidateCommitOid: candidate,
      forgeHost: "github.com",
      headBranch: "feature",
      headOwner: "owner",
      headRepositoryId: "R_head",
      number: 77,
      state: "open",
    },
    runId,
    subject: "github.com/R_base#77",
  });
  const prEntry = entries.find((entry) => entry.stage === "pr")!;
  const pullRequestReceipt = ledger.settleRemoteStage({
    checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 7 },
    evidence: {
      artifactPath: prEntry.artifactPath,
      artifactSha256: prEntry.artifactSha256,
      baseCommitOid: base,
      candidateCommitOid: candidate,
      evidenceSha256: prEntry.evidenceSha256,
      exitCode: 0,
      roundIndex: prEntry.round,
      runId,
      stageId: "pr",
      summary: prEntry.summary,
      workerIdentity: prEntry.workerIdentity,
    },
    receipt: {
      authoritativePostObservationSha256: pullRequestObservation,
      candidateCommitOid: candidate,
      kind: "pull-request-binding",
      payload: {
        mutationIntent: pullRequestIntent,
        number: 77,
        outcome: "created",
        postRead: pullRequestObservation,
        routeFingerprint,
      },
    },
    ownership: { branch: "feature", generationToken, repoRoot: "/repo" },
    runId,
    stageId: "pr",
  }).receiptSha256;
  const custody = { recoveryRef: `refs/no-mistakes/recover/${runId}` };
  const outcome = ledger.recordAttemptOutcome({
    actorIdentity: "operator",
    attemptId,
    candidateCommitOid: candidate,
    completedAt: "2026-08-30T12:00:07.000Z",
    coordinatorIdentity: "coordinator",
    custody,
    reason: "pipeline completed",
    receiptDigests: [publicationReceipt, pullRequestReceipt],
    resumeEligible: false,
    runId,
    stoppingFact: "pull-request-bound",
    verdict: "passed",
  });
  ledger.finishRun(runId, "passed", candidate);
  const stageEvidence = entries.map(({ artifactPath: _artifactPath, ...entry }) => entry);
  const manifest = buildPipelineCompletionAttestation(stageEvidence, {
    attemptOutcomeDigests: [outcome],
    baseCommitOid: base,
    candidateCommitOid: candidate,
    candidatePublicationReceiptSha256: publicationReceipt,
    custody,
    intent,
    policySha256: policy,
    publicationRoute: { ...publicationRoute, routeFingerprint },
    pullRequestBindingReceiptSha256: pullRequestReceipt,
    runId,
    stageDispositions: stageEvidence.map((entry) => ({
      disposition: "satisfied",
      evidenceSha256: entry.evidenceSha256,
      stage: entry.stage,
    })),
    stagePlan: stages.map((stage) => ({ requirement: "required", stage })),
  });
  return { ledger, manifest, pullRequestObservation, pullRequestIntent, routeFingerprint, temp };
}

test("isAuthoritativeStageEvidence filters non-authoritative coordinator diagnostics", () => {
  assert.equal(isAuthoritativeStageEvidence("coordinator:fixer-no-change"), false);
  assert.equal(isAuthoritativeStageEvidence("coordinator:fixer-policy"), false);
  assert.equal(isAuthoritativeStageEvidence("coordinator:fixer-guardrail-advisory"), false);
  assert.equal(isAuthoritativeStageEvidence("worker:review:1"), true);
  assert.equal(isAuthoritativeStageEvidence("operator"), true);
});

test("recordAttestation binds pull-request receipt pipelineEvidenceRoot to manifest root", async () => {
  // 1. Legacy receipt without pipelineEvidenceRoot and managedCommentIntent is accepted
  const legacyFixture = await createCompletionFixture();
  try {
    assert.doesNotThrow(() => legacyFixture.ledger.recordAttestation(legacyFixture.manifest));
  } finally {
    legacyFixture.ledger.close();
    await rm(legacyFixture.temp, { force: true, recursive: true });
  }

  // 2. Settlement rejects unpaired schema fields (managedCommentIntent without pipelineEvidenceRoot)
  const temp = await mkdtemp(path.join(tmpdir(), "onm-unpaired-"));
  const ledger = new DomainLedger(path.join(temp, "ledger.sqlite"));
  try {
    const runId = "unpaired-test";
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Unpaired test",
      policySha256: policy,
      repoRoot: "/repo",
      runId,
      submissionCommitOid: candidate,
    });
    const generationToken = ledger.acquireLease({ branch: "feature", repoRoot: "/repo", runId });
    ledger.startAttempt({
      actorIdentity: "operator",
      attemptId: "att-1",
      coordinatorIdentity: "coordinator",
      generationToken,
      runId,
      startedAt: "2026-08-30T12:00:00.000Z",
    });

    const routeFingerprint = ledger.recordPublicationRoute({
      baseBranch: "main",
      baseRepositoryId: "R_base",
      forgeHost: "github.com",
      headBranch: "feature",
      headOwner: "owner",
      headRepositoryId: "R_head",
      runId,
    });
    ledger.recordPublicationBaseline({
      headCommitOid: null,
      observedAt: "2026-08-30T12:00:00.000Z",
      routeFingerprint,
      runId,
      transportUrl: "github.com/owner/repo",
    });

    const obs = ledger.recordRemoteObservation({
      attemptId: "att-1",
      kind: "pull-request",
      observedAt: "2026-08-30T12:00:06.000Z",
      payload: {
        baseBranch: "main",
        baseRepositoryId: "R_base",
        candidateCommitOid: candidate,
        forgeHost: "github.com",
        headBranch: "feature",
        headOwner: "owner",
        headRepositoryId: "R_head",
        number: 77,
        state: "open",
      },
      runId,
      subject: "github.com/R_base#77",
    });

    const prIntent = ledger.recordMutationIntent({
      attemptId: "att-1",
      createdAt: "2026-08-30T12:00:05.000Z",
      kind: "pull-request",
      payload: { action: "ensure-open" },
      runId,
      targetFingerprint: routeFingerprint,
    });

    const prEvidenceSha = evidenceSha256({
      artifactSha256: "0".repeat(64),
      baseCommitOid: base,
      candidateCommitOid: candidate,
      exitCode: 0,
      round: 0,
      runId,
      stage: "pr",
      summary: "PR",
      workerIdentity: "worker",
    });

    assert.throws(
      () =>
        ledger.settleRemoteStage({
          checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 0 },
          evidence: {
            artifactPath: "/tmp/pr.json",
            artifactSha256: "0".repeat(64),
            baseCommitOid: base,
            candidateCommitOid: candidate,
            evidenceSha256: prEvidenceSha,
            exitCode: 0,
            roundIndex: 0,
            runId,
            stageId: "pr",
            summary: "PR",
            workerIdentity: "worker",
          },
          ownership: { branch: "feature", generationToken, repoRoot: "/repo" },
          receipt: {
            authoritativePostObservationSha256: obs,
            candidateCommitOid: candidate,
            kind: "pull-request-binding",
            payload: {
              managedCommentIntent: "0".repeat(64), // Present without pipelineEvidenceRoot
              mutationIntent: prIntent,
              number: 77,
              outcome: "created",
              postRead: obs,
              routeFingerprint,
            },
          },
          runId,
          stageId: "pr",
        }),
      /pr receipt does not match its authoritative post-read observation/,
    );
  } finally {
    ledger.close();
    await rm(temp, { force: true, recursive: true });
  }
});
