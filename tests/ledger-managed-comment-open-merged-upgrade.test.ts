import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildPipelineEvidenceRoot,
  DomainLedger,
  evidenceSha256,
  sha256,
  type StageEvidenceManifestEntry
} from '../scripts/ledger.ts'

const base = 'a'.repeat(40)
const candidate = 'b'.repeat(40)
const policy = 'c'.repeat(64)

test('historical managed-comment binding upgrades to open and then merged', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-pr-open-upgrade-'))
  const dbPath = path.join(temp, 'ledger.sqlite')
  const ledger = new DomainLedger(dbPath)
  try {
    const runId = 'pr-binding-resume'
    const intent = 'Refresh pull request custody after resume.'
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
    const firstGeneration = ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId })
    const evidenceFor = (stage: 'pr' | 'push', round?: number) => {
      const entry = entries.find((candidateEntry) =>
        candidateEntry.stage === stage && (round === undefined || candidateEntry.round === round)
      )!
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
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'first-attempt',
      coordinatorIdentity: 'coordinator',
      generationToken: firstGeneration,
      runId,
      startedAt: '2026-08-30T12:00:00.000Z'
    })
    const publicationPreRead = ledger.recordRemoteObservation({
      attemptId: 'first-attempt',
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
      attemptId: 'first-attempt',
      createdAt: '2026-08-30T12:00:02.000Z',
      kind: 'candidate-publication',
      payload: { expected: 'absent', update: candidate },
      runId,
      targetFingerprint: routeFingerprint
    })
    const publicationPostRead = ledger.recordRemoteObservation({
      attemptId: 'first-attempt',
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
      ownership: { branch: 'feature', generationToken: firstGeneration, repoRoot: '/repo' },
      runId,
      stageId: 'push'
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
    const firstPrIntent = ledger.recordMutationIntent({
      attemptId: 'first-attempt',
      createdAt: '2026-08-30T12:00:04.000Z',
      kind: 'pull-request',
      payload: { action: 'ensure-open', ...prFacts },
      runId,
      targetFingerprint: routeFingerprint
    })
    const firstPrObservation = ledger.recordRemoteObservation({
      attemptId: 'first-attempt',
      kind: 'pull-request',
      observedAt: '2026-08-30T12:00:05.000Z',
      payload: { ...prFacts, number: 77, state: 'open' },
      runId,
      subject: 'github.com/R_base#77'
    })
    const firstPrReceipt = ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 1 },
      evidence: evidenceFor('pr'),
      receipt: {
        authoritativePostObservationSha256: firstPrObservation,
        candidateCommitOid: candidate,
        kind: 'pull-request-binding',
        payload: {
          mutationIntent: firstPrIntent,
          number: 77,
          outcome: 'created',
          postRead: firstPrObservation,
          routeFingerprint
        }
      },
      runId,
      stageId: 'pr',
      ownership: { branch: 'feature', generationToken: firstGeneration, repoRoot: '/repo' }
    }).receiptSha256
    const custody = { recoveryRef: `refs/no-mistakes/recover/${runId}` }
    const failedOutcome = ledger.recordAttemptOutcome({
      actorIdentity: 'operator',
      attemptId: 'first-attempt',
      candidateCommitOid: candidate,
      completedAt: '2026-08-30T12:00:06.000Z',
      coordinatorIdentity: 'coordinator',
      custody,
      reason: 'interrupted after remote settlement',
      receiptDigests: [publicationReceipt, firstPrReceipt],
      resumeEligible: true,
      runId,
      stoppingFact: 'retry-required',
      verdict: 'failed'
    })
    ledger.releaseLease(runId)
    assert.doesNotMatch(ledger.tableDefinition('remote_receipts')!, /UNIQUE \(run_id, kind\)/)
    const passedGeneration = ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId })
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'passed-attempt',
      coordinatorIdentity: 'coordinator',
      generationToken: passedGeneration,
      runId,
      startedAt: '2026-08-30T12:00:07.000Z'
    })
    const originalPrEntry = entries.find((entry) => entry.stage === 'pr')!
    const refreshedPrEntry = {
      ...originalPrEntry,
      evidenceSha256: '',
      round: 2,
      summary: 'pr binding refreshed'
    }
    refreshedPrEntry.evidenceSha256 = evidenceSha256({ ...refreshedPrEntry, runId })
    entries.push(refreshedPrEntry)
    const refreshedPrIntent = ledger.recordMutationIntent({
      attemptId: 'passed-attempt',
      createdAt: '2026-08-30T12:00:08.000Z',
      kind: 'pull-request',
      payload: { action: 'ensure-open', ...prFacts },
      runId,
      targetFingerprint: routeFingerprint
    })
    const managedCommentBodySha256 = sha256('managed summary')
    const managedCommentIntent = ledger.recordMutationIntent({
      attemptId: 'passed-attempt',
      createdAt: '2026-08-30T12:00:08.500Z',
      kind: 'managed-comment',
      payload: {
        action: 'ensure-managed-summary',
        bodySha256: managedCommentBodySha256,
        managedCommentNodeId: 'IC_comment',
        number: 77
      },
      runId,
      targetFingerprint: routeFingerprint
    })
    const pipelineEvidenceRoot = buildPipelineEvidenceRoot(
      entries.map(({ artifactPath: _artifactPath, ...entry }) => entry), {
      attemptOutcomeDigests: [failedOutcome],
      baseCommitOid: base,
      candidateCommitOid: candidate,
      candidatePublicationReceiptSha256: publicationReceipt,
      intent,
      policySha256: policy,
      publicationRoute: { ...route, routeFingerprint },
      runId,
      stageDispositions: [{
        disposition: 'satisfied',
        evidenceSha256: entries.find((entry) => entry.stage === 'push')!.evidenceSha256,
        stage: 'push'
      }],
      stagePlan: [
        { requirement: 'required', stage: 'push' },
        { requirement: 'required', stage: 'pr' }
      ]
    })
    const refreshedPrObservation = ledger.recordRemoteObservation({
      attemptId: 'passed-attempt',
      kind: 'pull-request',
      observedAt: '2026-08-30T12:00:09.000Z',
      payload: {
        ...prFacts,
        managedCommentBodySha256,
        managedCommentNodeId: 'IC_comment',
        number: 77,
        pullRequestNodeId: 'PR_77',
        state: 'open'
      },
      runId,
      subject: 'github.com/R_base#77'
    })
    const refreshedPrReceipt = ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 2 },
      evidence: evidenceFor('pr', 2),
      receipt: {
        authoritativePostObservationSha256: refreshedPrObservation,
        candidateCommitOid: candidate,
        kind: 'pull-request-binding',
        payload: {
          managedCommentIntent,
          mutationIntent: refreshedPrIntent,
          number: 77,
          outcome: 'unchanged',
          pipelineEvidenceRoot,
          postRead: refreshedPrObservation,
          routeFingerprint
        }
      },
      runId,
      stageId: 'pr',
      ownership: { branch: 'feature', generationToken: passedGeneration, repoRoot: '/repo' }
    }).receiptSha256
    assert.notEqual(refreshedPrReceipt, firstPrReceipt)
    const dispositionEvidence = () => ledger.stageDispositions(runId).find((row) => row.stage_id === 'pr')!.evidence_sha256
    assert.equal(dispositionEvidence(), refreshedPrEntry.evidenceSha256)

    const settle = (round: number, state: 'open' | 'merged', supersedes: string) => {
      const entry = { ...originalPrEntry, evidenceSha256: '', round, summary: `pr ${state}` }
      entry.evidenceSha256 = evidenceSha256({ ...entry, runId })
      entries.push(entry)
      const intent = ledger.recordMutationIntent({
        attemptId: 'passed-attempt',
        createdAt: `2026-08-30T12:00:${10 + round}.000Z`,
        kind: 'pull-request',
        payload: { action: 'ensure-body-and-await-merge', ...prFacts, body: 'body', title: 'title' },
        runId,
        targetFingerprint: routeFingerprint
      })
      const observation = ledger.recordRemoteObservation({
        attemptId: 'passed-attempt',
        kind: 'pull-request',
        observedAt: `2026-08-30T12:00:${11 + round}.000Z`,
        payload: { ...prFacts, bodySha256: sha256('body'), number: 77, pullRequestNodeId: 'PR_77', state, titleSha256: sha256('title') },
        runId,
        subject: 'github.com/R_base#77'
      })
      return ledger.settleRemoteStage({
        checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: round },
        evidence: evidenceFor('pr', round),
        receipt: {
          authoritativePostObservationSha256: observation,
          candidateCommitOid: candidate,
          kind: 'pull-request-binding',
          payload: {
            bodySha256: sha256('body'),
            mutationIntent: intent,
            number: 77,
            outcome: 'unchanged',
            pipelineEvidenceRoot,
            postRead: observation,
            routeFingerprint,
            state,
            titleSha256: sha256('title')
          }
        },
        runId,
        stageId: 'pr',
        ownership: { branch: 'feature', generationToken: passedGeneration, repoRoot: '/repo' },
        supersedesEvidenceSha256: supersedes
      }).receiptSha256
    }
    const openReceipt = settle(3, 'open', dispositionEvidence()!)
    assert.equal(dispositionEvidence(), entries.find((entry) => entry.round === 3)!.evidenceSha256)
    const parsedOpen = JSON.parse(ledger.remoteReceipt(runId, 'pull-request-binding')!.receipt_json)
    assert.equal(parsedOpen.state, 'open')
    const mergedReceipt = settle(4, 'merged', dispositionEvidence()!)
    assert.notEqual(mergedReceipt, openReceipt)
    assert.equal(dispositionEvidence(), entries.find((entry) => entry.round === 4)!.evidenceSha256)
    assert.equal(JSON.parse(ledger.remoteReceipt(runId, 'pull-request-binding')!.receipt_json).state, 'merged')
    assert.equal(ledger.remoteReceipt(runId, 'pull-request-binding', refreshedPrReceipt)?.receipt_sha256, refreshedPrReceipt)
    assert.equal(ledger.remoteReceipt(runId, 'pull-request-binding', openReceipt)?.receipt_sha256, openReceipt)
    assert.deepEqual(ledger.listEvidence(runId).filter((row) => row.stage_id === 'pr').map((row) => row.round_index), [1, 2, 3, 4])
  } finally {
    ledger.close()
    await rm(temp, { recursive: true, force: true })
  }
})
