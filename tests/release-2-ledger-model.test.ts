import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { DomainLedger, evidenceSha256, sha256 } from '../scripts/ledger.ts'

const commit = 'a'.repeat(40)
const policy = 'b'.repeat(64)
const timestamp = '2026-08-30T12:00:00.000Z'

test('reopening replaces stale terminal fact triggers', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-release-2-trigger-'))
  const dbPath = path.join(temp, 'ledger.sqlite')
  try {
    new DomainLedger(dbPath).close()
    const database = new DatabaseSync(dbPath)
    database.exec(`DROP TRIGGER fence_terminal_publication_routes;
      CREATE TRIGGER fence_terminal_publication_routes
      BEFORE INSERT ON publication_routes
      WHEN 0
      BEGIN SELECT RAISE(ABORT, 'stale trigger'); END;`)
    database.close()

    const ledger = new DomainLedger(dbPath)
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Reject terminal Release 2 facts.',
      policySha256: policy,
      repoRoot: '/repo',
      runId: 'terminal-trigger-upgrade',
      submissionCommitOid: commit
    })
    ledger.finishRun('terminal-trigger-upgrade', 'failed')
    assert.throws(() => ledger.recordPublicationRoute({
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_head',
      runId: 'terminal-trigger-upgrade'
    }), /cannot add Release 2 facts to a terminal run/)
    ledger.close()
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('Release 2 ledger facts are immutable, append-only, and atomically checkpointed', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-release-2-ledger-'))
  const dbPath = path.join(temp, 'ledger.sqlite')
  const ledger = new DomainLedger(dbPath)
  try {
    const runId = 'release-2-model'
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Persist the Release 2 run graph.',
      policySha256: policy,
      repoRoot: '/repo',
      runId,
      stagePlan: [
        'intent',
        'rebase',
        'review',
        'test',
        'document',
        'lint',
        'push',
        'pr'
      ].map((stageId) => ({ requirement: 'required' as const, stageId })),
      submissionCommitOid: commit
    })
    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: sha256('intent-evidence'),
      runId,
      stageId: 'intent'
    })

    const routeFingerprint = ledger.recordPublicationRoute({
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'fork-owner',
      headRepositoryId: 'R_head',
      runId
    })
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature-2',
      intent: 'Reuse the same publication route in another run.',
      policySha256: policy,
      repoRoot: '/repo',
      runId: 'release-2-model-2',
      submissionCommitOid: commit
    })
    assert.equal(ledger.recordPublicationRoute({
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'fork-owner',
      headRepositoryId: 'R_head',
      runId: 'release-2-model-2'
    }), routeFingerprint)
    ledger.recordPublicationBaseline({
      headCommitOid: null,
      observedAt: timestamp,
      routeFingerprint,
      runId
    })

    const generationToken = ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId })
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'attempt-1',
      coordinatorIdentity: 'orca-run-1',
      generationToken,
      runId,
      startedAt: timestamp
    })
    assert.throws(
      () => ledger.recordRemoteObservation({
        attemptId: 'attempt-1',
        kind: 'publication-head',
        observedAt: timestamp,
        payload: { state: 'absent' },
        runId: 'release-2-model-2',
        subject: 'refs/heads/feature'
      }),
      /attempt does not belong to run/
    )
    assert.throws(
      () => ledger.recordMutationIntent({
        attemptId: 'attempt-1',
        createdAt: timestamp,
        kind: 'candidate-publication',
        payload: { expected: 'absent', update: commit },
        runId: 'release-2-model-2',
        targetFingerprint: routeFingerprint
      }),
      /attempt does not belong to run/
    )
    const failedOutcome = ledger.recordAttemptOutcome({
      actorIdentity: 'operator',
      attemptId: 'attempt-1',
      candidateCommitOid: commit,
      completedAt: timestamp,
      coordinatorIdentity: 'orca-run-1',
      custody: { recoveryRef: 'refs/no-mistakes/recover/release-2-model' },
      reason: 'transport unavailable',
      receiptDigests: [],
      resumeEligible: true,
      runId,
      stoppingFact: 'candidate-publication-pre-read',
      verdict: 'failed'
    })
    assert.match(failedOutcome, /^[0-9a-f]{64}$/)

    const preRead = ledger.recordRemoteObservation({
      attemptId: 'attempt-1',
      kind: 'publication-head',
      observedAt: timestamp,
      payload: {
        forgeHost: 'github.com',
        headBranch: 'feature',
        headOwner: 'fork-owner',
        repositoryId: 'R_head',
        state: 'absent'
      },
      runId,
      subject: 'github.com/R_head:refs/heads/feature'
    })
    const mutationIntent = ledger.recordMutationIntent({
      attemptId: 'attempt-1',
      createdAt: timestamp,
      kind: 'candidate-publication',
      payload: { expected: 'absent', update: commit },
      runId,
      targetFingerprint: routeFingerprint
    })
    const postRead = ledger.recordRemoteObservation({
      attemptId: 'attempt-1',
      kind: 'publication-head',
      observedAt: timestamp,
      payload: {
        forgeHost: 'github.com',
        headBranch: 'feature',
        headOwner: 'fork-owner',
        oid: commit,
        repositoryId: 'R_head'
      },
      runId,
      subject: 'github.com/R_head:refs/heads/feature'
    })

    const evidence = {
      artifactPath: path.join(temp, 'push.json'),
      artifactSha256: sha256('push artifact'),
      baseCommitOid: commit,
      candidateCommitOid: commit,
      evidenceSha256: '',
      exitCode: 0,
      roundIndex: 0,
      runId,
      stageId: 'push',
      summary: 'Candidate publication verified.',
      workerIdentity: 'coordinator'
    }
    evidence.evidenceSha256 = evidenceSha256({
      artifactSha256: evidence.artifactSha256,
      baseCommitOid: commit,
      candidateCommitOid: commit,
      exitCode: 0,
      round: 0,
      runId,
      stage: 'push',
      summary: evidence.summary,
      workerIdentity: evidence.workerIdentity
    })

    const triggerDb = new DatabaseSync(dbPath)
    triggerDb.exec(`CREATE TRIGGER reject_remote_checkpoint
      BEFORE INSERT ON stage_checkpoints
      WHEN NEW.stage_id = 'push'
      BEGIN SELECT RAISE(ABORT, 'forced checkpoint failure'); END`)
    triggerDb.close()

    const settlement = {
      checkpoint: {
        inputCommitOid: commit,
        outputCommitOid: commit,
        roundIndex: 0
      },
      evidence,
      receipt: {
        authoritativePostObservationSha256: postRead,
        candidateCommitOid: commit,
        kind: 'candidate-publication' as const,
        payload: {
          mutationIntent,
          outcome: 'created',
          postRead,
          preRead,
          routeFingerprint
        }
      },
      runId,
      stageId: 'push' as const
    }
    assert.throws(() => ledger.settleRemoteStage(settlement), /forced checkpoint failure/)
    assert.equal(ledger.remoteReceipt(runId, 'candidate-publication'), undefined)
    assert.equal(ledger.listEvidence(runId).length, 0)
    assert.equal(ledger.listCheckpoints(runId).length, 0)

    const cleanupDb = new DatabaseSync(dbPath)
    cleanupDb.exec('DROP TRIGGER reject_remote_checkpoint')
    cleanupDb.close()
    const firstSettlement = ledger.settleRemoteStage(settlement)
    const receiptDigest = firstSettlement.receiptSha256
    assert.match(receiptDigest, /^[0-9a-f]{64}$/)
    assert.deepEqual(ledger.settleRemoteStage(settlement), firstSettlement)
    assert.equal(ledger.listEvidence(runId).length, 1)
    assert.equal(ledger.listCheckpoints(runId).length, 1)
    const conflictingEvidence = {
      ...evidence,
      evidenceSha256: evidenceSha256({
        artifactSha256: evidence.artifactSha256,
        baseCommitOid: evidence.baseCommitOid,
        candidateCommitOid: evidence.candidateCommitOid,
        exitCode: evidence.exitCode,
        round: evidence.roundIndex,
        runId,
        stage: 'push',
        summary: 'different successful evidence',
        workerIdentity: evidence.workerIdentity
      }),
      summary: 'different successful evidence'
    }
    assert.throws(
      () => ledger.settleRemoteStage({ ...settlement, evidence: conflictingEvidence }),
      /push round 0 is already settled with different facts/
    )
    assert.equal(ledger.listEvidence(runId).length, 1)
    assert.equal(ledger.listCheckpoints(runId).length, 1)
    assert.equal(
      ledger.remoteReceipt(runId, 'candidate-publication')?.receipt_sha256,
      receiptDigest
    )
    assert.deepEqual(ledger.stageDispositions(runId).map((row) => ({ ...row })), [
      {
        disposition: 'satisfied',
        evidence_sha256: sha256('intent-evidence'),
        stage_id: 'intent'
      }
    ])
    assert.equal(ledger.listAttemptOutcomes(runId)[0].outcome_sha256, failedOutcome)
    assert.equal(ledger.listRemoteObservations(runId).length, 2)
    assert.equal(ledger.listMutationIntents(runId).length, 1)

    const mutationDb = new DatabaseSync(dbPath)
    assert.throws(
      () => mutationDb.prepare(
        "UPDATE remote_receipts SET receipt_json = '{}' WHERE run_id = ?"
      ).run(runId),
      /remote_receipts rows are immutable/
    )
    assert.throws(
      () => mutationDb.prepare(
        "UPDATE stage_plan_entries SET stage_id = 'changed' WHERE run_id = ? AND position = 0"
      ).run(runId),
      /stage_plan_entries rows are immutable/
    )
    mutationDb.close()
  } finally {
    ledger.close()
    await rm(temp, { recursive: true, force: true })
  }
})
