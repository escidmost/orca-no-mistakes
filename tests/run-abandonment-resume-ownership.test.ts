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
const effectivePolicy = 'c'.repeat(64)
const exited = spawnSync(process.execPath, ['-e', ''])
assert.equal(exited.status, 0)
const deadCoordinator = `no-mistakes:${exited.pid}`

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'onm-resume-owner-'))
  const dbPath = path.join(root, 'ledger.sqlite')
  const ledger = new DomainLedger(dbPath)
  const db = new DatabaseSync(dbPath)
  t.after(() => { db.close(); ledger.close(); rmSync(root, { recursive: true, force: true }) })
  ledger.startRun({ repoRoot: root, runId: 'run', branch: 'feature', baseBranch: 'main',
    coordinatorIdentity: deadCoordinator, intent: 'Recover interrupted resume', policySha256: policy,
    submissionCommitOid: commit })
  const firstGeneration = ledger.acquireLease({ repoRoot: root, branch: 'feature', runId: 'run' })
  ledger.startAttempt({ runId: 'run', attemptId: 'first', coordinatorIdentity: deadCoordinator,
    actorIdentity: 'operator', generationToken: firstGeneration, startedAt: new Date().toISOString() })
  ledger.recordCheckpoint({ runId: 'run', stageId: 'intent', roundIndex: 0,
    inputCommitOid: commit, outputCommitOid: commit })
  assert.equal(ledger.settleRun('run', 'failed', {
    repoRoot: root, branch: 'feature', generationToken: firstGeneration,
  }), true)
  const prepare = (coordinatorIdentity: string) => ledger.prepareResume({
    repoRoot: root, runId: 'run', branch: 'feature', baseBranch: 'main', head: commit,
    intent: 'Recover interrupted resume', policySha256: policy,
    effectivePolicyHash: effectivePolicy, coordinatorIdentity,
  })
  const resume = (claim: ReturnType<typeof prepare>, coordinatorIdentity: string) =>
    ledger.resumeRun({ repoRoot: root, runId: 'run', branch: 'feature', baseBranch: 'main',
      head: commit, intent: 'Recover interrupted resume', policySha256: policy,
      effectivePolicyHash: effectivePolicy, claimId: claim.claimId, coordinatorIdentity })
  const abandon = () => ledger.abandonRun({
    runId: 'run', reason: 'Resume coordinator exited', actorIdentity: 'operator',
  })
  return { abandon, db, ledger, prepare, resume, root }
}

test('dead resume owner can be abandoned before activation', (t) => {
  const { abandon, db, ledger, prepare } = fixture(t)
  const claim = prepare(deadCoordinator)

  abandon()

  assert.equal(ledger.runStatus('run'), 'cancelled')
  const audit = db.prepare(
    'SELECT coordinator_identity, generation_token FROM run_abandonments',
  ).get() as { coordinator_identity: string; generation_token: number }
  assert.equal(audit.coordinator_identity, deadCoordinator)
  assert.equal(audit.generation_token, claim.generationToken)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM resume_claims').get()?.count, 0)
})

test('dead resume owner can be abandoned after activation but before its attempt', (t) => {
  const { abandon, db, ledger, prepare, resume } = fixture(t)
  const claim = prepare(deadCoordinator)
  resume(claim, deadCoordinator)

  abandon()

  assert.equal(ledger.runStatus('run'), 'cancelled')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM branch_leases').get()?.count, 0)
  assert.equal(db.prepare('SELECT generation_token FROM run_abandonments').get()?.generation_token,
    claim.generationToken)
})

test('previous coordinator death cannot prove a live resume owner dead', (t) => {
  const { abandon, ledger, prepare, resume } = fixture(t)
  const liveCoordinator = `no-mistakes:${process.pid}`
  const claim = prepare(liveCoordinator)
  resume(claim, liveCoordinator)

  assert.throws(abandon, /still present/)
  assert.equal(ledger.runStatus('run'), 'in-progress')
})

test('stale resume ownership cannot release a newer lease generation', (t) => {
  const { abandon, db, ledger, prepare, resume } = fixture(t)
  const claim = prepare(deadCoordinator)
  resume(claim, deadCoordinator)
  db.prepare('UPDATE branch_leases SET generation_token = ?').run(claim.generationToken + 1)

  assert.throws(abandon, /resume ownership is stale or mismatched/)
  assert.equal(ledger.runStatus('run'), 'in-progress')
  assert.equal(db.prepare('SELECT generation_token FROM branch_leases').get()?.generation_token,
    claim.generationToken + 1)
})

test('abandoning a dead resumed run preserves its replacement lease after force takeover', (t) => {
  const { abandon, db, ledger, prepare, resume, root } = fixture(t)
  const claim = prepare(deadCoordinator)
  resume(claim, deadCoordinator)
  ledger.startRun({ repoRoot: root, runId: 'replacement', branch: 'feature', baseBranch: 'main',
    intent: 'Continue after the old coordinator died', policySha256: policy, submissionCommitOid: commit })
  const generation = ledger.acquireLease({ repoRoot: root, branch: 'feature', runId: 'replacement', force: true })
  const replacementLease = db.prepare('SELECT * FROM branch_leases').get()
  const priorAttempt = db.prepare('SELECT * FROM run_attempts').get()

  abandon()

  assert.equal(ledger.runStatus('run'), 'cancelled')
  assert.equal(ledger.runStatus('replacement'), 'in-progress')
  assert.ok(generation > claim.generationToken)
  assert.deepEqual(db.prepare('SELECT * FROM branch_leases').get(), replacementLease)
  assert.deepEqual(db.prepare('SELECT * FROM run_attempts').get(), priorAttempt)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM resume_claims').get()?.count, 0)
  assert.equal(db.prepare('SELECT generation_token FROM run_abandonments').get()?.generation_token,
    claim.generationToken)
})

test('resume activation rejects a different coordinator identity', (t) => {
  const { ledger, prepare, resume } = fixture(t)
  const claim = prepare(deadCoordinator)

  assert.throws(() => resume(claim, `no-mistakes:${process.pid}`), /belongs to another coordinator/)
  assert.equal(ledger.runStatus('run'), 'failed')
})

test('resume preparation preserves live and uncertain claims and permits same-owner re-preparation', (t) => {
  const { db, prepare, resume } = fixture(t)
  const live = `no-mistakes:${process.pid}`
  prepare(live)
  const claim = prepare(live)
  const before = db.prepare('SELECT * FROM resume_claims').get()
  const owner = db.prepare('SELECT * FROM resume_claim_owners').get()
  assert.throws(() => prepare(deadCoordinator), /still present/)
  const probe = t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
  })
  assert.throws(() => prepare(deadCoordinator), /permission denied/)
  probe.mock.restore()
  assert.deepEqual(db.prepare('SELECT * FROM resume_claims').get(), before)
  assert.deepEqual(db.prepare('SELECT * FROM resume_claim_owners').get(), owner)
  resume(claim, live)
})

test('resume preparation replaces only a provably dead owner and fences the old claim', (t) => {
  const { ledger, prepare, resume } = fixture(t)
  const old = prepare(deadCoordinator)
  const live = `no-mistakes:${process.pid}`
  const replacement = prepare(live)
  assert.ok(replacement.generationToken > old.generationToken)
  assert.throws(() => resume(old, deadCoordinator), /no matching resume claim/)
  resume(replacement, live)
  assert.equal(ledger.runStatus('run'), 'in-progress')
})

test('resume preparation refuses missing or mismatched pending ownership', (t) => {
  const { db, prepare } = fixture(t)
  prepare(deadCoordinator)
  db.exec('UPDATE resume_claim_owners SET generation_token = generation_token + 1')
  const before = db.prepare('SELECT * FROM resume_claims').get()
  assert.throws(() => prepare(`no-mistakes:${process.pid}`), /no verifiable local coordinator PID/)
  assert.deepEqual(db.prepare('SELECT * FROM resume_claims').get(), before)
  db.exec('DELETE FROM resume_claim_owners')
  assert.throws(() => prepare(`no-mistakes:${process.pid}`), /no verifiable local coordinator PID/)
  assert.deepEqual(db.prepare('SELECT * FROM resume_claims').get(), before)
})
