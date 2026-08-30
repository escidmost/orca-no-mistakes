import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  DomainLedger,
  buildAttestation,
  repositoryLedgerPath,
  type StageEvidenceManifestEntry
} from '../scripts/ledger.ts'

const commit = 'a'.repeat(40)
const policy = 'b'.repeat(64)

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

test('repository ledger migration is transactional, idempotent, and preserves Release 1 history', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-ledger-migration-'))
  const repo = path.join(temp, 'repo')
  const legacyPath = path.join(temp, 'legacy', 'ledger.db')
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
    const repoRoot = git(repo, 'rev-parse', '--show-toplevel')
    const legacy = new DomainLedger(legacyPath)

    legacy.startRun({
      baseBranch: 'main',
      branch: 'active',
      intent: 'Active run blocks migration.',
      policySha256: policy,
      repoRoot,
      runId: 'active-run',
      submissionCommitOid: commit
    })
    assert.throws(
      () => new DomainLedger({ legacyPath, repositoryPath: repo }),
      /finish, cancel, or recover it through the legacy ledger before retrying migration/
    )

    legacy.finishRun('active-run', 'failed')
    legacy.acquireLease({ branch: 'active', repoRoot, runId: 'active-run' })
    assert.throws(
      () => new DomainLedger({ legacyPath, repositoryPath: repo }),
      /live semantic lease/
    )
    legacy.releaseLease('active-run')

    const failedRunId = 'failed-release-1'
    legacy.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Resume the migrated Release 1 run.',
      policySha256: policy,
      repoRoot,
      runId: failedRunId,
      submissionCommitOid: commit
    })
    legacy.recordCheckpoint({
      inputCommitOid: commit,
      outputCommitOid: commit,
      roundIndex: 0,
      runId: failedRunId,
      stageId: 'lint'
    })
    legacy.finishRun(failedRunId, 'failed')

    const passedRunId = 'passed-release-1'
    legacy.startRun({
      baseBranch: 'main',
      branch: 'passed',
      intent: 'Preserve the historical manifest.',
      policySha256: policy,
      repoRoot,
      runId: passedRunId,
      submissionCommitOid: commit
    })
    const entries: StageEvidenceManifestEntry[] = []
    const manifest = buildAttestation(entries, {
      baseCommitOid: commit,
      candidateCommitOid: commit,
      guardrailMode: 'strict',
      intent: 'Preserve the historical manifest.',
      policySha256: policy,
      runId: passedRunId
    })
    legacy.finishRun(passedRunId, 'passed', commit)
    legacy.recordAttestation(manifest)
    legacy.close()

    const historicalBytes = `${JSON.stringify(manifest, null, 2)}\n`
    const legacyDb = new DatabaseSync(legacyPath)
    legacyDb.prepare('UPDATE passed_attestations SET manifest_json = ? WHERE run_id = ?')
      .run(historicalBytes, passedRunId)
    legacyDb.close()

    let migrated = new DomainLedger({ legacyPath, repositoryPath: repo })
    assert.equal(migrated.path, repositoryLedgerPath(repo))
    assert.equal(migrated.runStatus(passedRunId), 'passed')
    assert.deepEqual(migrated.findAttestation(passedRunId), manifest)
    assert.deepEqual(
      migrated.stagePlan(failedRunId).map(({ requirement, stage_id }) => [stage_id, requirement]),
      [
        ['intent', 'required'],
        ['rebase', 'required'],
        ['review', 'required'],
        ['test', 'required'],
        ['document', 'required'],
        ['lint', 'required']
      ]
    )
    assert.equal(
      migrated.prepareResume({
        baseBranch: 'main',
        branch: 'feature',
        effectivePolicyHash: policy,
        head: commit,
        intent: 'Resume the migrated Release 1 run.',
        policySha256: policy,
        repoRoot,
        runId: failedRunId
      }).checkpoint.stage_id,
      'lint'
    )
    migrated.close()

    const repositoryDb = new DatabaseSync(repositoryLedgerPath(repo))
    const stored = repositoryDb.prepare(
      'SELECT manifest_json FROM passed_attestations WHERE run_id = ?'
    ).get(passedRunId) as { manifest_json: string }
    assert.equal(stored.manifest_json, historicalBytes)
    repositoryDb.prepare('DELETE FROM repository_migrations').run()
    repositoryDb.close()

    migrated = new DomainLedger({ legacyPath, repositoryPath: repo })
    assert.equal(migrated.listRuns().length, 3)
    migrated.close()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
