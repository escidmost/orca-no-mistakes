import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DomainLedger, evidenceSha256, sha256 } from '../scripts/ledger.ts'
import { bindPullRequest, settleMergedPullRequest } from '../scripts/pull-request.ts'

const OID = 'a'.repeat(40)
const REPO_ROOT = '/repo'
const STAGES = ['intent', 'rebase', 'review', 'test', 'document', 'lint', 'push', 'pr']

function localStageEvidence(stage: string, round: number, artifactPath: string) {
  const entry = {
    artifactSha256: sha256('{}'),
    baseCommitOid: OID,
    candidateCommitOid: OID,
    evidenceSha256: '',
    exitCode: 0,
    round,
    stage,
    summary: `${stage} satisfied.`,
    workerIdentity: 'coordinator'
  }
  entry.evidenceSha256 = evidenceSha256({ ...entry, runId: 'run' })
  return { ...entry, artifactPath }
}

function receiptState(receiptJson: string | undefined): unknown {
  const parsed = JSON.parse(receiptJson ?? '{}') as { payload?: { state?: unknown }; state?: unknown }
  return (parsed.payload ?? parsed).state
}

function observedPullRequest(body = 'human body', title = 'human title', state: 'MERGED' | 'OPEN' = 'OPEN') {
  return {
    baseBranch: 'main',
    baseOid: 'b'.repeat(40),
    baseRepositoryId: '1',
    baseRepositoryNodeId: 'R_base',
    body,
    draft: false,
    headBranch: 'feature',
    headOid: OID,
    headRepositoryId: '2',
    headRepositoryNodeId: 'R_head',
    id: 'PR_node',
    number: 7,
    state,
    title,
    url: 'https://github.com/acme/repo/pull/7'
  }
}

test('bindPullRequest settles open through a real DomainLedger and settleMergedPullRequest upgrades it', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'onm-pr-ledger-'))
  const ledger = new DomainLedger(':memory:')
  const route = {
    baseBranch: 'main',
    baseRepositoryId: '1',
    forgeHost: 'github.com',
    headBranch: 'feature',
    headOwner: 'forker',
    headRepositoryId: '2'
  }
  try {
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'ONM-80: bind exact GitHub pull requests',
      policySha256: 'b'.repeat(64),
      repoRoot: REPO_ROOT,
      runId: 'run',
      stagePlan: STAGES.map((stageId) => ({ requirement: 'required' as const, stageId })),
      submissionCommitOid: OID
    })
    const fingerprint = ledger.setRepositoryPublicationRoute({
      actorId: 'actor',
      actorLogin: 'bot',
      actorNodeId: 'A_node',
      backend: 'gh',
      backendVersion: 'test',
      baseBranch: route.baseBranch,
      baseRepositoryId: route.baseRepositoryId,
      baseRepositoryName: 'acme/repo',
      baseRepositoryNodeId: 'R_base',
      credentialSource: 'GITHUB_TOKEN',
      forgeHost: 'github.com',
      headBranch: route.headBranch,
      headOwner: route.headOwner,
      headRepositoryId: route.headRepositoryId,
      headRepositoryName: 'forker/repo',
      headRepositoryNodeId: 'R_head',
      networkRootRepositoryId: '1',
      observedAt: '2026-09-01T00:00:00.000Z',
      repoRoot: REPO_ROOT
    })
    for (const [index, stage] of STAGES.slice(0, 6).entries()) {
      const artifactPath = path.join(home, `${stage}.json`)
      await writeFile(artifactPath, '{}')
      const entry = localStageEvidence(stage, index, artifactPath)
      ledger.recordStageDisposition({
        disposition: 'satisfied',
        evidenceSha256: entry.evidenceSha256,
        runId: 'run',
        stageId: stage
      })
      ledger.recordEvidence({
        artifactPath,
        artifactSha256: entry.artifactSha256,
        baseCommitOid: entry.baseCommitOid,
        candidateCommitOid: entry.candidateCommitOid,
        evidenceSha256: entry.evidenceSha256,
        exitCode: entry.exitCode,
        roundIndex: entry.round,
        runId: 'run',
        stageId: stage,
        summary: entry.summary,
        workerIdentity: entry.workerIdentity
      })
    }
    const generation = ledger.acquireLease({ branch: 'feature', repoRoot: REPO_ROOT, runId: 'run' })
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'attempt',
      coordinatorIdentity: 'coordinator',
      generationToken: generation,
      runId: 'run',
      startedAt: '2026-09-01T00:00:01.000Z'
    })
    const routeFingerprint = ledger.recordPublicationRoute({ ...route, runId: 'run' })
    assert.equal(routeFingerprint, fingerprint)
    ledger.recordPublicationBaseline({
      headCommitOid: null,
      observedAt: '2026-09-01T00:00:02.000Z',
      routeFingerprint,
      runId: 'run',
      transportUrl: 'github.com/forker/repo'
    })
    const subject = 'github.com/2:refs/heads/feature'
    const preRead = ledger.recordRemoteObservation({
      attemptId: 'attempt',
      kind: 'publication-head',
      observedAt: '2026-09-01T00:00:02.500Z',
      payload: {
        forgeHost: 'github.com',
        headBranch: 'feature',
        headOwner: 'forker',
        repositoryId: '2',
        state: 'absent'
      },
      runId: 'run',
      subject
    })
    const publicationIntent = ledger.recordMutationIntent({
      attemptId: 'attempt',
      createdAt: '2026-09-01T00:00:03.000Z',
      kind: 'candidate-publication',
      payload: { expected: 'absent', update: OID },
      runId: 'run',
      targetFingerprint: routeFingerprint
    })
    const pushArtifact = path.join(home, 'push.json')
    await writeFile(pushArtifact, '{}')
    const pushEvidence = localStageEvidence('push', 6, pushArtifact)
    const pushObservation = ledger.recordRemoteObservation({
      attemptId: 'attempt',
      kind: 'publication-head',
      observedAt: '2026-09-01T00:00:04.000Z',
      payload: {
        forgeHost: 'github.com',
        headBranch: 'feature',
        headOwner: 'forker',
        oid: OID,
        repositoryId: '2'
      },
      runId: 'run',
      subject
    })
    ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: OID, outputCommitOid: OID, roundIndex: 6 },
      evidence: {
        artifactPath: pushArtifact,
        artifactSha256: pushEvidence.artifactSha256,
        baseCommitOid: OID,
        candidateCommitOid: OID,
        evidenceSha256: pushEvidence.evidenceSha256,
        exitCode: 0,
        roundIndex: 6,
        runId: 'run',
        stageId: 'push',
        summary: pushEvidence.summary,
        workerIdentity: pushEvidence.workerIdentity
      },
      receipt: {
        authoritativePostObservationSha256: pushObservation,
        candidateCommitOid: OID,
        kind: 'candidate-publication',
        payload: {
          mutationIntent: publicationIntent,
          outcome: 'created',
          postRead: pushObservation,
          preRead,
          routeFingerprint
        }
      },
      runId: 'run',
      stageId: 'push',
      ownership: { branch: 'feature', generationToken: generation, repoRoot: REPO_ROOT }
    })

    let pullRequest: ReturnType<typeof observedPullRequest> | null = null
    let tick = 0
    const now = () => `2026-09-01T00:00:${String(10 + tick++).padStart(2, '0')}.000Z`
    let createdTitle: string | undefined
    const content = { body: 'complete body', title: 'ONM-80: bind exact GitHub pull requests' }
    const authority = {
      createPullRequest: async (input: { body: string; title: string }) => {
        createdTitle = input.title
        pullRequest = observedPullRequest(input.body, input.title)
      },
      observePullRequests: async () => ({ exact: pullRequest, nearMatches: [] }),
      updatePullRequest: async () => assert.fail('unexpected PR update')
    }
    const result = await bindPullRequest({
      artifactPath: path.join(home, 'pr.json'),
      attemptId: 'attempt',
      authority,
      candidateCommitOid: OID,
      content,
      generationToken: generation,
      ledger,
      now,
      pipelineEvidenceRoot: 'c'.repeat(64),
      runId: 'run',
      workerIdentity: 'coordinator'
    })

    assert.equal(result.outcome, 'created')
    assert.equal(result.number, 7)
    assert.equal(createdTitle, 'ONM-80: bind exact GitHub pull requests')
    const openReceipt = ledger.remoteReceipt('run', 'pull-request-binding')
    assert.equal(openReceipt?.candidate_commit_oid, OID)
    assert.equal(openReceipt?.receipt_sha256, result.receiptSha256)
    assert.equal(receiptState(openReceipt?.receipt_json), 'open')
    const openDisposition = ledger.stageDispositions('run').find((entry) => entry.stage_id === 'pr')
    assert.equal(openDisposition?.disposition, 'satisfied')

    const mergeInput = {
      artifactPath: path.join(home, 'pr-merged.json'),
      attemptId: 'attempt',
      authority,
      candidateCommitOid: OID,
      generationToken: generation,
      ledger,
      now,
      runId: 'run',
      workerIdentity: 'coordinator'
    }
    await assert.rejects(settleMergedPullRequest(mergeInput), /is not merged/)
    pullRequest = observedPullRequest(content.body, 'human-edited title')
    await assert.rejects(settleMergedPullRequest(mergeInput), /facts changed before merge/)
    pullRequest = observedPullRequest('human-edited body', content.title, 'MERGED')
    await assert.rejects(settleMergedPullRequest(mergeInput), /facts changed before merge/)
    assert.equal(ledger.remoteReceipt('run', 'pull-request-binding')?.receipt_sha256, result.receiptSha256)

    pullRequest = observedPullRequest(content.body, content.title, 'MERGED')
    const merged = await settleMergedPullRequest(mergeInput)
    assert.equal(merged.number, 7)
    assert.notEqual(merged.receiptSha256, result.receiptSha256)
    const mergedReceipt = ledger.remoteReceipt('run', 'pull-request-binding')
    assert.equal(mergedReceipt?.receipt_sha256, merged.receiptSha256)
    assert.equal(receiptState(mergedReceipt?.receipt_json), 'merged')
    const mergedDisposition = ledger.stageDispositions('run').find((entry) => entry.stage_id === 'pr')
    assert.equal(mergedDisposition?.disposition, 'satisfied')
    assert.notEqual(mergedDisposition?.evidence_sha256, openDisposition?.evidence_sha256)
    assert.deepEqual(
      ledger.listEvidence('run').filter((row) => row.stage_id === 'pr').map((row) => row.round_index),
      [0, 1]
    )

    const again = await settleMergedPullRequest(mergeInput)
    assert.equal(again.receiptSha256, merged.receiptSha256)
  } finally {
    ledger.close()
    await rm(home, { force: true, recursive: true })
  }
})
