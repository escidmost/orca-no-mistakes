import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DomainLedger } from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const commit = '1'.repeat(40)

test('attempt outcomes retain their starting identities', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'onm-outcome-identity-'))
  const ledger = new DomainLedger(path.join(root, 'ledger.db'))
  try {
    const runId = 'run_' + 'a'.repeat(24)
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'verify attempt identity',
      policySha256: '2'.repeat(64),
      repoRoot: root,
      runId,
      submissionCommitOid: commit
    })
    const generationToken = ledger.acquireLease({ branch: 'feature', repoRoot: root, runId })
    ledger.startAttempt({
      actorIdentity: 'actor-a',
      attemptId: 'attempt-1',
      coordinatorIdentity: 'coordinator-a',
      generationToken,
      runId,
      startedAt: '2026-08-30T12:00:01.000Z'
    })
    const outcome = {
      actorIdentity: 'actor-a',
      attemptId: 'attempt-1',
      candidateCommitOid: commit,
      completedAt: '2026-08-30T12:00:02.000Z',
      coordinatorIdentity: 'coordinator-a',
      custody: { recoveryRef: `refs/no-mistakes/recover/${runId}` },
      reason: 'complete',
      receiptDigests: [],
      resumeEligible: false,
      runId,
      stoppingFact: 'complete',
      verdict: 'passed' as const
    }
    assert.throws(
      () => ledger.recordAttemptOutcome({ ...outcome, actorIdentity: 'actor-b' }),
      /identity does not match/
    )
    assert.throws(
      () => ledger.recordAttemptOutcome({ ...outcome, coordinatorIdentity: 'coordinator-b' }),
      /identity does not match/
    )
    assert.equal(ledger.listAttemptOutcomes(runId).length, 0)
    assert.match(ledger.recordAttemptOutcome(outcome), /^[0-9a-f]{64}$/)
  } finally {
    ledger.close()
    rmSync(root, { force: true, recursive: true })
  }
})

test('prune uses a surviving sibling ledger for an asserted missing root', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'onm-prune-missing-root-'))
  const mainRepo = path.join(root, 'main')
  const recordedRoot = path.join(root, 'recorded')
  const siblingRoot = path.join(root, 'sibling')
  const home = path.join(root, 'home')
  const originalCwd = process.cwd()
  const originalHome = process.env.HOME
  const originalLedgerHome = process.env.ORCA_NO_MISTAKES_HOME
  t.after(() => {
    process.chdir(originalCwd)
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalLedgerHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = originalLedgerHome
    rmSync(root, { force: true, recursive: true })
  })

  execFileSync('git', ['init', '-b', 'main', mainRepo], { stdio: 'ignore' })
  execFileSync('git', ['-C', mainRepo, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', mainRepo, 'config', 'user.name', 'Test User'])
  writeFileSync(path.join(mainRepo, 'README.md'), 'test\n')
  execFileSync('git', ['-C', mainRepo, 'add', 'README.md'])
  execFileSync('git', ['-C', mainRepo, 'commit', '-m', 'initial'], { stdio: 'ignore' })
  execFileSync('git', ['-C', mainRepo, 'worktree', 'add', '-b', 'recorded', recordedRoot, 'HEAD'], {
    stdio: 'ignore'
  })
  execFileSync('git', ['-C', mainRepo, 'worktree', 'add', '-b', 'sibling', siblingRoot, 'HEAD'], {
    stdio: 'ignore'
  })

  process.env.HOME = home
  delete process.env.ORCA_NO_MISTAKES_HOME
  const runId = 'run_' + 'b'.repeat(24)
  const repoRoot = realpathSync(recordedRoot)
  const head = execFileSync('git', ['-C', recordedRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  const ledger = new DomainLedger({ repositoryPath: recordedRoot })
  ledger.startRun({
    baseBranch: 'main',
    branch: 'recorded',
    intent: 'prune deleted root',
    policySha256: '3'.repeat(64),
    repoRoot,
    runId,
    submissionCommitOid: head
  })
  assert.equal(ledger.finishRun(runId, 'failed', head), true)
  ledger.close()

  execFileSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', recordedRoot])
  assert.equal(existsSync(recordedRoot), false)
  process.chdir(siblingRoot)
  await main(['prune', `--repo=${recordedRoot}`])

  const retained = new DomainLedger({ repositoryPath: siblingRoot })
  try {
    assert.equal(retained.run(runId), undefined)
  } finally {
    retained.close()
  }
})
