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
import { main } from '../scripts/orca-no-mistakes.ts'

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
      /orca-no-mistakes prune --stranded --repo <repo>/
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

test('default and explicit repository commands open the selected repository ledger', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-ledger-selection-'))
  const repoA = path.join(temp, 'repo-a')
  const repoB = path.join(temp, 'repo-b')
  const home = path.join(temp, 'home')
  const previousCwd = process.cwd()
  const previousHome = process.env.HOME
  const previousLedgerHome = process.env.ORCA_NO_MISTAKES_HOME
  const originalError = console.error
  const originalLog = console.log
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repoA])
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repoB])
    process.env.HOME = home
    delete process.env.ORCA_NO_MISTAKES_HOME

    const repoARoot = git(repoA, 'rev-parse', '--show-toplevel')
    const legacy = new DomainLedger(path.join(home, '.orca-no-mistakes', 'ledger.db'))
    legacy.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Migrate through the production no-argument constructor.',
      policySha256: policy,
      repoRoot: repoARoot,
      runId: 'default-constructor-run',
      submissionCommitOid: commit
    })
    legacy.finishRun('default-constructor-run', 'failed')
    legacy.close()

    process.chdir(repoA)
    const selected = new DomainLedger()
    assert.equal(selected.path, repositoryLedgerPath(repoA))
    assert.equal(selected.runStatus('default-constructor-run'), 'failed')
    selected.close()

    const repoBRoot = git(repoB, 'rev-parse', '--show-toplevel')
    const target = new DomainLedger({ repositoryPath: repoB })
    target.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Prove prune uses the explicit repository.',
      policySha256: policy,
      repoRoot: repoBRoot,
      runId: 'unsafe/run-id',
      submissionCommitOid: commit
    })
    target.finishRun('unsafe/run-id', 'failed')
    target.close()

    const errors: string[] = []
    console.error = (...args: unknown[]) => errors.push(args.join(' '))
    console.log = () => {}
    await main(['prune', `--repo=${repoB}`, '--before=2999-01-01T00:00:00.000Z'])
    assert.match(errors.join('\n'), /retained unsafe\/run-id/)
  } finally {
    console.error = originalError
    console.log = originalLog
    process.chdir(previousCwd)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousLedgerHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousLedgerHome
    await rm(temp, { recursive: true, force: true })
  }
})

test('migration refuses active destination state when a legacy source appears later', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-ledger-destination-active-'))
  const repo = path.join(temp, 'repo')
  const legacyPath = path.join(temp, 'legacy', 'ledger.db')
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
    const repoRoot = git(repo, 'rev-parse', '--show-toplevel')
    const destination = new DomainLedger({ legacyPath, repositoryPath: repo })
    destination.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Keep destination migration fenced.',
      policySha256: policy,
      repoRoot,
      runId: 'destination-active',
      submissionCommitOid: commit
    })
    destination.acquireLease({ branch: 'feature', repoRoot, runId: 'destination-active' })
    destination.close()

    const legacy = new DomainLedger(legacyPath)
    legacy.startRun({
      baseBranch: 'main',
      branch: 'historical',
      intent: 'Historical source appears later.',
      policySha256: policy,
      repoRoot,
      runId: 'legacy-history',
      submissionCommitOid: commit
    })
    legacy.finishRun('legacy-history', 'failed')
    legacy.close()

    assert.throws(
      () => new DomainLedger({ legacyPath, repositoryPath: repo }),
      /destination-active still holds a live semantic lease/
    )
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('remote receipt upgrades add the composite observation key before rebuilding', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-ledger-receipt-upgrade-'))
  const dbPath = path.join(temp, 'ledger.db')
  try {
    const old = new DatabaseSync(dbPath)
    old.exec(`
      CREATE TABLE remote_observations (
        observation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        observation_sha256 TEXT NOT NULL UNIQUE
      );
      CREATE TABLE remote_receipts (
        receipt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        candidate_commit_oid TEXT NOT NULL,
        authoritative_post_observation_sha256 TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        receipt_sha256 TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, kind)
      );
    `)
    old.close()

    const ledger = new DomainLedger(dbPath)
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Upgrade receipt foreign keys safely.',
      policySha256: policy,
      repoRoot: '/repo',
      runId: 'receipt-upgrade',
      submissionCommitOid: commit
    })
    const generationToken = ledger.acquireLease({
      branch: 'feature',
      repoRoot: '/repo',
      runId: 'receipt-upgrade'
    })
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'attempt',
      coordinatorIdentity: 'coordinator',
      generationToken,
      runId: 'receipt-upgrade',
      startedAt: '2026-08-31T00:00:00.000Z'
    })
    const observation = ledger.recordRemoteObservation({
      attemptId: 'attempt',
      kind: 'post-read',
      observedAt: '2026-08-31T00:00:01.000Z',
      payload: { candidateCommitOid: commit },
      runId: 'receipt-upgrade',
      subject: 'receipt-upgrade'
    })
    ledger.close()

    const upgraded = new DatabaseSync(dbPath)
    upgraded.exec('PRAGMA foreign_keys = ON')
    assert.doesNotThrow(() => upgraded.prepare(
      `INSERT INTO remote_receipts (
         receipt_id, run_id, kind, candidate_commit_oid,
         authoritative_post_observation_sha256, receipt_json, receipt_sha256, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'receipt',
      'receipt-upgrade',
      'candidate-publication',
      commit,
      observation,
      '{}',
      'd'.repeat(64),
      '2026-08-31T00:00:02.000Z'
    ))
    upgraded.close()
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('route migration keeps the destination route when a legacy archive appears later', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-route-migration-'))
  const repo = path.join(temp, 'repo')
  const legacyPath = path.join(temp, 'legacy', 'ledger.db')
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
    const repoRoot = git(repo, 'rev-parse', '--show-toplevel')
    const route = (headBranch: string) => ({
      actorId: '5',
      actorLogin: 'operator',
      actorNodeId: 'U_5',
      backend: 'gh' as const,
      backendVersion: 'gh version 2.97.0',
      baseBranch: 'main',
      baseRepositoryId: '10',
      baseRepositoryName: 'upstream/project',
      baseRepositoryNodeId: 'R_10',
      credentialSource: 'stored-account' as const,
      forgeHost: 'github.com' as const,
      headBranch,
      headOwner: 'fork-owner',
      headRepositoryId: '20',
      headRepositoryName: 'fork-owner/project',
      headRepositoryNodeId: 'R_20',
      networkRootRepositoryId: '10',
      observedAt: '2026-08-31T12:00:00.000Z',
      repoRoot
    })

    // First open without a legacy archive records source_present = 0, then
    // stores the repository route.
    const destination = new DomainLedger({ legacyPath, repositoryPath: repo })
    destination.setRepositoryPublicationRoute(route('feature'))
    const destinationFingerprint = destination.repositoryPublicationRoute(repoRoot)?.route_fingerprint
    destination.close()

    // A legacy archive appearing later carries a different route for the
    // same repository root; migration must keep the destination route.
    const legacy = new DomainLedger(legacyPath)
    legacy.setRepositoryPublicationRoute(route('legacy-feature'))
    legacy.close()

    const migrated = new DomainLedger({ legacyPath, repositoryPath: repo })
    assert.equal(migrated.repositoryPublicationRoute(repoRoot)?.route_fingerprint, destinationFingerprint)
    migrated.close()
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
