import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { DomainLedger, legacyLedgerPath } from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const commit = 'a'.repeat(40)
const policy = 'b'.repeat(64)
const deadCoordinator = () => {
  const exited = spawnSync(process.execPath, ['-e', ''])
  assert.equal(exited.status, 0)
  return `no-mistakes:${exited.pid}`
}

test('abandonment permits an identical admission to launch a fresh run', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'onm-abandon-admission-'))
  const dbPath = path.join(root, 'ledger.sqlite')
  const ledger = new DomainLedger(dbPath)
  const db = new DatabaseSync(dbPath)
  t.after(() => { db.close(); ledger.close(); rmSync(root, { recursive: true, force: true }) })

  const admission = {
    admissionId: `admission-${'c'.repeat(64)}`,
    gateIdentity: 'gate',
    intent: 'Retry the same candidate after explicit abandonment.',
    newOid: commit,
    oldOid: commit,
    refName: 'refs/heads/feature',
    repoRoot: root,
    source: 'direct' as const,
  }
  ledger.beginSubmissionAdmission(admission)
  ledger.startRun({ repoRoot: root, runId: 'old-run', branch: 'feature', baseBranch: 'main',
    intent: admission.intent, policySha256: policy, submissionCommitOid: commit })
  ledger.bindSubmissionAdmission(admission.admissionId, 'old-run')
  const generationToken = ledger.acquireLease({ repoRoot: root, branch: 'feature', runId: 'old-run' })
  ledger.startAttempt({ runId: 'old-run', attemptId: 'old-attempt', coordinatorIdentity: deadCoordinator(),
    actorIdentity: 'operator', generationToken, startedAt: new Date().toISOString() })
  ledger.markSubmissionAccepted({ acceptedOid: commit, admissionId: admission.admissionId, runId: 'old-run' })
  const attempt = db.prepare('SELECT * FROM run_attempts WHERE run_id = ?').get('old-run')

  ledger.abandonRun({ runId: 'old-run', reason: 'Coordinator exited', actorIdentity: 'operator' })
  const retry = ledger.beginSubmissionAdmission(admission)
  assert.equal(retry.status, 'pending')
  assert.equal(retry.run_id, null)
  ledger.startRun({ repoRoot: root, runId: 'new-run', branch: 'feature', baseBranch: 'main',
    intent: admission.intent, policySha256: policy, submissionCommitOid: commit })
  assert.equal(ledger.bindSubmissionAdmission(admission.admissionId, 'new-run').run_id, 'new-run')
  assert.equal(ledger.run('old-run')?.status, 'cancelled')
  assert.deepEqual(db.prepare('SELECT * FROM run_attempts WHERE run_id = ?').get('old-run'), attempt)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM run_abandonments WHERE run_id = ?').get('old-run')?.count, 1)
})

test('explicit invalid abandon repository does not mutate the legacy ledger', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'onm-abandon-repo-'))
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  process.env.ORCA_NO_MISTAKES_HOME = path.join(root, 'home')
  t.after(() => {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  })

  const legacy = new DomainLedger(legacyLedgerPath())
  legacy.startRun({ repoRoot: '/legacy/repo', runId: 'legacy-run', branch: 'feature', baseBranch: 'main',
    intent: 'Retain the legacy run.', policySha256: policy, submissionCommitOid: commit })
  const generationToken = legacy.acquireLease({ repoRoot: '/legacy/repo', branch: 'feature', runId: 'legacy-run' })
  legacy.startAttempt({ runId: 'legacy-run', attemptId: 'legacy-attempt', coordinatorIdentity: deadCoordinator(),
    actorIdentity: 'operator', generationToken, startedAt: new Date().toISOString() })
  legacy.close()

  await assert.rejects(
    main(['abandon', '--repo', path.join(root, 'missing'), '--run-id', 'legacy-run', '--reason', 'Wrong repository']),
    /cannot change to|not a git repository/i,
  )
  const retained = new DomainLedger(legacyLedgerPath())
  assert.equal(retained.run('legacy-run')?.status, 'in-progress')
  assert.equal(retained.leaseFor('/legacy/repo', 'feature')?.run_id, 'legacy-run')
  retained.close()
})
