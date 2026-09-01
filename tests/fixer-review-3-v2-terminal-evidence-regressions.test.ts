import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  DomainLedger,
  buildPipelineCompletionAttestation,
  canonicalJson,
  evidenceSha256,
  repositoryLedgerPath,
  sha256,
  verifyCompletionAttestation,
  type StageEvidenceManifestEntry
} from '../scripts/ledger.ts'

const candidate = 'a'.repeat(40)
const base = 'b'.repeat(40)
const policy = 'c'.repeat(64)

function manifestFor(runId: string) {
  const stageEvidence = ['push', 'pr'].map((stage, round) => {
    const entry: StageEvidenceManifestEntry = {
      artifactSha256: sha256(`${stage}-artifact`),
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
    return entry
  })
  const route = {
    baseBranch: 'main',
    baseRepositoryId: 'R_base',
    forgeHost: 'github.com',
    headBranch: 'feature',
    headOwner: 'owner',
    headRepositoryId: 'R_head'
  }
  return buildPipelineCompletionAttestation(stageEvidence, {
    attemptOutcomeDigests: ['d'.repeat(64)],
    baseCommitOid: base,
    candidateCommitOid: candidate,
    candidatePublicationReceiptSha256: 'e'.repeat(64),
    custody: { recoveryRef: `refs/no-mistakes/recover/${runId}` },
    intent: 'Verify conservative Release 2 completion.',
    policySha256: policy,
    publicationRoute: {
      ...route,
      routeFingerprint: sha256(canonicalJson(route))
    },
    pullRequestBindingReceiptSha256: 'f'.repeat(64),
    runId,
    stageDispositions: stageEvidence.map((entry) => ({
      disposition: 'satisfied' as const,
      evidenceSha256: entry.evidenceSha256,
      stage: entry.stage
    })),
    stagePlan: stageEvidence.map((entry) => ({
      requirement: 'required' as const,
      stage: entry.stage
    }))
  })
}

test('v2 satisfied dispositions require successful authoritative evidence', () => {
  const manifest = structuredClone(manifestFor('authoritative-evidence'))
  const failed = manifest.stageEvidence[0]
  failed.exitCode = 1
  failed.workerIdentity = 'coordinator:fixer-guardrail-advisory'
  failed.evidenceSha256 = evidenceSha256({ ...failed, runId: manifest.runId })
  manifest.stageDispositions[0].evidenceSha256 = failed.evidenceSha256

  assert.throws(
    () => verifyCompletionAttestation(manifest),
    /does not bind successful authoritative evidence/
  )
  const ledger = new DomainLedger(':memory:')
  try {
    assert.throws(
      () => ledger.verifyRetainedCompletionAttestation(manifest),
      /does not bind successful authoritative evidence/
    )
  } finally {
    ledger.close()
  }
})

test('terminal runs reject new Release 2 facts after migration', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-terminal-facts-'))
  const repo = path.join(temp, 'repo')
  const legacyPath = path.join(temp, 'legacy.sqlite')
  let migrated: DomainLedger | undefined
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
    const repoRoot = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8'
    }).trim()
    const legacy = new DomainLedger(legacyPath)
    legacy.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Retain terminal facts.',
      policySha256: policy,
      repoRoot,
      runId: 'terminal-run',
      stagePlan: [
        { requirement: 'required', stageId: 'push' },
        { requirement: 'required', stageId: 'pr' }
      ],
      submissionCommitOid: candidate
    })
    const generationToken = legacy.acquireLease({
      branch: 'feature',
      repoRoot,
      runId: 'terminal-run'
    })
    legacy.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'original-attempt',
      coordinatorIdentity: 'coordinator',
      generationToken,
      runId: 'terminal-run',
      startedAt: '2026-08-30T12:00:00.000Z'
    })
    legacy.releaseLease('terminal-run')
    assert.equal(legacy.finishRun('terminal-run', 'failed'), true)
    legacy.close()

    migrated = new DomainLedger({ legacyPath, repositoryPath: repo })
    assert.equal(migrated.runStatus('terminal-run'), 'failed')
    assert.throws(
      () => migrated?.startAttempt({
        actorIdentity: 'operator',
        attemptId: 'late-attempt',
        coordinatorIdentity: 'coordinator',
        generationToken: 99,
        runId: 'terminal-run',
        startedAt: '2026-08-30T12:01:00.000Z'
      }),
      /cannot add Release 2 facts to a terminal run/
    )

    const direct = new DatabaseSync(repositoryLedgerPath(repo))
    try {
      const count = direct.prepare(
        'SELECT COUNT(*) AS count FROM run_attempts WHERE run_id = ?'
      ).get('terminal-run') as { count: number | bigint }
      assert.equal(Number(count.count), 1)
      assert.throws(
        () => direct.prepare(
          `INSERT INTO run_attempts
             (attempt_id, run_id, generation_token, coordinator_identity, actor_identity, started_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run('direct-late-attempt', 'terminal-run', 100, 'coordinator', 'operator',
          '2026-08-30T12:02:00.000Z'),
        /cannot add Release 2 facts to a terminal run/
      )
    } finally {
      direct.close()
    }
  } finally {
    migrated?.close()
    await rm(temp, { recursive: true, force: true })
  }
})

test('candidate publication outcome matches the authoritative baseline', () => {
  const ledger = new DomainLedger(':memory:')
  try {
    const runId = 'candidate-outcome'
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Bind the publication outcome.',
      policySha256: policy,
      repoRoot: '/repo',
      runId,
      stagePlan: [
        { requirement: 'required', stageId: 'push' },
        { requirement: 'required', stageId: 'pr' }
      ],
      submissionCommitOid: candidate
    })
    const routeFingerprint = ledger.recordPublicationRoute({
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_head',
      runId
    })
    ledger.recordPublicationBaseline({
      headCommitOid: null,
      observedAt: '2026-08-30T12:00:01.000Z',
      routeFingerprint,
      runId,
      transportUrl: 'github.com/owner/repo'
    })
    const generationToken = ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId })
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'attempt',
      coordinatorIdentity: 'coordinator',
      generationToken,
      runId,
      startedAt: '2026-08-30T12:00:00.000Z'
    })
    const subject = 'github.com/R_head:refs/heads/feature'
    const preRead = ledger.recordRemoteObservation({
      attemptId: 'attempt',
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
      subject
    })
    const mutationIntent = ledger.recordMutationIntent({
      attemptId: 'attempt',
      createdAt: '2026-08-30T12:00:02.000Z',
      kind: 'candidate-publication',
      payload: { expected: 'absent', update: candidate },
      runId,
      targetFingerprint: routeFingerprint
    })
    const postRead = ledger.recordRemoteObservation({
      attemptId: 'attempt',
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
      subject
    })
    const evidence = {
      artifactPath: '/unused',
      artifactSha256: sha256('artifact'),
      baseCommitOid: base,
      candidateCommitOid: candidate,
      evidenceSha256: '',
      exitCode: 0,
      roundIndex: 0,
      runId,
      stageId: 'push',
      summary: 'push passed',
      workerIdentity: 'coordinator'
    }
    evidence.evidenceSha256 = evidenceSha256({
      ...evidence,
      round: evidence.roundIndex,
      stage: evidence.stageId
    })
    const settlement = {
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 0 },
      evidence,
      receipt: {
        authoritativePostObservationSha256: postRead,
        candidateCommitOid: candidate,
        kind: 'candidate-publication' as const,
        payload: {
          mutationIntent,
          outcome: 'unchanged',
          postRead,
          preRead,
          routeFingerprint
        }
      },
      runId,
      stageId: 'push' as const,
      ownership: { branch: 'feature', generationToken, repoRoot: '/repo' }
    }
    assert.throws(
      () => ledger.settleRemoteStage(settlement),
      /does not match its authoritative post-read observation/
    )
    settlement.receipt.payload.outcome = 'created'
    assert.match(ledger.settleRemoteStage(settlement).receiptSha256, /^[a-f0-9]{64}$/)
  } finally {
    ledger.close()
  }
})
