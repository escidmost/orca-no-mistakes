import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'

import { DomainLedger } from '../scripts/ledger.ts'

const commit = 'a'.repeat(40)
const policy = 'b'.repeat(64)
const exited = spawnSync(process.execPath, ['-e', ''])
assert.equal(exited.status, 0)
const deadCoordinator = `no-mistakes:${exited.pid}`

function fixture(t: TestContext, coordinatorIdentity: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'onm-pre-attempt-abandon-'))
  const dbPath = path.join(root, 'ledger.sqlite')
  const ledger = new DomainLedger(dbPath)
  const db = new DatabaseSync(dbPath)
  t.after(() => { db.close(); ledger.close(); rmSync(root, { recursive: true, force: true }) })
  ledger.startRun({ repoRoot: root, runId: 'run', branch: 'feature', baseBranch: 'main',
    coordinatorIdentity, intent: 'Recover a pre-attempt crash', policySha256: policy,
    submissionCommitOid: commit })
  const abandon = () => ledger.abandonRun({ runId: 'run', reason: 'Coordinator exited', actorIdentity: 'operator' })
  return { abandon, db, ledger, root }
}

test('a dead initial coordinator permits pre-attempt abandonment', (t) => {
  const { abandon, db, ledger } = fixture(t, deadCoordinator)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM run_attempts').get()?.count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM branch_leases').get()?.count, 0)

  abandon()

  assert.equal(ledger.run('run')?.status, 'cancelled')
  const audit = db.prepare(
    'SELECT coordinator_identity, generation_token FROM run_abandonments',
  ).get() as { coordinator_identity: string; generation_token: number }
  assert.equal(audit.coordinator_identity, deadCoordinator)
  assert.equal(audit.generation_token, 0)
})

test('live, uncertain, and legacy initial ownership remains fail-closed', (t) => {
  const live = fixture(t, `no-mistakes:${process.pid}`)
  assert.throws(live.abandon, /still present/)

  const uncertain = fixture(t, deadCoordinator)
  const probe = t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
  })
  assert.throws(uncertain.abandon, /permission denied/)
  probe.mock.restore()

  const legacy = fixture(t, deadCoordinator)
  legacy.db.exec('DROP TRIGGER freeze_initial_coordinator_identity')
  legacy.db.exec("UPDATE runs SET initial_coordinator_identity = ''")
  assert.throws(legacy.abandon, /no verifiable local coordinator PID/)
})

test('pre-attempt leases and resume claims block abandonment', (t) => {
  const { abandon, db, ledger, root } = fixture(t, deadCoordinator)
  const generation = ledger.acquireLease({ repoRoot: root, branch: 'feature', runId: 'run' })
  assert.throws(abandon, /unrecorded lease owner/)

  ledger.releaseLease('run')
  db.prepare('INSERT INTO resume_claims VALUES (?, ?, ?)').run('run', 'claim', generation + 1)
  assert.throws(abandon, /pending resume claim/)
  assert.equal(ledger.run('run')?.status, 'in-progress')
})

test('latest attempt ownership supersedes initial ownership', (t) => {
  const deadAttempt = fixture(t, `no-mistakes:${process.pid}`)
  const deadGeneration = deadAttempt.ledger.acquireLease({
    repoRoot: deadAttempt.root, branch: 'feature', runId: 'run',
  })
  deadAttempt.ledger.startAttempt({ runId: 'run', attemptId: 'attempt',
    coordinatorIdentity: deadCoordinator, actorIdentity: 'operator',
    generationToken: deadGeneration, startedAt: new Date().toISOString() })
  deadAttempt.abandon()
  assert.equal(deadAttempt.ledger.run('run')?.status, 'cancelled')

  const liveAttempt = fixture(t, deadCoordinator)
  const liveGeneration = liveAttempt.ledger.acquireLease({
    repoRoot: liveAttempt.root, branch: 'feature', runId: 'run',
  })
  liveAttempt.ledger.startAttempt({ runId: 'run', attemptId: 'attempt',
    coordinatorIdentity: `no-mistakes:${process.pid}`, actorIdentity: 'operator',
    generationToken: liveGeneration, startedAt: new Date().toISOString() })
  assert.throws(liveAttempt.abandon, /still present/)
  assert.equal(liveAttempt.ledger.run('run')?.status, 'in-progress')
})
