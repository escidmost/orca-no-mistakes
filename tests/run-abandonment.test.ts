import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'

import { DomainLedger } from '../scripts/ledger.ts'

const commit = 'a'.repeat(40)
const policy = 'b'.repeat(64)
const timestamp = '2026-09-14T00:00:00.000Z'
const exited = spawnSync(process.execPath, ['-e', ''])
assert.equal(exited.status, 0)
const deadIdentity = `no-mistakes:${exited.pid}`

function fixture(t: TestContext, coordinatorIdentity = deadIdentity) {
  const repoRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'onm-abandon-')))
  execFileSync('git', ['init', '--quiet', repoRoot])
  const dbPath = path.join(repoRoot, '.git', 'orca-no-mistakes', 'ledger.sqlite')
  const ledger = new DomainLedger(dbPath)
  const db = new DatabaseSync(dbPath)
  t.after(() => { db.close(); ledger.close(); rmSync(repoRoot, { recursive: true, force: true }) })
  const route = {
    repoRoot, actorId: 'actor', actorLogin: 'operator', actorNodeId: 'actor-node',
    backend: 'gh' as const, backendVersion: '2', credentialSource: 'stored-account' as const,
    forgeHost: 'github.com' as const, baseBranch: 'main', headBranch: 'feature',
    baseRepositoryId: '1', baseRepositoryName: 'old/repo', baseRepositoryNodeId: 'node',
    headRepositoryId: '1', headRepositoryName: 'old/repo', headRepositoryNodeId: 'node',
    networkRootRepositoryId: '1', headOwner: 'old', observedAt: timestamp,
  }
  ledger.setRepositoryPublicationRoute(route)
  ledger.startRun({ repoRoot, runId: 'old-run', branch: 'feature', baseBranch: 'main',
    intent: 'Keep evidence while closing old work', policySha256: policy, submissionCommitOid: commit })
  const generationToken = ledger.acquireLease({ repoRoot, branch: 'feature', runId: 'old-run' })
  ledger.startAttempt({ runId: 'old-run', attemptId: 'attempt', coordinatorIdentity,
    actorIdentity: 'operator', generationToken, startedAt: timestamp })
  const abandon = () => ledger.abandonRun({ runId: 'old-run', reason: 'Operator closes old work', actorIdentity: 'operator' })
  return { repoRoot, ledger, db, route, generationToken, abandon, coordinatorIdentity }
}

test('abandonment closes resumability and route dependencies without rewriting evidence', (t) => {
  const { ledger, db, route, abandon, coordinatorIdentity, repoRoot } = fixture(t)
  ledger.recordAttemptOutcome({ runId: 'old-run', attemptId: 'attempt', coordinatorIdentity,
    actorIdentity: 'operator', candidateCommitOid: commit, completedAt: timestamp, custody: {},
    receiptDigests: [], resumeEligible: true, verdict: 'failed', stoppingFact: 'ci', reason: 'Interrupted' })
  ledger.settleRun('old-run', 'failed')
  const facts = () => ['run_attempts', 'attempt_outcomes', 'publication_routes', 'stage_plan_entries']
    .map(table => db.prepare(`SELECT * FROM ${table}`).all())
  const before = facts()
  const artifact = path.join(repoRoot, 'retained-evidence.txt')
  writeFileSync(artifact, 'retained evidence')
  assert.throws(() => ledger.setRepositoryPublicationRoute({ ...route, headOwner: 'new' }), /retained ledger state/)
  abandon()
  abandon() // Retries preserve the original audit.
  assert.equal(ledger.run('old-run')?.status, 'cancelled')
  assert.deepEqual(facts(), before)
  assert.equal(readFileSync(artifact, 'utf8'), 'retained evidence')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_abandonments').get()?.n, 1)
  assert.throws(() => db.exec("UPDATE run_abandonments SET reason = 'rewrite'"), /immutable/)
  assert.throws(() => db.exec('DELETE FROM run_abandonments'), /immutable/)
  assert.throws(() => ledger.prepareResume({ runId: 'old-run', repoRoot, branch: 'feature', baseBranch: 'main',
    head: commit, intent: 'Keep evidence while closing old work', policySha256: policy, effectivePolicyHash: policy }), /cannot resume from status cancelled/)
  ledger.setRepositoryPublicationRoute({ ...route, headOwner: 'new' })
  const archive = path.join(repoRoot, 'archive.sqlite')
  const audit = db.prepare('SELECT * FROM run_abandonments').all()
  db.prepare('VACUUM INTO ?').run(archive)
  assert.equal(ledger.prune(['old-run']), 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_abandonments').get()?.n, 0)
  const migrated = new DomainLedger({ repositoryPath: repoRoot, legacyPath: archive })
  migrated.close()
  assert.deepEqual(db.prepare('SELECT * FROM run_abandonments').all(), audit)
  assert.deepEqual(facts(), before)
})

test('CLI abandons a dead in-progress run and releases its lease without deleting history', (t) => {
  const { repoRoot, ledger, db } = fixture(t)
  const output = execFileSync(process.execPath, ['scripts/orca-no-mistakes.ts', 'abandon',
    '--repo', repoRoot, '--run-id', 'old-run', '--reason', 'Explicit closeout'], {
    encoding: 'utf8', env: { ...process.env, ORCA_NO_MISTAKES_HOME: path.join(repoRoot, 'home') },
  })
  assert.deepEqual(JSON.parse(output), { runId: 'old-run', status: 'cancelled', evidenceRetained: true })
  assert.equal(ledger.run('old-run')?.status, 'cancelled')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM branch_leases').get()?.n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_attempts').get()?.n, 1)
  assert.equal(db.prepare('SELECT prior_status FROM run_abandonments').get()?.prior_status, 'in-progress')
})

test('live and uncertain owners cannot be abandoned', (t) => {
  const { ledger, db, abandon } = fixture(t, `no-mistakes:${process.pid}`)
  assert.throws(abandon, /still present/)
  const probe = t.mock.method(process, 'kill', () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }) })
  assert.throws(abandon, /permission denied/)
  probe.mock.restore()
  assert.equal(ledger.run('old-run')?.status, 'in-progress')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_abandonments').get()?.n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM branch_leases').get()?.n, 1)
})

test('unknown coordinator identity cannot be treated as a dead process', (t) => {
  assert.throws(fixture(t, 'remote-coordinator').abandon, /no verifiable local coordinator PID/)
})

test('pending resume and newer lease generations block closeout', (t) => {
  const { db, abandon, generationToken } = fixture(t)
  db.prepare('INSERT INTO resume_claims VALUES (?, ?, ?)').run('old-run', 'claim', generationToken + 1)
  assert.throws(abandon, /pending resume claim/)
  db.exec('DELETE FROM resume_claims')
  db.prepare('UPDATE branch_leases SET generation_token = ?').run(generationToken + 1)
  assert.throws(abandon, /unrecorded lease owner/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_abandonments').get()?.n, 0)
})

test('abandonment does not release a newer run lease on the same branch', (t) => {
  const { ledger, repoRoot, db, abandon } = fixture(t)
  ledger.startRun({ repoRoot, runId: 'new-run', branch: 'feature', baseBranch: 'main',
    intent: 'New work', policySha256: policy, submissionCommitOid: commit })
  ledger.acquireLease({ repoRoot, branch: 'feature', runId: 'new-run', force: true })
  abandon()
  assert.equal(db.prepare('SELECT run_id FROM branch_leases').get()?.run_id, 'new-run')
  assert.equal(ledger.run('new-run')?.status, 'in-progress')
})
