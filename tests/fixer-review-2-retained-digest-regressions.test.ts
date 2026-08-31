import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  buildPipelineCompletionAttestation,
  DomainLedger,
  evidenceSha256,
  sha256,
  type PipelineCompletionAttestationManifest,
  type RecordEvidenceInput
} from '../scripts/ledger.ts'

const base = 'a'.repeat(40)
const candidate = 'b'.repeat(40)
const policy = 'c'.repeat(64)

async function createCompletion(
  ledger: DomainLedger,
  temp: string,
  repoRoot: string,
  runId: string
): Promise<PipelineCompletionAttestationManifest> {
  const stages = ['push', 'pr'] as const
  const evidence: RecordEvidenceInput[] = []
  for (const [roundIndex, stageId] of stages.entries()) {
    const artifactPath = path.join(temp, `${runId}-${stageId}.json`)
    const artifact = Buffer.from('{}')
    await writeFile(artifactPath, artifact)
    const entry: RecordEvidenceInput = {
      artifactPath,
      artifactSha256: sha256(artifact),
      baseCommitOid: base,
      candidateCommitOid: candidate,
      evidenceSha256: '',
      exitCode: 0,
      roundIndex,
      runId,
      stageId,
      summary: `${stageId} completed.`,
      workerIdentity: 'coordinator'
    }
    entry.evidenceSha256 = evidenceSha256({
      ...entry,
      round: roundIndex,
      stage: stageId
    })
    evidence.push(entry)
  }

  ledger.startRun({
    baseBranch: 'main',
    branch: 'feature',
    intent: 'Retain exact remote completion facts.',
    policySha256: policy,
    repoRoot,
    runId,
    stagePlan: stages.map((stageId) => ({ requirement: 'required', stageId })),
    submissionCommitOid: base
  })
  const generationToken = ledger.acquireLease({ branch: 'feature', repoRoot, runId })
  for (const entry of evidence) {
    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: entry.evidenceSha256,
      runId,
      stageId: entry.stageId
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
  const attemptId = `${runId}-attempt`
  ledger.startAttempt({
    actorIdentity: 'operator',
    attemptId,
    coordinatorIdentity: 'coordinator',
    generationToken,
    runId,
    startedAt: '2026-08-30T12:00:00.000Z'
  })
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
    checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 0 },
    evidence: evidence[0],
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
  const pullRequestReceipt = ledger.settleRemoteStage({
    checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 1 },
    evidence: evidence[1],
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
  ledger.releaseLease(runId)
  return buildPipelineCompletionAttestation(evidence.map((entry) => ({
    artifactSha256: entry.artifactSha256,
    baseCommitOid: entry.baseCommitOid,
    candidateCommitOid: entry.candidateCommitOid,
    evidenceSha256: entry.evidenceSha256,
    exitCode: entry.exitCode,
    round: entry.roundIndex,
    stage: entry.stageId,
    summary: entry.summary,
    workerIdentity: entry.workerIdentity
  })), {
    attemptOutcomeDigests: [outcome],
    baseCommitOid: base,
    candidateCommitOid: candidate,
    candidatePublicationReceiptSha256: publicationReceipt,
    custody,
    intent: 'Retain exact remote completion facts.',
    policySha256: policy,
    publicationRoute: { ...route, routeFingerprint },
    pullRequestBindingReceiptSha256: pullRequestReceipt,
    runId,
    stageDispositions: stages.map((stage, index) => ({
      disposition: 'satisfied' as const,
      evidenceSha256: evidence[index].evidenceSha256,
      stage
    })),
    stagePlan: stages.map((stage) => ({ requirement: 'required' as const, stage }))
  })
}

test('retained v2 facts must match their stored digests after migration', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-retained-digests-'))
  const repo = path.join(temp, 'repo')
  const legacyPath = path.join(temp, 'legacy.sqlite')
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
    const repoRoot = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8'
    }).trim()
    const legacy = new DomainLedger(legacyPath)
    const manifests: PipelineCompletionAttestationManifest[] = []
    for (const runId of [
      'outcome-digest',
      'receipt-digest',
      'post-observation-digest',
      'pre-observation-digest',
      'mutation-intent-digest'
    ]) {
      manifests.push(await createCompletion(legacy, temp, repoRoot, runId))
    }
    legacy.close()

    const source = new DatabaseSync(legacyPath)
    source.exec(`
      DROP TRIGGER immutable_attempt_outcomes;
      DROP TRIGGER immutable_remote_receipts;
      DROP TRIGGER immutable_remote_observations;
      DROP TRIGGER immutable_mutation_intents;
    `)
    source.prepare("UPDATE attempt_outcomes SET reason = 'changed' WHERE run_id = ?")
      .run('outcome-digest')
    const receipt = source.prepare(
      "SELECT receipt_json FROM remote_receipts WHERE run_id = ? AND kind = 'candidate-publication'"
    ).get('receipt-digest') as { receipt_json: string }
    source.prepare(
      "UPDATE remote_receipts SET receipt_json = ? WHERE run_id = ? AND kind = 'candidate-publication'"
    ).run(receipt.receipt_json.replace('created', 'unchanged'), 'receipt-digest')
    source.prepare(
      "UPDATE remote_observations SET observed_at = ? WHERE run_id = ? AND kind = 'publication-head' AND payload_json LIKE '%oid%'"
    ).run('2026-08-30T12:00:03.000Z', 'post-observation-digest')
    source.prepare(
      "UPDATE remote_observations SET observed_at = ? WHERE run_id = ? AND kind = 'publication-head' AND payload_json LIKE '%state%'"
    ).run('2026-08-30T12:00:01.500Z', 'pre-observation-digest')
    source.prepare(
      "UPDATE mutation_intents SET created_at = ? WHERE run_id = ? AND kind = 'candidate-publication'"
    ).run('2026-08-30T12:00:02.500Z', 'mutation-intent-digest')
    source.close()

    const migrated = new DomainLedger({ legacyPath, repositoryPath: repo })
    for (const manifest of manifests) {
      assert.throws(
        () => migrated.verifyRetainedCompletionAttestation(manifest),
        /does not match retained ledger facts/
      )
    }
    migrated.close()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
