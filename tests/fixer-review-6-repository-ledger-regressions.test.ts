import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DomainLedger,
  artifactsRoot,
  buildPipelineCompletionAttestation,
  canonicalJson,
  evidenceSha256,
  repositoryLedgerPath,
  sha256,
  type StageEvidenceManifestEntry
} from '../scripts/ledger.ts'

const base = 'a'.repeat(40)
const candidate = 'b'.repeat(40)
const policy = 'c'.repeat(64)

test('home override relocates artifacts and legacy migration only', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-repository-home-'))
  const repo = path.join(temp, 'repo')
  const home = path.join(temp, 'home')
  const previousCwd = process.cwd()
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
    const repoRoot = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8'
    }).trim()
    process.env.ORCA_NO_MISTAKES_HOME = home
    const legacy = new DomainLedger(path.join(home, 'ledger.db'))
    legacy.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Migrate configured legacy state.',
      policySha256: policy,
      repoRoot,
      runId: 'configured-home-migration',
      submissionCommitOid: candidate
    })
    legacy.finishRun('configured-home-migration', 'failed')
    legacy.close()

    process.chdir(repo)
    const selected = new DomainLedger()
    assert.equal(selected.path, repositoryLedgerPath(repo))
    assert.equal(selected.runStatus('configured-home-migration'), 'failed')
    assert.equal(artifactsRoot(), path.join(home, 'artifacts'))
    selected.close()
  } finally {
    process.chdir(previousCwd)
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome
    await rm(temp, { recursive: true, force: true })
  }
})

test('attempt facts and receipt settlement require the current lease generation', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-attempt-fence-'))
  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
  const runId = 'attempt-generation-fence'
  const artifactPath = path.join(temp, 'push.json')
  try {
    await writeFile(artifactPath, '{}')
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Fence attempt facts.',
      policySha256: policy,
      repoRoot: '/repo',
      runId,
      stagePlan: [{ requirement: 'required', stageId: 'push' }],
      submissionCommitOid: base
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
      observedAt: '2026-08-31T12:00:00.000Z',
      routeFingerprint,
      runId,
      transportUrl: 'github.com/owner/repo'
    })
    assert.throws(() => ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'unowned-attempt',
      coordinatorIdentity: 'coordinator',
      generationToken: 1,
      runId,
      startedAt: '2026-08-31T11:59:59.000Z'
    }), /current branch lease generation/)
    const firstGeneration = ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId })
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'stale-attempt',
      coordinatorIdentity: 'coordinator',
      generationToken: firstGeneration,
      runId,
      startedAt: '2026-08-31T12:00:00.000Z'
    })
    const preRead = ledger.recordRemoteObservation({
      attemptId: 'stale-attempt',
      kind: 'publication-head',
      observedAt: '2026-08-31T12:00:01.000Z',
      payload: {
        forgeHost: route.forgeHost,
        headBranch: route.headBranch,
        headOwner: route.headOwner,
        repositoryId: route.headRepositoryId,
        state: 'absent'
      },
      runId,
      subject: 'github.com/R_head:refs/heads/feature'
    })
    const mutationIntent = ledger.recordMutationIntent({
      attemptId: 'stale-attempt',
      createdAt: '2026-08-31T12:00:02.000Z',
      kind: 'candidate-publication',
      payload: { expected: 'absent', update: candidate },
      runId,
      targetFingerprint: routeFingerprint
    })
    const postRead = ledger.recordRemoteObservation({
      attemptId: 'stale-attempt',
      kind: 'publication-head',
      observedAt: '2026-08-31T12:00:03.000Z',
      payload: {
        forgeHost: route.forgeHost,
        headBranch: route.headBranch,
        headOwner: route.headOwner,
        oid: candidate,
        repositoryId: route.headRepositoryId
      },
      runId,
      subject: 'github.com/R_head:refs/heads/feature'
    })
    ledger.releaseLease(runId)
    assert.throws(() => ledger.recordRemoteObservation({
      attemptId: 'stale-attempt',
      kind: 'publication-head',
      observedAt: '2026-08-31T12:00:04.000Z',
      payload: {},
      runId,
      subject: 'unowned'
    }), /current branch lease generation/)
    const currentGeneration = ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId })
    assert.notEqual(currentGeneration, firstGeneration)

    assert.throws(() => ledger.recordRemoteObservation({
      attemptId: 'stale-attempt',
      kind: 'publication-head',
      observedAt: '2026-08-31T12:00:04.000Z',
      payload: {},
      runId,
      subject: 'stale'
    }), /current branch lease generation/)
    assert.throws(() => ledger.recordMutationIntent({
      attemptId: 'stale-attempt',
      createdAt: '2026-08-31T12:00:04.000Z',
      kind: 'managed-comment',
      payload: {},
      runId,
      targetFingerprint: routeFingerprint
    }), /current branch lease generation/)
    assert.throws(() => ledger.recordAttemptOutcome({
      actorIdentity: 'operator',
      attemptId: 'stale-attempt',
      candidateCommitOid: candidate,
      completedAt: '2026-08-31T12:00:04.000Z',
      coordinatorIdentity: 'coordinator',
      custody: {},
      reason: 'stale',
      receiptDigests: [],
      resumeEligible: false,
      runId,
      stoppingFact: 'stale',
      verdict: 'failed'
    }), /current branch lease generation/)
    assert.throws(() => ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'late-stale-attempt',
      coordinatorIdentity: 'coordinator',
      generationToken: firstGeneration,
      runId,
      startedAt: '2026-08-31T12:00:04.000Z'
    }), /current branch lease generation/)

    const artifactSha256 = sha256('{}')
    const pushEvidence = {
      artifactPath,
      artifactSha256,
      baseCommitOid: base,
      candidateCommitOid: candidate,
      evidenceSha256: '',
      exitCode: 0,
      roundIndex: 0,
      runId,
      stageId: 'push' as const,
      summary: 'Push completed.',
      workerIdentity: 'coordinator'
    }
    pushEvidence.evidenceSha256 = evidenceSha256({
      artifactSha256,
      baseCommitOid: base,
      candidateCommitOid: candidate,
      exitCode: 0,
      round: 0,
      runId,
      stage: 'push',
      summary: pushEvidence.summary,
      workerIdentity: pushEvidence.workerIdentity
    })
    assert.throws(() => ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 0 },
      evidence: pushEvidence,
      receipt: {
        authoritativePostObservationSha256: postRead,
        candidateCommitOid: candidate,
        kind: 'candidate-publication',
        payload: {
          mutationIntent,
          outcome: 'created',
          postRead,
          preRead,
          routeFingerprint
        }
      },
      ownership: { branch: 'feature', generationToken: firstGeneration, repoRoot: '/repo' },
      runId,
      stageId: 'push'
    }), /no longer owns its branch lease/)

    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'current-attempt',
      coordinatorIdentity: 'coordinator',
      generationToken: currentGeneration,
      runId,
      startedAt: '2026-08-31T12:00:05.000Z'
    })
    assert.doesNotThrow(() => ledger.recordRemoteObservation({
      attemptId: 'current-attempt',
      kind: 'publication-head',
      observedAt: '2026-08-31T12:00:05.000Z',
      payload: {},
      runId,
      subject: 'current'
    }))
  } finally {
    ledger.close()
    await rm(temp, { recursive: true, force: true })
  }
})

test('v2 finalization rolls back run and lease when attestation insertion fails', () => {
  const ledger = new DomainLedger(':memory:')
  const runId = 'atomic-v2-finalization'
  try {
    const stageEvidence = ['push', 'pr'].map((stage, round) => {
      const entry: StageEvidenceManifestEntry = {
        artifactSha256: sha256('{}'),
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
      return entry
    })
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Finalize v2 atomically.',
      policySha256: policy,
      repoRoot: '/repo',
      runId,
      stagePlan: ['push', 'pr'].map((stageId) => ({
        requirement: 'required' as const,
        stageId
      })),
      submissionCommitOid: base
    })
    const generationToken = ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId })
    const publicationRoute = {
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_head'
    }
    const manifest = buildPipelineCompletionAttestation(stageEvidence, {
      attemptOutcomeDigests: ['d'.repeat(64)],
      baseCommitOid: base,
      candidateCommitOid: candidate,
      candidatePublicationReceiptSha256: 'e'.repeat(64),
      custody: { recoveryRef: `refs/no-mistakes/recover/${runId}` },
      intent: 'Finalize v2 atomically.',
      policySha256: policy,
      publicationRoute: {
        ...publicationRoute,
        routeFingerprint: sha256(canonicalJson(publicationRoute))
      },
      pullRequestBindingReceiptSha256: 'f'.repeat(64),
      runId,
      stageDispositions: stageEvidence.map((entry) => ({
        disposition: 'satisfied' as const,
        evidenceSha256: entry.evidenceSha256,
        stage: entry.stage
      })),
      stagePlan: ['push', 'pr'].map((stage) => ({
        requirement: 'required' as const,
        stage
      }))
    })

    assert.throws(
      () => ledger.finalizePassedRun(manifest, candidate, {
        branch: 'feature',
        generationToken,
        repoRoot: '/repo'
      }),
      /does not match retained ledger facts/
    )
    assert.equal(ledger.runStatus(runId), 'in-progress')
    const lease = ledger.leaseFor('/repo', 'feature')
    assert.equal(lease?.generation_token, generationToken)
    assert.equal(lease?.run_id, runId)
    assert.equal(ledger.findCompletionAttestation(runId), undefined)
  } finally {
    ledger.close()
  }
})
