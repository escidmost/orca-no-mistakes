import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  DomainLedger,
  buildPipelineCompletionAttestation,
  canonicalJson,
  evidenceSha256,
  repositoryLedgerPath,
  sha256,
  verifyCompletionAttestation,
  type StageEvidenceManifestEntry
} from '../scripts/ledger.ts'

const commit = 'a'.repeat(40)
const policy = 'b'.repeat(64)

function evidence(runId: string, stage: string, round: number): StageEvidenceManifestEntry {
  const entry: StageEvidenceManifestEntry = {
    artifactSha256: sha256(`${stage}-${round}`),
    baseCommitOid: commit,
    candidateCommitOid: commit,
    evidenceSha256: '',
    exitCode: round === 0 ? 1 : 0,
    round,
    stage,
    summary: `${stage} round ${round}`,
    workerIdentity: 'coordinator'
  }
  entry.evidenceSha256 = evidenceSha256({ ...entry, runId })
  return entry
}

test('v2 attestations select one digest from repeated stage rounds', () => {
  const runId = 'repeated-stage-rounds'
  const entries = [
    evidence(runId, 'review', 0),
    evidence(runId, 'review', 1),
    evidence(runId, 'push', 2),
    evidence(runId, 'pr', 3)
  ]
  const publicationRoute = {
    baseBranch: 'main',
    baseRepositoryId: 'R_base',
    forgeHost: 'github.com',
    headBranch: 'feature',
    headOwner: 'owner',
    headRepositoryId: 'R_head'
  }
  const manifest = buildPipelineCompletionAttestation(entries, {
    attemptOutcomeDigests: [sha256('attempt')],
    baseCommitOid: commit,
    candidateCommitOid: commit,
    candidatePublicationReceiptSha256: sha256('publication'),
    custody: { recoveryRef: `refs/no-mistakes/recover/${runId}` },
    intent: 'Retain every fixer round.',
    policySha256: policy,
    publicationRoute: {
      ...publicationRoute,
      routeFingerprint: sha256(canonicalJson(publicationRoute))
    },
    pullRequestBindingReceiptSha256: sha256('pull-request'),
    runId,
    stageDispositions: [
      { disposition: 'satisfied', evidenceSha256: entries[1].evidenceSha256, stage: 'review' },
      { disposition: 'satisfied', evidenceSha256: entries[2].evidenceSha256, stage: 'push' },
      { disposition: 'satisfied', evidenceSha256: entries[3].evidenceSha256, stage: 'pr' }
    ],
    stagePlan: ['review', 'push', 'pr'].map((stage) => ({
      requirement: 'required' as const,
      stage
    }))
  })

  verifyCompletionAttestation(manifest)
  const wrongStage = structuredClone(manifest)
  wrongStage.stageDispositions[0].evidenceSha256 = entries[2].evidenceSha256
  assert.throws(() => verifyCompletionAttestation(wrongStage), /does not bind its evidence/)

  const incompleteRoute = structuredClone(manifest)
  incompleteRoute.publicationRoute = {
    routeFingerprint: sha256(canonicalJson({}))
  } as typeof incompleteRoute.publicationRoute
  assert.throws(() => verifyCompletionAttestation(incompleteRoute), /publication route is invalid/)
})

test('migration retries absence markers and regenerates checkpoint IDs', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-migration-absence-'))
  const repo = path.join(temp, 'repo')
  const legacyPath = path.join(temp, 'legacy', 'ledger.db')
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
    const repoRoot = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8'
    }).trim()
    const destination = new DomainLedger({ legacyPath, repositoryPath: repo })
    destination.startRun({
      baseBranch: 'main',
      branch: 'local',
      intent: 'Keep repository-local state.',
      policySha256: policy,
      repoRoot,
      runId: 'local-run',
      submissionCommitOid: commit
    })
    destination.recordCheckpoint({
      inputCommitOid: commit,
      outputCommitOid: commit,
      roundIndex: 0,
      runId: 'local-run',
      stageId: 'review'
    })
    destination.finishRun('local-run', 'failed')
    destination.close()

    const legacy = new DomainLedger(legacyPath)
    legacy.startRun({
      baseBranch: 'main',
      branch: 'legacy',
      intent: 'Restore legacy history.',
      policySha256: policy,
      repoRoot,
      runId: 'legacy-run',
      submissionCommitOid: commit
    })
    legacy.recordCheckpoint({
      inputCommitOid: commit,
      outputCommitOid: commit,
      roundIndex: 1,
      runId: 'legacy-run',
      stageId: 'lint'
    })
    legacy.finishRun('legacy-run', 'failed')
    legacy.close()

    const migrated = new DomainLedger({ legacyPath, repositoryPath: repo })
    assert.equal(migrated.runStatus('legacy-run'), 'failed')
    assert.equal(migrated.listCheckpoints('local-run').length, 1)
    assert.equal(migrated.listCheckpoints('legacy-run').length, 1)
    migrated.close()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('migration fails closed on semantic-key conflicts', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-migration-conflict-'))
  const repo = path.join(temp, 'repo')
  const legacyPath = path.join(temp, 'legacy', 'ledger.db')
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
    const repoRoot = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8'
    }).trim()
    const destination = new DomainLedger({ legacyPath, repositoryPath: repo })
    destination.startRun({
      baseBranch: 'main',
      branch: 'local',
      intent: 'Keep the local identity.',
      policySha256: policy,
      repoRoot,
      runId: 'conflicting-run',
      submissionCommitOid: commit
    })
    destination.finishRun('conflicting-run', 'failed')
    destination.close()

    const legacy = new DomainLedger(legacyPath)
    legacy.startRun({
      baseBranch: 'main',
      branch: 'legacy',
      intent: 'Do not discard this conflict.',
      policySha256: policy,
      repoRoot,
      runId: 'conflicting-run',
      submissionCommitOid: commit
    })
    legacy.finishRun('conflicting-run', 'failed')
    legacy.close()

    assert.throws(
      () => new DomainLedger({ legacyPath, repositoryPath: repo }),
      /UNIQUE constraint failed/
    )
    const repository = new DatabaseSync(repositoryLedgerPath(repo))
    const marker = repository.prepare(
      'SELECT source_present FROM repository_migrations WHERE source_path = ? AND repo_root = ?'
    ).get(legacyPath, repoRoot) as { source_present: number }
    assert.equal(marker.source_present, 0)
    repository.close()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
