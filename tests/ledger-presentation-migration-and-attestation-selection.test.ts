import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PIPELINE_STEPS } from '../scripts/config.ts'
import {
  DomainLedger,
  buildAttestation,
  evidenceSha256,
  sha256
} from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'
import type { PresentationSnapshot } from '../scripts/presentation.ts'

const commit = 'a'.repeat(40)
const policy = 'b'.repeat(64)

function snapshot(runId: string): PresentationSnapshot {
  return {
    attempt: 1,
    mode: { autoFix: true },
    runId,
    sequence: 1,
    stages: [],
    status: 'failed',
    transition: { kind: 'error-recorded', resumable: true },
    updatedAt: '2026-08-31T00:00:00.000Z',
    version: 1
  }
}

test('repository migration preserves presentation history without copying row IDs', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-presentation-migration-'))
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
      intent: 'Keep local presentation history.',
      policySha256: policy,
      repoRoot,
      runId: 'local-presentation',
      submissionCommitOid: commit
    })
    destination.recordPresentationSnapshot(
      'local-presentation',
      'local-event',
      snapshot('local-presentation')
    )
    destination.finishRun('local-presentation', 'failed')
    destination.close()

    const legacy = new DomainLedger(legacyPath)
    legacy.startRun({
      baseBranch: 'main',
      branch: 'legacy',
      intent: 'Migrate legacy presentation history.',
      policySha256: policy,
      repoRoot,
      runId: 'legacy-presentation',
      submissionCommitOid: commit
    })
    legacy.recordPresentationSnapshot(
      'legacy-presentation',
      'legacy-event',
      snapshot('legacy-presentation')
    )
    legacy.finishRun('legacy-presentation', 'failed')
    legacy.close()

    const migrated = new DomainLedger({ legacyPath, repositoryPath: repo })
    assert.deepEqual(
      migrated.listPresentationSnapshots('legacy-presentation'),
      [snapshot('legacy-presentation')]
    )
    migrated.close()
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('attestation export and verify select an explicit repository ledger', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-attestation-repository-'))
  const repo = path.join(temp, 'repo')
  const elsewhere = path.join(temp, 'elsewhere')
  const exported = path.join(temp, 'attestation.json')
  const previousCwd = process.cwd()
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', elsewhere])
    process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, 'home')
    const repoRoot = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8'
    }).trim()
    const runId = 'explicit-attestation-repository'
    const artifact = Buffer.from('{}')
    const artifactSha256 = sha256(artifact)
    const entries = PIPELINE_STEPS.map((stage) => {
      const entry = {
        artifactSha256,
        baseCommitOid: commit,
        candidateCommitOid: commit,
        exitCode: 0,
        round: 0,
        stage,
        summary: 'clean',
        workerIdentity: `${stage}-worker`
      }
      return { ...entry, evidenceSha256: evidenceSha256({ ...entry, runId }) }
    })
    const ledger = new DomainLedger({ repositoryPath: repo })
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Select an explicit attestation repository.',
      policySha256: policy,
      repoRoot,
      runId,
      submissionCommitOid: commit
    })
    for (const entry of entries) {
      const artifactPath = path.join(temp, `${entry.stage}.json`)
      await writeFile(artifactPath, artifact)
      ledger.recordEvidence({
        artifactPath,
        artifactSha256: entry.artifactSha256,
        baseCommitOid: entry.baseCommitOid,
        candidateCommitOid: entry.candidateCommitOid,
        evidenceSha256: entry.evidenceSha256,
        exitCode: entry.exitCode,
        roundIndex: entry.round,
        runId,
        stageId: entry.stage,
        summary: entry.summary,
        workerIdentity: entry.workerIdentity
      })
    }
    const manifest = buildAttestation(entries, {
      baseCommitOid: commit,
      candidateCommitOid: commit,
      guardrailMode: 'strict',
      intent: 'Select an explicit attestation repository.',
      policySha256: policy,
      runId
    })
    ledger.finishRun(runId, 'passed', commit)
    ledger.recordAttestation(manifest)
    ledger.close()

    process.chdir(elsewhere)
    await main(['attestation', 'export', runId, `--repo=${repo}`, `--out=${exported}`])
    assert.deepEqual(JSON.parse(await readFile(exported, 'utf8')), manifest)
    await main(['attestation', 'verify', runId, `--repo=${repo}`])
  } finally {
    process.chdir(previousCwd)
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome
    await rm(temp, { force: true, recursive: true })
  }
})
