import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { DomainLedger, repositoryLedgerPath } from '../scripts/ledger.ts'

test('repository migration imports legacy runs without coordinator ownership', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-legacy-coordinator-'))
  const repo = path.join(temp, 'repo')
  const legacyPath = path.join(temp, 'legacy', 'ledger.db')
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repo,
      encoding: 'utf8'
    }).trim()
    const legacy = new DomainLedger(legacyPath)
    legacy.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Retain legacy history.',
      policySha256: 'b'.repeat(64),
      repoRoot,
      runId: 'legacy-run',
      submissionCommitOid: 'a'.repeat(40)
    })
    legacy.finishRun('legacy-run', 'failed')
    legacy.close()

    const legacyDb = new DatabaseSync(legacyPath)
    legacyDb.exec('DROP TRIGGER freeze_initial_coordinator_identity')
    legacyDb.exec('ALTER TABLE runs DROP COLUMN initial_coordinator_identity')
    legacyDb.close()

    const migrated = new DomainLedger({ legacyPath, repositoryPath: repo })
    assert.equal(migrated.runStatus('legacy-run'), 'failed')
    assert.throws(
      () => migrated.abandonRun({
        actorIdentity: 'operator:test',
        reason: 'Prove unverifiable legacy ownership remains fail-closed.',
        runId: 'legacy-run'
      }),
      /has no verifiable local coordinator PID/
    )
    migrated.close()

    const repositoryDb = new DatabaseSync(repositoryLedgerPath(repo))
    const row = repositoryDb.prepare(
      'SELECT initial_coordinator_identity FROM runs WHERE run_id = ?'
    ).get('legacy-run') as { initial_coordinator_identity: string }
    assert.equal(row.initial_coordinator_identity, '')
    repositoryDb.close()
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
