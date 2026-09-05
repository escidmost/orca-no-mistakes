import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DomainLedger,
  evidenceSha256,
  finalContiguousCheckpointByStage,
  sha256
} from '../scripts/ledger.ts'
import { CandidatePublicationError, terminalCandidate } from '../scripts/publication.ts'
import { pipelineStepSummary } from '../scripts/pull-request.ts'

function oid(digit: number): string {
  return String(digit).repeat(40)
}

test('finalContiguousCheckpointByStage rejects noncontiguous candidate history across stages', () => {
  const stageIds = ['review', 'document']
  const oidA = oid(1)
  const oidB = oid(2)
  const oidC = oid(3)
  const oidD = oid(4)
  const oidE = oid(5)

  const checkpoints = [
    { created_at: '2026-01-01T00:00:00Z', input_commit_oid: oidA, output_commit_oid: oidB, round_index: 0, run_id: 'run', stage_id: 'review' },
    { created_at: '2026-01-01T00:00:01Z', input_commit_oid: oidB, output_commit_oid: oidC, round_index: 0, run_id: 'run', stage_id: 'document' },
    { created_at: '2026-01-01T00:00:02Z', input_commit_oid: oidC, output_commit_oid: oidD, round_index: 1, run_id: 'run', stage_id: 'review' },
    { created_at: '2026-01-01T00:00:03Z', input_commit_oid: oidB, output_commit_oid: oidE, round_index: 1, run_id: 'run', stage_id: 'document' }
  ]

  const evidence = [
    { candidateCommitOid: oidD, roundIndex: 1, stage: 'review' },
    { candidateCommitOid: oidE, roundIndex: 1, stage: 'document' }
  ]

  const result = finalContiguousCheckpointByStage(stageIds, checkpoints, oidA, evidence)
  assert.equal(result.get('review')?.output_commit_oid, oidD)
  // document B->E cannot be selected because input B does not equal current candidate D
  assert.equal(result.get('document'), undefined)
})

test('terminalCandidate rejects publication when stage input does not match current candidate', () => {
  const ledger = new DomainLedger(':memory:')
  const runId = 'test-noncontiguous-chain'
  const oidA = oid(1)
  const oidB = oid(2)
  const oidC = oid(3)
  const oidD = oid(4)

  try {
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Verify contiguous candidate chain.',
      policySha256: 'f'.repeat(64),
      repoRoot: '/tmp/repo',
      runId,
      stagePlan: [
        { requirement: 'required', stageId: 'review' },
        { requirement: 'required', stageId: 'document' },
        { requirement: 'required', stageId: 'push' }
      ],
      submissionCommitOid: oidA
    })

    const evReviewSha = 'a'.repeat(64)
    ledger.recordEvidence({
      artifactPath: '/tmp/review.json',
      artifactSha256: '1'.repeat(64),
      baseCommitOid: oidA,
      candidateCommitOid: oidB,
      evidenceSha256: evReviewSha,
      exitCode: 0,
      roundIndex: 0,
      runId,
      stageId: 'review',
      summary: 'review completed',
      workerIdentity: 'reviewer:test'
    })
    ledger.recordCheckpoint({
      inputCommitOid: oidA,
      outputCommitOid: oidB,
      roundIndex: 0,
      runId,
      stageId: 'review'
    })
    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: evReviewSha,
      runId,
      stageId: 'review'
    })

    // Document stage checkpoint starts at oidC instead of oidB
    const evDocSha = 'b'.repeat(64)
    ledger.recordEvidence({
      artifactPath: '/tmp/doc.json',
      artifactSha256: '2'.repeat(64),
      baseCommitOid: oidC,
      candidateCommitOid: oidD,
      evidenceSha256: evDocSha,
      exitCode: 0,
      roundIndex: 0,
      runId,
      stageId: 'document',
      summary: 'document completed',
      workerIdentity: 'coordinator:document'
    })
    ledger.recordCheckpoint({
      inputCommitOid: oidC,
      outputCommitOid: oidD,
      roundIndex: 0,
      runId,
      stageId: 'document'
    })
    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: evDocSha,
      runId,
      stageId: 'document'
    })

    assert.throws(
      () => terminalCandidate(ledger, runId, false),
      /stage document does not extend the contiguous candidate chain/
    )
  } finally {
    ledger.close()
  }
})

test('settleRemoteStage requires explicit matching supersedesEvidenceSha256 for historical PR upgrade', () => {
  const ledger = new DomainLedger(':memory:')
  const runId = 'test-pr-supersede-token-required'
  const candidate = oid(10)
  try {
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Upgrade managed comment PR to merged body.',
      policySha256: 'f'.repeat(64),
      repoRoot: '/repo',
      runId,
      stagePlan: [
        { requirement: 'required', stageId: 'push' },
        { requirement: 'required', stageId: 'pr' }
      ],
      submissionCommitOid: candidate
    })
    ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId })
    ledger.startAttempt({
      actorIdentity: 'coordinator',
      attemptId: 'att-1',
      coordinatorIdentity: 'coordinator',
      generationToken: 1,
      runId,
      startedAt: new Date().toISOString()
    })
    const route = {
      actorId: 'actor1',
      actorLogin: 'owner',
      actorNodeId: 'U_actor',
      backend: 'gh' as const,
      backendVersion: '2.0.0',
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      baseRepositoryName: 'owner/repo',
      baseRepositoryNodeId: 'R_base',
      credentialSource: 'GH_TOKEN' as const,
      forgeHost: 'github.com' as const,
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_head',
      headRepositoryName: 'owner/repo',
      headRepositoryNodeId: 'R_head',
      networkRootRepositoryId: 'R_base',
      observedAt: new Date().toISOString(),
      repoRoot: '/repo'
    }
    const routeFingerprint = ledger.setRepositoryPublicationRoute(route)
    ledger.recordStoredPublicationRoute(runId, '/repo')

    const makeEvidence = (stageId: 'push' | 'pr', roundIndex: number, summary: string) => {
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
        workerIdentity: `coordinator:${stageId}`
      }
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
          workerIdentity: e.workerIdentity
        })
      }
    }

    ledger.recordPublicationBaseline({
      headCommitOid: null,
      observedAt: '2026-08-30T12:00:01.000Z',
      routeFingerprint,
      runId,
      transportUrl: 'github.com/owner/repo'
    })

    const preRead = ledger.recordRemoteObservation({
      attemptId: 'att-1',
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

    const pubIntent = ledger.recordMutationIntent({
      attemptId: 'att-1',
      createdAt: '2026-08-30T12:00:02.000Z',
      kind: 'candidate-publication',
      payload: { expected: 'absent', update: candidate },
      runId,
      targetFingerprint: routeFingerprint
    })

    const pushObservation = ledger.recordRemoteObservation({
      attemptId: 'att-1',
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

    const pushEvidence = makeEvidence('push', 0, 'pushed candidate')
    ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 0 },
      evidence: pushEvidence,
      ownership: { branch: 'feature', generationToken: 1, repoRoot: '/repo' },
      receipt: {
        authoritativePostObservationSha256: pushObservation,
        candidateCommitOid: candidate,
        kind: 'candidate-publication',
        payload: {
          mutationIntent: pubIntent,
          outcome: 'created',
          postRead: pushObservation,
          preRead,
          routeFingerprint
        }
      },
      runId,
      stageId: 'push'
    })

    const prFacts = {
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      candidateCommitOid: candidate,
      forgeHost: 'github.com' as const,
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_head'
    }
    const pr1Intent = ledger.recordMutationIntent({
      attemptId: 'att-1',
      createdAt: '2026-08-30T12:00:04.000Z',
      kind: 'pull-request',
      payload: { action: 'ensure-open', ...prFacts },
      runId,
      targetFingerprint: routeFingerprint
    })
    const managedCommentBodySha256 = sha256('managed summary')
    const managedCommentIntent = ledger.recordMutationIntent({
      attemptId: 'att-1',
      createdAt: '2026-08-30T12:00:04.500Z',
      kind: 'managed-comment',
      payload: {
        action: 'ensure-managed-summary',
        bodySha256: managedCommentBodySha256,
        managedCommentNodeId: 'IC_comment',
        number: 42
      },
      runId,
      targetFingerprint: routeFingerprint
    })
    const pr1Observation = ledger.recordRemoteObservation({
      attemptId: 'att-1',
      kind: 'pull-request',
      observedAt: '2026-08-30T12:00:05.000Z',
      payload: {
        ...prFacts,
        managedCommentBodySha256,
        managedCommentNodeId: 'IC_comment',
        number: 42,
        pullRequestNodeId: 'PR_42',
        state: 'open'
      },
      runId,
      subject: 'github.com/R_base#42'
    })
    const pr1Evidence = makeEvidence('pr', 0, 'open pr bound')
    ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 0 },
      evidence: pr1Evidence,
      ownership: { branch: 'feature', generationToken: 1, repoRoot: '/repo' },
      receipt: {
        authoritativePostObservationSha256: pr1Observation,
        candidateCommitOid: candidate,
        kind: 'pull-request-binding',
        payload: {
          managedCommentIntent,
          mutationIntent: pr1Intent,
          number: 42,
          outcome: 'created',
          pipelineEvidenceRoot: sha256('pipeline'),
          postRead: pr1Observation,
          routeFingerprint
        }
      },
      runId,
      stageId: 'pr'
    })

    // Upgrade with merged body without specifying supersedesEvidenceSha256 must be rejected
    const bodySha = sha256('merged body')
    const titleSha = sha256('merged title')
    const pr2Intent = ledger.recordMutationIntent({
      attemptId: 'att-1',
      createdAt: '2026-08-30T12:00:06.000Z',
      kind: 'pull-request',
      payload: {
        action: 'ensure-body-and-await-merge',
        body: 'merged body',
        title: 'merged title',
        ...prFacts
      },
      runId,
      targetFingerprint: routeFingerprint
    })
    const pr2Observation = ledger.recordRemoteObservation({
      attemptId: 'att-1',
      kind: 'pull-request',
      observedAt: '2026-08-30T12:00:07.000Z',
      payload: {
        ...prFacts,
        bodySha256: bodySha,
        number: 42,
        pullRequestNodeId: 'PR_node_1',
        state: 'merged',
        titleSha256: titleSha
      },
      runId,
      subject: 'github.com/R_base#42'
    })
    const pr2Evidence = makeEvidence('pr', 1, 'merged body bound')

    assert.throws(
      () =>
        ledger.settleRemoteStage({
          checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 1 },
          evidence: pr2Evidence,
          ownership: { branch: 'feature', generationToken: 1, repoRoot: '/repo' },
          receipt: {
            authoritativePostObservationSha256: pr2Observation,
            candidateCommitOid: candidate,
            kind: 'pull-request-binding',
            payload: {
              bodySha256: bodySha,
              mutationIntent: pr2Intent,
              number: 42,
              outcome: 'created',
              pipelineEvidenceRoot: sha256('pipeline'),
              postRead: pr2Observation,
              routeFingerprint,
              state: 'merged',
              titleSha256: titleSha
            }
          },
          runId,
          stageId: 'pr'
          // supersedesEvidenceSha256 is omitted!
        }),
      /already settled with a different disposition/
    )

    // With explicit matching supersedesEvidenceSha256, it succeeds
    const upgradedReceipt = ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 1 },
      evidence: pr2Evidence,
      ownership: { branch: 'feature', generationToken: 1, repoRoot: '/repo' },
      receipt: {
        authoritativePostObservationSha256: pr2Observation,
        candidateCommitOid: candidate,
        kind: 'pull-request-binding',
        payload: {
          bodySha256: bodySha,
          mutationIntent: pr2Intent,
          number: 42,
          outcome: 'created',
          pipelineEvidenceRoot: sha256('pipeline'),
          postRead: pr2Observation,
          routeFingerprint,
          state: 'merged',
          titleSha256: titleSha
        }
      },
      runId,
      stageId: 'pr',
      supersedesEvidenceSha256: pr1Evidence.evidenceSha256
    })
    assert.ok(upgradedReceipt.receiptSha256)
  } finally {
    ledger.close()
  }
})

test('pipelineStepSummary formats approved stage with fixed and approved counts', () => {
  // 1 fixed, 1 approved -> formatted using completed-status outcome formatting
  const summary1 = pipelineStepSummary({
    name: 'review',
    status: 'approved',
    fixedFindings: 1,
    approvedFindings: 1
  })
  assert.equal(summary1, '🔧 **Review** - 2 issues found → 1 auto-fixed · 1 approved ✅')

  // 2 fixed, 0 approved -> formatted using completed-status outcome formatting
  const summary2 = pipelineStepSummary({
    name: 'review',
    status: 'approved',
    fixedFindings: 2,
    approvedFindings: 0
  })
  assert.equal(summary2, '🔧 **Review** - 2 issues found → 2 auto-fixed ✅')

  // 0 fixed, 1 approved -> standard approved formatting
  const summary3 = pipelineStepSummary({
    name: 'review',
    status: 'approved',
    fixedFindings: 0,
    approvedFindings: 1
  })
  assert.equal(summary3, '⚠️ **Review** - 1 issue approved')

  // 0 fixed, 0 approved -> standard approved formatting
  const summary4 = pipelineStepSummary({
    name: 'review',
    status: 'approved'
  })
  assert.equal(summary4, '⚠️ **Review** - approved')
})
