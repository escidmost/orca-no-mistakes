import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { DomainLedger, repositoryLedgerPath } from '../scripts/ledger.ts'

const commit = 'a'.repeat(40)
const policy = 'b'.repeat(64)
const stages = [{ requirement: 'required' as const, stageId: 'intent' }]

test('terminal failed runs reject resolved mutation intent insertion', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-term-res-fail-'))
  const dbPath = path.join(temp, 'ledger.sqlite')
  const ledger = new DomainLedger(dbPath)
  try {
    const runId = 'term-failed-run'
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Verify terminal fence for failed runs.',
      policySha256: policy,
      repoRoot: '/repo',
      runId,
      stagePlan: stages,
      submissionCommitOid: commit
    })
    const token = ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId })
    const attemptId = 'attempt-1'
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId,
      coordinatorIdentity: 'coordinator',
      generationToken: token,
      runId,
      startedAt: new Date().toISOString()
    })
    const intentSha256 = ledger.recordMutationIntent({
      attemptId,
      createdAt: new Date().toISOString(),
      kind: 'managed-comment',
      payload: { test: true },
      runId,
      targetFingerprint: 'target-1'
    })
    ledger.finishRun(runId, 'failed')
    assert.throws(
      () => ledger.resolveMutationIntent({
        attemptId,
        intentSha256,
        reason: 'definite-failure',
        runId
      }),
      /cannot add Release 2 facts to a terminal run/
    )
  } finally {
    ledger.close()
    await rm(temp, { force: true, recursive: true })
  }
})

test('terminal cancelled runs reject resolved mutation intent insertion', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-term-res-cancel-'))
  const dbPath = path.join(temp, 'ledger.sqlite')
  const ledger = new DomainLedger(dbPath)
  try {
    const runId = 'term-cancelled-run'
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Verify terminal fence for cancelled runs.',
      policySha256: policy,
      repoRoot: '/repo',
      runId,
      stagePlan: stages,
      submissionCommitOid: commit
    })
    const token = ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId })
    const attemptId = 'attempt-1'
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId,
      coordinatorIdentity: 'coordinator',
      generationToken: token,
      runId,
      startedAt: new Date().toISOString()
    })
    const intentSha256 = ledger.recordMutationIntent({
      attemptId,
      createdAt: new Date().toISOString(),
      kind: 'managed-comment',
      payload: { test: true },
      runId,
      targetFingerprint: 'target-1'
    })
    ledger.finishRun(runId, 'cancelled')
    assert.throws(
      () => ledger.resolveMutationIntent({
        attemptId,
        intentSha256,
        reason: 'lease-lost',
        runId
      }),
      /cannot add Release 2 facts to a terminal run/
    )

    const raw = new DatabaseSync(dbPath)
    try {
      assert.throws(
        () => raw.prepare(
          `INSERT INTO resolved_mutation_intents (
             resolution_id, run_id, attempt_id, intent_sha256, reason, resolved_at
           ) VALUES (?, ?, ?, ?, ?, ?)`
        ).run('res-id-direct', runId, attemptId, intentSha256, 'lease-lost', new Date().toISOString()),
        /cannot add Release 2 facts to a terminal run/
      )
    } finally {
      raw.close()
    }
  } finally {
    ledger.close()
    await rm(temp, { force: true, recursive: true })
  }
})

test('repository migration imports resolved mutation intents', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-migrated-res-intent-'))
  const repo = path.join(temp, 'repo')
  const legacyDir = path.join(temp, 'legacy')
  const legacyPath = path.join(legacyDir, 'ledger.db')
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
    const repoRoot = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8'
    }).trim()

    await mkdir(legacyDir, { recursive: true })
    const legacy = new DomainLedger(legacyPath)
    const runId = 'legacy-res-run'
    legacy.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Migrate resolved mutation intent.',
      policySha256: policy,
      repoRoot,
      runId,
      stagePlan: stages,
      submissionCommitOid: commit
    })
    const token = legacy.acquireLease({ branch: 'feature', repoRoot, runId })
    const attemptId = 'attempt-1'
    legacy.startAttempt({
      actorIdentity: 'operator',
      attemptId,
      coordinatorIdentity: 'coordinator',
      generationToken: token,
      runId,
      startedAt: new Date().toISOString()
    })
    const intentSha256 = legacy.recordMutationIntent({
      attemptId,
      createdAt: new Date().toISOString(),
      kind: 'managed-comment',
      payload: { test: true },
      runId,
      targetFingerprint: 'target-1'
    })
    legacy.resolveMutationIntent({
      attemptId,
      intentSha256,
      reason: 'definite-failure',
      runId
    })
    legacy.releaseLease(runId)
    legacy.finishRun(runId, 'failed')
    legacy.close()

    const migrated = new DomainLedger({ legacyPath, repositoryPath: repo })
    migrated.close()

    const destination = new DatabaseSync(repositoryLedgerPath(repo))
    try {
      const rows = destination.prepare(
        'SELECT * FROM resolved_mutation_intents WHERE run_id = ?'
      ).all(runId) as Array<{ intent_sha256: string; reason: string }>
      assert.equal(rows.length, 1)
      assert.equal(rows[0].intent_sha256, intentSha256)
      assert.equal(rows[0].reason, 'definite-failure')
    } finally {
      destination.close()
    }
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
