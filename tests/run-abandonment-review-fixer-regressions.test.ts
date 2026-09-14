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

test('abandon reports unreadable markers skipped by its precheck', async (t) => {
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
  writeFileSync(path.join(markersDir, 'gate-broken.json'), '{')
  const warnings: string[] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
  try {
    await main(['abandon', '--repo', root, '--run-id', 'run', '--reason', 'Close dead run'])
  } finally {
    console.error = originalConsoleError
  }

  assert.deepEqual(warnings, [
    'no-mistakes: skipped gate-broken.json during abandon precheck; its marker is unreadable',
  ])
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
