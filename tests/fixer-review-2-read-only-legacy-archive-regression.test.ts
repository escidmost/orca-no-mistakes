import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DomainLedger } from '../scripts/ledger.ts'

test('completed migration reopens with a read-only legacy archive', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-read-only-legacy-'))
  const repo = path.join(temp, 'repo')
  const legacyPath = path.join(temp, 'legacy', 'ledger.db')
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
    const repoRoot = execFileSync(
      'git',
      ['-C', repo, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8' }
    ).trim()
    const legacy = new DomainLedger(legacyPath)
    legacy.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Preserve the retired legacy ledger.',
      policySha256: 'b'.repeat(64),
      repoRoot,
      runId: 'retired-legacy-run',
      submissionCommitOid: 'a'.repeat(40)
    })
    legacy.finishRun('retired-legacy-run', 'failed')
    legacy.close()

    new DomainLedger({ legacyPath, repositoryPath: repo }).close()
    await chmod(legacyPath, 0o444)

    const reopened = new DomainLedger({ legacyPath, repositoryPath: repo })
    assert.equal(reopened.runStatus('retired-legacy-run'), 'failed')
    reopened.close()
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
