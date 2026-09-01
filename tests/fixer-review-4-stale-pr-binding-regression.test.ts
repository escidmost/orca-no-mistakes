import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildPipelineCompletionAttestation,
  DomainLedger,
  evidenceSha256,
  sha256,
  type StageEvidenceManifestEntry
} from '../scripts/ledger.ts'

const base = 'a'.repeat(40)
const candidate = 'b'.repeat(40)
const policy = 'c'.repeat(64)

test('retained completion rejects a stale pull request binding receipt', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-stale-pr-binding-'))
  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
  try {
    const runId = 'stale-pr-binding'
    const intent = 'Reject stale pull request custody.'
    const entries: (StageEvidenceManifestEntry & { artifactPath: string })[] = []
    for (const [round, stage] of ['push', 'pr'].entries()) {
      const artifact = Buffer.from(stage)
      const artifactPath = path.join(temp, `${stage}.txt`)
      await writeFile(artifactPath, artifact)
      const entry = {
        artifactPath,
        artifactSha256: sha256(artifact),
        baseCommitOid: base,
        candidateCommitOid: candidate,
        evidenceSha256: '',
        exitCode: 0,
        round,
        stage,
        summary: `${stage} passed`,
        workerIdentity: 'coordinator'
      }
      entry.evidenceSha256 = evidenceSha256({ ...entry, runId })
      entries.push(entry)
    }
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent,
      policySha256: policy,
      repoRoot: '/repo',
      runId,
      stagePlan: [
        { requirement: 'required', stageId: 'push' },
        { requirement: 'required', stageId: 'pr' }
      ],
      submissionCommitOid: candidate
    })
    for (const entry of entries) {
      ledger.recordStageDisposition({
        disposition: 'satisfied',
        evidenceSha256: entry.evidenceSha256,
        runId,
        stageId: entry.stage
      })
    }
    const route = {
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_head'
    }
    const routeFingerprint = ledger.recordPublicationRoute({ ...route, runId })
    ledger.recordPublicationBaseline({
      headCommitOid: null,
      observedAt: '2026-08-30T12:00:00.000Z',
      routeFingerprint,
      runId,
      transportUrl: 'github.com/owner/repo'
    })
    const staleGeneration = ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId })
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'stale-attempt',
      coordinatorIdentity: 'coordinator',
      generationToken: staleGeneration,
      runId,
      startedAt: '2026-08-30T12:00:00.000Z'
    })
    const evidenceFor = (stage: 'pr' | 'push') => {
      const entry = entries.find((candidateEntry) => candidateEntry.stage === stage)!
      return {
        artifactPath: entry.artifactPath,
        artifactSha256: entry.artifactSha256,
        baseCommitOid: base,
        candidateCommitOid: candidate,
        evidenceSha256: entry.evidenceSha256,
        exitCode: 0,
        roundIndex: entry.round,
        runId,
        stageId: stage,
        summary: entry.summary,
        workerIdentity: entry.workerIdentity
      }
    }
    const publicationPreRead = ledger.recordRemoteObservation({
      attemptId: 'stale-attempt',
      kind: 'publication-head',
      observedAt: '2026-08-30T12:00:01.000Z',
      payload: {
        forgeHost: 'github.com',
        headBranch: 'feature',
        headOwner: 'owner',
        repositoryId: 'R_head',
        state: 'absent'
      },
      runId,
      subject: 'github.com/R_head:refs/heads/feature'
    })
    const publicationIntent = ledger.recordMutationIntent({
      attemptId: 'stale-attempt',
      createdAt: '2026-08-30T12:00:02.000Z',
      kind: 'candidate-publication',
      payload: { expected: 'absent', update: candidate },
      runId,
      targetFingerprint: routeFingerprint
    })
    const publicationPostRead = ledger.recordRemoteObservation({
      attemptId: 'stale-attempt',
      kind: 'publication-head',
      observedAt: '2026-08-30T12:00:03.000Z',
      payload: {
        forgeHost: 'github.com',
        headBranch: 'feature',
        headOwner: 'owner',
        oid: candidate,
        repositoryId: 'R_head'
      },
      runId,
      subject: 'github.com/R_head:refs/heads/feature'
    })
    const publicationReceipt = ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 0 },
      evidence: evidenceFor('push'),
      receipt: {
        authoritativePostObservationSha256: publicationPostRead,
        candidateCommitOid: candidate,
        kind: 'candidate-publication',
        payload: {
          mutationIntent: publicationIntent,
          outcome: 'created',
          postRead: publicationPostRead,
          preRead: publicationPreRead,
          routeFingerprint
        }
      },
      runId,
      stageId: 'push',
      ownership: { branch: 'feature', generationToken: staleGeneration, repoRoot: '/repo' }
    }).receiptSha256
    const prFacts = {
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      candidateCommitOid: candidate,
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_head'
    }
    const pullRequestIntent = ledger.recordMutationIntent({
      attemptId: 'stale-attempt',
      createdAt: '2026-08-30T12:00:04.000Z',
      kind: 'pull-request',
      payload: { action: 'ensure-open', ...prFacts },
      runId,
      targetFingerprint: routeFingerprint
    })
    const pullRequestObservation = ledger.recordRemoteObservation({
      attemptId: 'stale-attempt',
      kind: 'pull-request',
      observedAt: '2026-08-30T12:00:05.000Z',
      payload: { ...prFacts, number: 77, state: 'open' },
      runId,
      subject: 'github.com/R_base#77'
    })
    const pullRequestReceipt = ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 1 },
      evidence: evidenceFor('pr'),
      receipt: {
        authoritativePostObservationSha256: pullRequestObservation,
        candidateCommitOid: candidate,
        kind: 'pull-request-binding',
        payload: {
          mutationIntent: pullRequestIntent,
          number: 77,
          outcome: 'created',
          postRead: pullRequestObservation,
          routeFingerprint
        }
      },
      runId,
      stageId: 'pr',
      ownership: { branch: 'feature', generationToken: staleGeneration, repoRoot: '/repo' }
    }).receiptSha256
    const custody = { recoveryRef: `refs/no-mistakes/recover/${runId}` }
    const staleOutcome = ledger.recordAttemptOutcome({
      actorIdentity: 'operator',
      attemptId: 'stale-attempt',
      candidateCommitOid: candidate,
      completedAt: '2026-08-30T12:00:06.000Z',
      coordinatorIdentity: 'coordinator',
      custody,
      reason: 'first attempt interrupted',
      receiptDigests: [publicationReceipt, pullRequestReceipt],
      resumeEligible: true,
      runId,
      stoppingFact: 'retry-required',
      verdict: 'failed'
    })
    ledger.releaseLease(runId)
    const passedGeneration = ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId })
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'passed-attempt',
      coordinatorIdentity: 'coordinator',
      generationToken: passedGeneration,
      runId,
      startedAt: '2026-08-30T12:00:07.000Z'
    })
    const passedOutcome = ledger.recordAttemptOutcome({
      actorIdentity: 'operator',
      attemptId: 'passed-attempt',
      candidateCommitOid: candidate,
      completedAt: '2026-08-30T12:00:08.000Z',
      coordinatorIdentity: 'coordinator',
      custody,
      reason: 'reused retained receipts',
      receiptDigests: [publicationReceipt, pullRequestReceipt],
      resumeEligible: false,
      runId,
      stoppingFact: 'pull-request-bound',
      verdict: 'passed'
    })
    assert.equal(ledger.finishRun(runId, 'passed', candidate), true)
    const stageEvidence = entries.map(({ artifactPath: _artifactPath, ...entry }) => entry)
    const manifest = buildPipelineCompletionAttestation(stageEvidence, {
      attemptOutcomeDigests: [staleOutcome, passedOutcome],
      baseCommitOid: base,
      candidateCommitOid: candidate,
      candidatePublicationReceiptSha256: publicationReceipt,
      custody,
      intent,
      policySha256: policy,
      publicationRoute: { ...route, routeFingerprint },
      pullRequestBindingReceiptSha256: pullRequestReceipt,
      runId,
      stageDispositions: stageEvidence.map((entry) => ({
        disposition: 'satisfied',
        evidenceSha256: entry.evidenceSha256,
        stage: entry.stage
      })),
      stagePlan: [
        { requirement: 'required', stage: 'push' },
        { requirement: 'required', stage: 'pr' }
      ]
    })

    assert.throws(
      () => ledger.recordAttestation(manifest),
      /pull-request-binding observation/
    )
  } finally {
    ledger.close()
    await rm(temp, { recursive: true, force: true })
  }
})
