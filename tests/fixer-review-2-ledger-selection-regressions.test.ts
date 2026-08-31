import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DomainLedger,
  artifactsRoot,
  buildAttestation,
  legacyLedgerPath
} from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const commit = 'a'.repeat(40)
const policy = 'b'.repeat(64)

function initRepo(repo: string): void {
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
}

test('migration preserves a retained Release 2 stage plan', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-retained-stage-plan-'))
  const repo = path.join(temp, 'repo')
  const legacyPath = path.join(temp, 'legacy', 'ledger.db')
  try {
    initRepo(repo)
    const repoRoot = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8'
    }).trim()
    const legacy = new DomainLedger(legacyPath)
    legacy.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Preserve the retained plan.',
      policySha256: policy,
      repoRoot,
      runId: 'retained-release-2-plan',
      stagePlan: [
        { requirement: 'required', stageId: 'push' },
        { requirement: 'required', stageId: 'pr' }
      ],
      submissionCommitOid: commit
    })
    legacy.finishRun('retained-release-2-plan', 'failed')
    legacy.close()

    const migrated = new DomainLedger({ legacyPath, repositoryPath: repo })
    assert.deepEqual(
      migrated.stagePlan('retained-release-2-plan').map(({ position, stage_id }) => [
        position,
        stage_id
      ]),
      [
        [0, 'push'],
        [1, 'pr']
      ]
    )
    migrated.close()
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('attestation rejects an invalid explicit repository', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-explicit-attestation-repo-'))
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, 'home')
  try {
    const runId = 'legacy-attestation'
    const intent = 'Reject an invalid explicit repository.'
    const legacy = new DomainLedger(legacyLedgerPath())
    legacy.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent,
      policySha256: policy,
      repoRoot: path.join(temp, 'legacy-repo'),
      runId,
      submissionCommitOid: commit
    })
    const manifest = buildAttestation([], {
      baseCommitOid: commit,
      candidateCommitOid: commit,
      guardrailMode: 'strict',
      intent,
      policySha256: policy,
      runId
    })
    legacy.finishRun(runId, 'passed', commit)
    legacy.recordAttestation(manifest)
    legacy.close()

    const output = path.join(temp, 'attestation.json')
    await assert.rejects(
      main([
        'attestation',
        'export',
        runId,
        `--repo=${path.join(temp, 'missing-repo')}`,
        `--out=${output}`
      ])
    )
    assert.equal(existsSync(output), false)
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome
    await rm(temp, { force: true, recursive: true })
  }
})

test('missing-root prune consults the legacy ledger from an unrelated repository', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-missing-root-legacy-'))
  const cwdRepo = path.join(temp, 'cwd-repo')
  const missingRepo = path.join(temp, 'missing-repo')
  const previousCwd = process.cwd()
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, 'home')
  try {
    initRepo(cwdRepo)
    process.chdir(cwdRepo)
    const runId = 'missing-root-legacy-run'
    const legacy = new DomainLedger(legacyLedgerPath())
    legacy.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Prune the exact missing repository.',
      policySha256: policy,
      repoRoot: missingRepo,
      runId,
      submissionCommitOid: commit
    })
    legacy.finishRun(runId, 'failed')
    legacy.close()
    const artifacts = path.join(artifactsRoot(), runId)
    await mkdir(artifacts, { recursive: true })

    await main(['prune', '--before=2999-01-01', `--repo=${missingRepo}`])

    const reopened = new DomainLedger(legacyLedgerPath())
    assert.equal(reopened.runStatus(runId), undefined)
    reopened.close()
    assert.equal(existsSync(artifacts), false)
  } finally {
    process.chdir(previousCwd)
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome
    await rm(temp, { force: true, recursive: true })
  }
})
