import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DomainLedger,
  LEGACY_STAGE_PLAN,
  assuranceClaimsFor,
  buildAttestation,
  buildPipelineCompletionAttestation,
  canonicalJson,
  evidenceSha256,
  sha256,
  verifyCompletionAttestation,
  type StageEvidenceManifestEntry
} from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const commit = 'a'.repeat(40)
const policy = 'b'.repeat(64)
const stages = ['intent', 'rebase', 'review', 'test', 'document', 'lint', 'push', 'pr']

function evidence(
  runId: string,
  plan: readonly string[] = stages
): StageEvidenceManifestEntry[] {
  return plan.map((stage, round) => {
    const entry: StageEvidenceManifestEntry = {
      artifactSha256: sha256(`${stage}-artifact`),
      baseCommitOid: commit,
      candidateCommitOid: commit,
      evidenceSha256: '',
      exitCode: 0,
      round,
      stage,
      summary: `${stage} satisfied.`,
      workerIdentity: 'coordinator'
    }
    entry.evidenceSha256 = evidenceSha256({ ...entry, runId })
    return entry
  })
}

test('v2 completion attestations bind Release 2 facts without overstating assurance', async () => {
  const runId = 'pipeline-completion-v2'
  const completionIntent = 'Verify Release 2 completion evidence.'
  const stageEvidence = evidence(runId)
  const publicationRoute = {
    baseBranch: 'main',
    baseRepositoryId: 'R_base',
    forgeHost: 'github.com',
    headBranch: 'feature',
    headOwner: 'owner',
    headRepositoryId: 'R_head'
  }
  const legacyMeta = {
    baseCommitOid: commit,
    candidateCommitOid: commit,
    guardrailMode: 'strict',
    intent: 'Read legacy evidence conservatively.',
    policySha256: policy,
    runId: 'legacy-v1-3'
  } as const
  assert.throws(
    () => assuranceClaimsFor(buildAttestation([], legacyMeta)),
    /missing required stage evidence/
  )
  const legacy = buildAttestation(
    evidence(legacyMeta.runId, LEGACY_STAGE_PLAN),
    legacyMeta
  )
  assert.deepEqual(assuranceClaimsFor(legacy), ['legacy-local-pipeline-passed'])

  const home = await mkdtemp(path.join(tmpdir(), 'onm-v2-attestation-'))
  const offlineHome = await mkdtemp(path.join(tmpdir(), 'onm-v2-offline-'))
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  try {
    process.env.ORCA_NO_MISTAKES_HOME = home
    const ledger = new DomainLedger()
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: completionIntent,
      policySha256: policy,
      repoRoot: '/repo',
      runId,
      stagePlan: stages.map((stageId) => ({ requirement: 'required' as const, stageId })),
      submissionCommitOid: commit
    })
    for (const entry of stageEvidence) {
      ledger.recordStageDisposition({
        disposition: 'satisfied',
        evidenceSha256: entry.evidenceSha256,
        runId,
        stageId: entry.stage
      })
    }
    const routeFingerprint = ledger.recordPublicationRoute({
      ...publicationRoute,
      runId
    })
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'failed-attempt',
      coordinatorIdentity: 'coordinator',
      generationToken: 1,
      runId,
      startedAt: '2026-08-30T12:00:00.000Z'
    })
    const failedOutcome = ledger.recordAttemptOutcome({
      actorIdentity: 'operator',
      attemptId: 'failed-attempt',
      candidateCommitOid: commit,
      completedAt: '2026-08-30T12:00:01.000Z',
      coordinatorIdentity: 'coordinator',
      custody: { recoveryRef: `refs/no-mistakes/recover/${runId}` },
      reason: 'publication interrupted',
      receiptDigests: [],
      resumeEligible: true,
      runId,
      stoppingFact: 'candidate-publication-pre-read',
      verdict: 'failed'
    })
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'passed-attempt',
      coordinatorIdentity: 'coordinator',
      generationToken: 2,
      runId,
      startedAt: '2026-08-30T12:00:02.000Z'
    })

    const pushEvidence = stageEvidence.find((entry) => entry.stage === 'push')!
    const pushObservation = ledger.recordRemoteObservation({
      attemptId: 'passed-attempt',
      kind: 'publication-head',
      observedAt: '2026-08-30T12:00:03.000Z',
      payload: { oid: commit },
      runId,
      subject: 'refs/heads/feature'
    })
    const publicationReceipt = ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: commit, outputCommitOid: commit, roundIndex: 6 },
      evidence: {
        artifactPath: path.join(home, 'push.json'),
        artifactSha256: pushEvidence.artifactSha256,
        baseCommitOid: commit,
        candidateCommitOid: commit,
        evidenceSha256: pushEvidence.evidenceSha256,
        exitCode: 0,
        roundIndex: pushEvidence.round,
        runId,
        stageId: 'push',
        summary: pushEvidence.summary,
        workerIdentity: pushEvidence.workerIdentity
      },
      receipt: {
        authoritativePostObservationSha256: pushObservation,
        candidateCommitOid: commit,
        kind: 'candidate-publication',
        payload: { routeFingerprint }
      },
      runId,
      stageId: 'push'
    }).receiptSha256

    const prEvidence = stageEvidence.find((entry) => entry.stage === 'pr')!
    const prObservation = ledger.recordRemoteObservation({
      attemptId: 'passed-attempt',
      kind: 'pull-request',
      observedAt: '2026-08-30T12:00:04.000Z',
      payload: { candidateCommitOid: commit, number: 77 },
      runId,
      subject: 'owner/repo#77'
    })
    const prReceipt = ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: commit, outputCommitOid: commit, roundIndex: 7 },
      evidence: {
        artifactPath: path.join(home, 'pr.json'),
        artifactSha256: prEvidence.artifactSha256,
        baseCommitOid: commit,
        candidateCommitOid: commit,
        evidenceSha256: prEvidence.evidenceSha256,
        exitCode: 0,
        roundIndex: prEvidence.round,
        runId,
        stageId: 'pr',
        summary: prEvidence.summary,
        workerIdentity: prEvidence.workerIdentity
      },
      receipt: {
        authoritativePostObservationSha256: prObservation,
        candidateCommitOid: commit,
        kind: 'pull-request-binding',
        payload: { number: 77, routeFingerprint }
      },
      runId,
      stageId: 'pr'
    }).receiptSha256
    const passedOutcome = ledger.recordAttemptOutcome({
      actorIdentity: 'operator',
      attemptId: 'passed-attempt',
      candidateCommitOid: commit,
      completedAt: '2026-08-30T12:00:05.000Z',
      coordinatorIdentity: 'coordinator',
      custody: {
        recoveryRef: `refs/no-mistakes/recover/${runId}`,
        settlement: 'candidate preserved'
      },
      reason: 'pipeline completed',
      receiptDigests: [publicationReceipt, prReceipt],
      resumeEligible: false,
      runId,
      stoppingFact: 'pull-request-bound',
      verdict: 'passed'
    })
    const manifest = buildPipelineCompletionAttestation(stageEvidence, {
      attemptOutcomeDigests: [failedOutcome, passedOutcome],
      baseCommitOid: commit,
      candidateCommitOid: commit,
      candidatePublicationReceiptSha256: publicationReceipt,
      custody: {
        recoveryRef: `refs/no-mistakes/recover/${runId}`,
        settlement: 'candidate preserved'
      },
      intent: completionIntent,
      policySha256: policy,
      publicationRoute: { ...publicationRoute, routeFingerprint },
      pullRequestBindingReceiptSha256: prReceipt,
      runId,
      stageDispositions: stageEvidence.map((entry) => ({
        disposition: 'satisfied' as const,
        evidenceSha256: entry.evidenceSha256,
        stage: entry.stage
      })),
      stagePlan: stages.map((stage) => ({ requirement: 'required' as const, stage }))
    })

    verifyCompletionAttestation(manifest)
    assert.equal(manifest.version, '2.0.0')
    assert.deepEqual(manifest.assuranceClaims, [
      'configured-pipeline-completed',
      'candidate-publication-verified',
      'pull-request-bound'
    ])
    assert.equal(manifest.assuranceClaims.includes('checks-passed' as never), false)
    assert.equal(manifest.assuranceClaims.includes('Passed' as never), false)

    const overstated = structuredClone(manifest)
    overstated.assuranceClaims.push('checks-passed' as never)
    assert.throws(() => verifyCompletionAttestation(overstated), /assurance claims/)

    const missingFacts = new DomainLedger(':memory:')
    missingFacts.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: manifest.intent,
      policySha256: policy,
      repoRoot: '/repo',
      runId,
      stagePlan: stages.map((stageId) => ({ requirement: 'required' as const, stageId })),
      submissionCommitOid: commit
    })
    assert.throws(
      () => missingFacts.recordAttestation(manifest),
      /does not match retained ledger facts/
    )
    missingFacts.close()

    ledger.finishRun(runId, 'passed', commit)
    ledger.recordAttestation(manifest)
    ledger.close()

    const exported = path.join(home, 'completion.json')
    await main(['attestation', 'export', runId, `--out=${exported}`])
    assert.deepEqual(JSON.parse(await readFile(exported, 'utf8')), manifest)

    process.env.ORCA_NO_MISTAKES_HOME = offlineHome
    await main(['attestation', 'verify', exported])
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(offlineHome, { recursive: true, force: true })
  }
})
