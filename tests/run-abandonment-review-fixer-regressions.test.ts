import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { DomainLedger } from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const commit = 'a'.repeat(40)
const policy = 'b'.repeat(64)

test('abandon fails closed on marker inspection errors but permits parsed nonmatching markers', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'onm-abandon-unreadable-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet', root])
  const exited = spawnSync(process.execPath, ['-e', ''])
  assert.equal(exited.status, 0)

  const ledger = new DomainLedger({ repositoryPath: root })
  ledger.startRun({ repoRoot: root, runId: 'run', branch: 'feature', baseBranch: 'main',
    intent: 'Report unreadable markers', policySha256: policy, submissionCommitOid: commit })
  const generationToken = ledger.acquireLease({ repoRoot: root, branch: 'feature', runId: 'run' })
  ledger.startAttempt({ runId: 'run', attemptId: 'attempt', coordinatorIdentity: `no-mistakes:${exited.pid}`,
    actorIdentity: 'operator', generationToken, startedAt: new Date().toISOString() })
  ledger.close()

  const markersDir = path.join(root, '.orca', 'no-mistakes')
  mkdirSync(markersDir, { recursive: true })
  const markerPath = path.join(markersDir, 'gate-broken.json')
  const abandon = () => main(['abandon', '--repo', root, '--run-id', 'run', '--reason', 'Close dead run'])
  const db = new DatabaseSync(path.join(root, '.git', 'orca-no-mistakes', 'ledger.sqlite'))
  t.after(() => db.close())
  const beforeRun = db.prepare('SELECT * FROM runs').get()
  const beforeLease = db.prepare('SELECT * FROM branch_leases').get()
  for (const failure of ['parse', 'read']) {
    if (failure === 'parse') writeFileSync(markerPath, '{')
    else mkdirSync(markerPath)
    await assert.rejects(abandon, /marker gate-broken.json could not be read or parsed/)
    assert.deepEqual(db.prepare('SELECT * FROM runs').get(), beforeRun)
    assert.deepEqual(db.prepare('SELECT * FROM branch_leases').get(), beforeLease)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM run_abandonments').get()?.count, 0)
    rmSync(markerPath, { recursive: true })
  }
  writeFileSync(markerPath, 'null')
  writeFileSync(path.join(markersDir, 'gate-other.json'), JSON.stringify({ runId: 'another-run' }))
  await abandon()
  const reopened = new DomainLedger({ repositoryPath: root })
  assert.equal(reopened.runStatus('run'), 'cancelled')
  reopened.close()
})

test('additive coordinator identity migration matches the fresh schema', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'onm-coordinator-schema-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dbPath = path.join(root, 'ledger.sqlite')
  new DomainLedger(dbPath).close()

  const legacyDb = new DatabaseSync(dbPath)
  legacyDb.exec('DROP TRIGGER freeze_initial_coordinator_identity')
  legacyDb.exec('ALTER TABLE runs DROP COLUMN initial_coordinator_identity')
  legacyDb.close()
  new DomainLedger(dbPath).close()

  const migratedDb = new DatabaseSync(dbPath)
  const column = migratedDb.prepare(
    `SELECT "notnull" AS is_required, dflt_value AS defaultValue
     FROM pragma_table_info('runs') WHERE name = 'initial_coordinator_identity'`,
  ).get() as { defaultValue: string; is_required: number }
  assert.equal(column.is_required, 1)
  assert.equal(column.defaultValue, "''")
  migratedDb.close()
})
