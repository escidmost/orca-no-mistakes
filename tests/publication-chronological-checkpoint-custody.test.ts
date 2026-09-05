import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DomainLedger,
  finalContiguousCheckpointByStage,
  isCandidateReachable,
  type StageCheckpointRow
} from '../scripts/ledger.ts'
import {
  CandidatePublicationError,
  publishCandidate,
  terminalCandidate
} from '../scripts/publication.ts'

function oid(digit: number): string {
  return String(digit).repeat(40)
}

test('isCandidateReachable respects durable insertion order and cycle traversal', () => {
  const oidA = oid(1)
  const oidB = oid(2)
  const oidC = oid(3)
  const oidD = oid(4)
  const oidE = oid(5)

  // Forward ordered multi-edge chain
  const forwardChain: StageCheckpointRow[] = [
    { input_commit_oid: oidA, output_commit_oid: oidB, round_index: 0, stage_id: 's1' },
    { input_commit_oid: oidB, output_commit_oid: oidC, round_index: 0, stage_id: 's2' },
    { input_commit_oid: oidC, output_commit_oid: oidD, round_index: 0, stage_id: 's3' }
  ]
  assert.equal(isCandidateReachable(oidA, oidD, forwardChain), true)
  assert.equal(isCandidateReachable(oidB, oidD, forwardChain), true)
  assert.equal(isCandidateReachable(oidD, oidA, forwardChain), false)

  // Reverse ordered multi-edge chain: B->C happened at t=0, A->B happened at t=1
  const reverseChain: StageCheckpointRow[] = [
    { input_commit_oid: oidB, output_commit_oid: oidC, round_index: 0, stage_id: 's2' },
    { input_commit_oid: oidA, output_commit_oid: oidB, round_index: 1, stage_id: 's1' }
  ]
  assert.equal(isCandidateReachable(oidA, oidC, reverseChain), false)
  assert.equal(isCandidateReachable(oidA, oidB, reverseChain), true)

  // Forward cycle: A -> B -> A -> C
  const forwardCycle: StageCheckpointRow[] = [
    { input_commit_oid: oidA, output_commit_oid: oidB, round_index: 0, stage_id: 's1' },
    { input_commit_oid: oidB, output_commit_oid: oidA, round_index: 1, stage_id: 's1' },
    { input_commit_oid: oidA, output_commit_oid: oidC, round_index: 2, stage_id: 's2' }
  ]
  assert.equal(isCandidateReachable(oidA, oidC, forwardCycle), true)
  assert.equal(isCandidateReachable(oidB, oidC, forwardCycle), true)

  // Reverse cycle: B->C->B happened at t=0,1 before A->B happened at t=2
  const reverseCycle: StageCheckpointRow[] = [
    { input_commit_oid: oidB, output_commit_oid: oidC, round_index: 0, stage_id: 's2' },
    { input_commit_oid: oidC, output_commit_oid: oidB, round_index: 1, stage_id: 's2' },
    { input_commit_oid: oidA, output_commit_oid: oidB, round_index: 2, stage_id: 's1' },
    { input_commit_oid: oidC, output_commit_oid: oidE, round_index: 3, stage_id: 's3' }
  ]
  // From A, candidate can reach B, but cannot use t=0 edge B->C to reach C or E
  assert.equal(isCandidateReachable(oidA, oidE, reverseCycle), false)
  assert.equal(isCandidateReachable(oidA, oidC, reverseCycle), false)
  assert.equal(isCandidateReachable(oidA, oidB, reverseCycle), true)

  // Identity
  assert.equal(isCandidateReachable(oidA, oidA, []), true)
})

test('finalContiguousCheckpointByStage rejects borrowing future edge (counterexample)', () => {
  const stageIds = ['review', 'document']
  const oidA = oid(1)
  const oidB = oid(2)
  const oidC = oid(3)

  // Chronological checkpoints:
  // 0: review A -> B round 0
  // 1: document A -> C round 0
  // 2: review B -> A round 1
  const checkpoints: StageCheckpointRow[] = [
    { input_commit_oid: oidA, output_commit_oid: oidB, round_index: 0, stage_id: 'review' },
    { input_commit_oid: oidA, output_commit_oid: oidC, round_index: 0, stage_id: 'document' },
    { input_commit_oid: oidB, output_commit_oid: oidA, round_index: 1, stage_id: 'review' }
  ]

  const evidence = [
    { candidateCommitOid: oidB, roundIndex: 0, stage: 'review' },
    { candidateCommitOid: oidC, roundIndex: 0, stage: 'document' }
  ]

  const result = finalContiguousCheckpointByStage(stageIds, checkpoints, oidA, evidence)
  // Review round 0 (A->B) is selected
  assert.equal(result.get('review')?.output_commit_oid, oidB)
  assert.equal(result.get('review')?.round_index, 0)
  // Document A->C cannot borrow later review B->A edge to connect from candidate B
  assert.equal(result.get('document'), undefined)
})

test('finalContiguousCheckpointByStage rejects connecting paths with reverse-order edges', () => {
  const stageIds = ['stage1', 'stage2']
  const oidA = oid(1)
  const oidB = oid(2)
  const oidD = oid(4)
  const oidE = oid(5)
  const oidF = oid(6)

  // Both D and E are reachable from an earlier branch at indices 0 and 1,
  // but D -> E occurred at index 1, BEFORE B -> D occurred at index 3.
  // Stage 1 settles at B (index 2). To connect B to E for stage 2 (index 4),
  // D -> E cannot be borrowed from the already-consumed past (reverse order).
  const reverseCheckpoints: StageCheckpointRow[] = [
    { input_commit_oid: oidA, output_commit_oid: oidD, round_index: 0, stage_id: 'stage1' },
    { input_commit_oid: oidD, output_commit_oid: oidE, round_index: 1, stage_id: 'stage1' },
    { input_commit_oid: oidA, output_commit_oid: oidB, round_index: 0, stage_id: 'stage1' },
    { input_commit_oid: oidB, output_commit_oid: oidD, round_index: 2, stage_id: 'stage1' },
    { input_commit_oid: oidE, output_commit_oid: oidF, round_index: 0, stage_id: 'stage2' }
  ]

  const evidence = [
    { candidateCommitOid: oidB, roundIndex: 0, stage: 'stage1' },
    { candidateCommitOid: oidF, roundIndex: 0, stage: 'stage2' }
  ]

  const result = finalContiguousCheckpointByStage(stageIds, reverseCheckpoints, oidA, evidence)
  assert.equal(result.get('stage1')?.output_commit_oid, oidB)
  // stage2 requires input E, but D->E occurred prior to B->D (reverse relative order)
  assert.equal(result.get('stage2'), undefined)

  // Forward ordered intermediate edges:
  // 1: B -> D
  // 2: D -> E
  const forwardCheckpoints: StageCheckpointRow[] = [
    { input_commit_oid: oidA, output_commit_oid: oidB, round_index: 0, stage_id: 'stage1' },
    { input_commit_oid: oidB, output_commit_oid: oidD, round_index: 1, stage_id: 'stage1' },
    { input_commit_oid: oidD, output_commit_oid: oidE, round_index: 2, stage_id: 'stage1' },
    { input_commit_oid: oidE, output_commit_oid: oidF, round_index: 0, stage_id: 'stage2' }
  ]

  const forwardResult = finalContiguousCheckpointByStage(stageIds, forwardCheckpoints, oidA, evidence)
  assert.equal(forwardResult.get('stage1')?.output_commit_oid, oidB)
  assert.equal(forwardResult.get('stage2')?.output_commit_oid, oidF)
})

test('finalContiguousCheckpointByStage preserves historical edges needed for supersession', () => {
  const stageIds = ['review', 'test', 'document', 'lint']
  const submission = oid(1)
  const headB = oid(2)

  // document round 0 advanced submission to headB; subsequent round 1 revalidated review/test/document on headB
  const checkpoints: StageCheckpointRow[] = [
    { input_commit_oid: submission, output_commit_oid: submission, round_index: 0, stage_id: 'review' },
    { input_commit_oid: submission, output_commit_oid: submission, round_index: 0, stage_id: 'test' },
    { input_commit_oid: submission, output_commit_oid: headB, round_index: 0, stage_id: 'document' },
    { input_commit_oid: headB, output_commit_oid: headB, round_index: 1, stage_id: 'review' },
    { input_commit_oid: headB, output_commit_oid: headB, round_index: 1, stage_id: 'test' },
    { input_commit_oid: headB, output_commit_oid: headB, round_index: 1, stage_id: 'document' },
    { input_commit_oid: headB, output_commit_oid: headB, round_index: 0, stage_id: 'lint' }
  ]

  const evidence = [
    { candidateCommitOid: headB, roundIndex: 1, stage: 'review' },
    { candidateCommitOid: headB, roundIndex: 1, stage: 'test' },
    { candidateCommitOid: headB, roundIndex: 1, stage: 'document' },
    { candidateCommitOid: headB, roundIndex: 0, stage: 'lint' }
  ]

  const result = finalContiguousCheckpointByStage(stageIds, checkpoints, submission, evidence)
  assert.equal(result.get('review')?.output_commit_oid, headB)
  assert.equal(result.get('review')?.round_index, 1)
  assert.equal(result.get('test')?.output_commit_oid, headB)
  assert.equal(result.get('test')?.round_index, 1)
  assert.equal(result.get('document')?.output_commit_oid, headB)
  assert.equal(result.get('document')?.round_index, 1)
  assert.equal(result.get('lint')?.output_commit_oid, headB)
  assert.equal(result.get('lint')?.round_index, 0)
})

test('terminalCandidate rejects candidate when stage borrows future edge', () => {
  const ledger = new DomainLedger(':memory:')
  const runId = 'test-future-edge-rejection'
  const oidA = oid(1)
  const oidB = oid(2)
  const oidC = oid(3)

  try {
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Verify future edge rejection in terminalCandidate.',
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

    // Document was run on A (producing C)
    const evDocSha = 'b'.repeat(64)
    ledger.recordEvidence({
      artifactPath: '/tmp/doc.json',
      artifactSha256: '2'.repeat(64),
      baseCommitOid: oidA,
      candidateCommitOid: oidC,
      evidenceSha256: evDocSha,
      exitCode: 0,
      roundIndex: 0,
      runId,
      stageId: 'document',
      summary: 'document completed',
      workerIdentity: 'coordinator:document'
    })
    ledger.recordCheckpoint({
      inputCommitOid: oidA,
      outputCommitOid: oidC,
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

    // Later review round 1 connects B back to A
    ledger.recordCheckpoint({
      inputCommitOid: oidB,
      outputCommitOid: oidA,
      roundIndex: 1,
      runId,
      stageId: 'review'
    })

    assert.throws(
      () => terminalCandidate(ledger, runId, false),
      /stage document does not extend the contiguous candidate chain/
    )
  } finally {
    ledger.close()
  }
})

test('publishCandidate throws on invalid custody and causes zero publication mutation', async () => {
  const ledger = new DomainLedger(':memory:')
  const runId = 'test-no-publication-mutation'
  const oidA = oid(1)
  const oidB = oid(2)
  const oidC = oid(3)

  let runnerCalled = false
  const fakeRunner = async () => {
    runnerCalled = true
    return { code: 0, stderr: '', stdout: '' }
  }

  try {
    ledger.setRepositoryPublicationRoute({
      actorId: 'actor',
      actorLogin: 'owner',
      actorNodeId: 'node',
      backend: 'gh',
      backendVersion: '1',
      baseBranch: 'main',
      baseRepositoryId: 'repo-1',
      baseRepositoryName: 'owner/repo',
      baseRepositoryNodeId: 'node-1',
      credentialSource: 'GH_TOKEN',
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'repo-1',
      headRepositoryName: 'owner/repo',
      headRepositoryNodeId: 'node-1',
      networkRootRepositoryId: 'repo-1',
      observedAt: '2026-09-05T00:00:00Z',
      repoRoot: '/tmp/repo'
    })

    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Verify zero publication mutation on invalid custody.',
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
    const generationToken = ledger.acquireLease({ branch: 'feature', repoRoot: '/tmp/repo', runId })

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

    const evDocSha = 'b'.repeat(64)
    ledger.recordEvidence({
      artifactPath: '/tmp/doc.json',
      artifactSha256: '2'.repeat(64),
      baseCommitOid: oidA,
      candidateCommitOid: oidC,
      evidenceSha256: evDocSha,
      exitCode: 0,
      roundIndex: 0,
      runId,
      stageId: 'document',
      summary: 'document completed',
      workerIdentity: 'coordinator:document'
    })
    ledger.recordCheckpoint({
      inputCommitOid: oidA,
      outputCommitOid: oidC,
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

    // Later review round 1 connects B back to A
    ledger.recordCheckpoint({
      inputCommitOid: oidB,
      outputCommitOid: oidA,
      roundIndex: 1,
      runId,
      stageId: 'review'
    })

    const route = ledger.publicationRoute(runId)
    assert.ok(route)
    ledger.recordPublicationBaseline({
      headCommitOid: oidA,
      observedAt: '2026-09-05T00:00:00Z',
      routeFingerprint: route.route_fingerprint,
      runId,
      transportUrl: 'github.com/owner/repo'
    })

    await assert.rejects(
      publishCandidate({
        artifactPath: '/tmp/push.json',
        attemptId: 'attempt-1',
        destination: 'https://github.com/owner/repo.git',
        generationToken,
        ledger,
        resolveRepositoryIdentity: async () => ({
          backend: 'gh',
          backendVersion: '1',
          credentialSource: 'GH_TOKEN',
          forgeHost: 'github.com',
          id: 'repo-1',
          owner: 'owner',
          repo: 'repo',
          repositoryId: 'repo-1',
          nodeId: 'node-1'
        }),
        runId,
        runner: fakeRunner,
        workerIdentity: 'publisher'
      }),
      (error: unknown) => error instanceof CandidatePublicationError &&
        /stage document does not extend the contiguous candidate chain/.test(error.message)
    )

    // Prove zero mutation: runner was never invoked, no push remote receipt created
    assert.equal(runnerCalled, false)
    assert.equal(ledger.remoteReceipt(runId, 'candidate-publication'), undefined)
  } finally {
    ledger.close()
  }
})
