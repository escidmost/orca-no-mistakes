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
const submission = 'c'.repeat(40)
const policy = 'd'.repeat(64)
const stages = ['intent', 'rebase', 'review', 'test', 'document', 'lint', 'push', 'pr']

async function completionFixture(options: { exerciseRemoteRejections?: boolean; retainLocalEvidence: boolean }) {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-v2-retained-'))
  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
  const runId = `v2-retained-${options.retainLocalEvidence ? 'complete' : 'missing'}`
  const intent = 'Retain exact completion provenance.'
  const artifact = Buffer.from('{}')
  const entries: (StageEvidenceManifestEntry & { artifactPath: string })[] = []
  for (const [round, stage] of stages.entries()) {
    const artifactPath = path.join(temp, `${stage}.json`)
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
      summary: `${stage} completed.`,
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
    stagePlan: stages.map((stageId) => ({ requirement: 'required', stageId })),
    submissionCommitOid: submission
  })
  for (const entry of entries) {
    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: entry.evidenceSha256,
      runId,
      stageId: entry.stage
    })
    if (options.retainLocalEvidence && entry.stage !== 'push' && entry.stage !== 'pr') {
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
        workerIdentity: entry.workerIdentity
      })
    }
  }
  const publicationRoute = {
    baseBranch: 'main',
    baseRepositoryId: 'R_base',
    forgeHost: 'github.com',
    headBranch: 'feature',
    headOwner: 'owner',
    headRepositoryId: 'R_head'
  }
  const routeFingerprint = ledger.recordPublicationRoute({ ...publicationRoute, runId })
  ledger.startAttempt({
    actorIdentity: 'operator',
    attemptId: `${runId}-attempt`,
    coordinatorIdentity: 'coordinator',
    generationToken: 1,
    runId,
    startedAt: '2026-08-30T12:00:00.000Z'
  })
  const attemptId = `${runId}-attempt`
  const pushEntry = entries.find((entry) => entry.stage === 'push')!
  const pushEvidence = {
    artifactPath: pushEntry.artifactPath,
    artifactSha256: pushEntry.artifactSha256,
    baseCommitOid: base,
    candidateCommitOid: candidate,
    evidenceSha256: pushEntry.evidenceSha256,
    exitCode: 0,
    roundIndex: pushEntry.round,
    runId,
    stageId: 'push',
    summary: pushEntry.summary,
    workerIdentity: pushEntry.workerIdentity
  }
  if (options.exerciseRemoteRejections) {
    const unboundPostRead = ledger.recordRemoteObservation({
      attemptId,
      kind: 'publication-head',
      observedAt: '2026-08-30T12:00:00.500Z',
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
    assert.throws(() => ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 6 },
      evidence: pushEvidence,
      receipt: {
        authoritativePostObservationSha256: unboundPostRead,
        candidateCommitOid: candidate,
        kind: 'candidate-publication',
        payload: {
          mutationIntent: sha256('missing-intent'),
          outcome: 'created',
          postRead: unboundPostRead,
          preRead: sha256('missing-pre-read'),
          routeFingerprint
        }
      },
      runId,
      stageId: 'push'
    }), /does not match/)
  }
  ledger.recordPublicationBaseline({
    headCommitOid: null,
    observedAt: '2026-08-30T12:00:01.000Z',
    routeFingerprint,
    runId
  })
  const preRead = ledger.recordRemoteObservation({
    attemptId,
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
    attemptId,
    createdAt: '2026-08-30T12:00:02.000Z',
    kind: 'candidate-publication',
    payload: { expected: 'absent', update: candidate },
    runId,
    targetFingerprint: routeFingerprint
  })
  if (options.exerciseRemoteRejections) {
    const wrongRepository = ledger.recordRemoteObservation({
      attemptId,
      kind: 'publication-head',
      observedAt: '2026-08-30T12:00:03.000Z',
      payload: {
        forgeHost: 'github.com',
        headBranch: 'feature',
        headOwner: 'owner',
        oid: candidate,
        repositoryId: 'R_other'
      },
      runId,
      subject: 'github.com/R_head:refs/heads/feature'
    })
    assert.throws(() => ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 6 },
      evidence: pushEvidence,
      receipt: {
        authoritativePostObservationSha256: wrongRepository,
        candidateCommitOid: candidate,
        kind: 'candidate-publication',
        payload: {
          mutationIntent: publicationIntent,
          outcome: 'created',
          postRead: wrongRepository,
          preRead,
          routeFingerprint
        }
      },
      runId,
      stageId: 'push'
    }), /does not match/)
  }
  const postRead = ledger.recordRemoteObservation({
    attemptId,
    kind: 'publication-head',
    observedAt: '2026-08-30T12:00:04.000Z',
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
    checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 6 },
    evidence: pushEvidence,
    receipt: {
      authoritativePostObservationSha256: postRead,
      candidateCommitOid: candidate,
      kind: 'candidate-publication',
      payload: {
        mutationIntent: publicationIntent,
        outcome: 'created',
        postRead,
        preRead,
        routeFingerprint
      }
    },
    runId,
    stageId: 'push'
  }).receiptSha256
  const pullRequestIntent = ledger.recordMutationIntent({
    attemptId,
    createdAt: '2026-08-30T12:00:05.000Z',
    kind: 'pull-request',
    payload: {
      action: 'ensure-open',
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      candidateCommitOid: candidate,
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_head'
    },
    runId,
    targetFingerprint: routeFingerprint
  })
  const pullRequestObservation = ledger.recordRemoteObservation({
    attemptId,
    kind: 'pull-request',
    observedAt: '2026-08-30T12:00:06.000Z',
    payload: {
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      candidateCommitOid: candidate,
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_head',
      number: 77,
      state: 'open'
    },
    runId,
    subject: 'github.com/R_base#77'
  })
  const prEntry = entries.find((entry) => entry.stage === 'pr')!
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
      stageId: 'pr',
      summary: prEntry.summary,
      workerIdentity: prEntry.workerIdentity
    },
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
    stageId: 'pr'
  }).receiptSha256
  const custody = { recoveryRef: `refs/no-mistakes/recover/${runId}` }
  const outcome = ledger.recordAttemptOutcome({
    actorIdentity: 'operator',
    attemptId,
    candidateCommitOid: candidate,
    completedAt: '2026-08-30T12:00:07.000Z',
    coordinatorIdentity: 'coordinator',
    custody,
    reason: 'pipeline completed',
    receiptDigests: [publicationReceipt, pullRequestReceipt],
    resumeEligible: false,
    runId,
    stoppingFact: 'pull-request-bound',
    verdict: 'passed'
  })
  ledger.finishRun(runId, 'passed', candidate)
  const stageEvidence = entries.map(({ artifactPath: _artifactPath, ...entry }) => entry)
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
      disposition: 'satisfied',
      evidenceSha256: entry.evidenceSha256,
      stage: entry.stage
    })),
    stagePlan: stages.map((stage) => ({ requirement: 'required', stage }))
  })
  return { ledger, manifest, temp }
}

test('v2 retained completion uses evidence base and complete remote facts', async () => {
  const fixture = await completionFixture({ exerciseRemoteRejections: true, retainLocalEvidence: true })
  try {
    assert.doesNotThrow(() => fixture.ledger.recordAttestation(fixture.manifest))
    await writeFile(path.join(fixture.temp, 'review.json'), Buffer.from('tampered'))
    assert.throws(
      () => fixture.ledger.verifyRetainedCompletionAttestation(fixture.manifest),
      /stage evidence/
    )
  } finally {
    fixture.ledger.close()
    await rm(fixture.temp, { recursive: true, force: true })
  }
})

test('v2 attestation rejects unretained local evidence', async () => {
  const fixture = await completionFixture({ retainLocalEvidence: false })
  try {
    assert.throws(
      () => fixture.ledger.recordAttestation(fixture.manifest),
      /stage evidence/
    )
  } finally {
    fixture.ledger.close()
    await rm(fixture.temp, { recursive: true, force: true })
  }
})
