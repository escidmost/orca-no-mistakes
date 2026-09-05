import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DomainLedger, artifactsRoot, legacyLedgerPath } from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const policy = 'f'.repeat(64)

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function initRepo(repo: string): Promise<string> {
  git(path.dirname(repo), '-c', 'init.templateDir=', 'init', '-b', 'main', repo)
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  git(repo, 'config', 'commit.gpgsign', 'false')
  await writeFile(path.join(repo, 'README.md'), 'main\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-m', 'main')
  return git(repo, 'rev-parse', 'HEAD')
}

function recordLegacyRun(repoRoot: string, runId: string, commit: string): void {
  const legacy = new DomainLedger(legacyLedgerPath())
  legacy.startRun({
    baseBranch: 'main',
    branch: 'main',
    intent: runId,
    policySha256: policy,
    repoRoot,
    runId,
    submissionCommitOid: commit
  })
  legacy.finishRun(runId, 'failed')
  legacy.close()
  git(repoRoot, 'update-ref', `refs/no-mistakes/recover/${runId}`, commit)
}

test('repository migration takes sole ownership of shared artifacts', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-migrated-prune-owner-'))
  const repo = path.join(temp, 'repo')
  const home = path.join(temp, 'home')
  const previousCwd = process.cwd()
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  process.env.ORCA_NO_MISTAKES_HOME = home
  try {
    const commit = await initRepo(repo)
    const repoRoot = git(repo, 'rev-parse', '--show-toplevel')
    const runId = 'migrated-prune-owner'
    recordLegacyRun(repoRoot, runId, commit)
    const artifacts = path.join(artifactsRoot(), runId)
    await mkdir(artifacts, { recursive: true })
    await writeFile(path.join(artifacts, 'review.log'), 'preserved evidence\n')

    const migrated = new DomainLedger({ repositoryPath: repo })
    assert.equal(migrated.runStatus(runId), 'failed')
    migrated.close()

    process.chdir(temp)
    await main(['prune', '--before=2999-01-01'])

    const repository = new DomainLedger({ repositoryPath: repo })
    assert.equal(repository.runStatus(runId), 'failed')
    repository.close()
    const legacy = new DomainLedger(legacyLedgerPath())
    assert.equal(legacy.runStatus(runId), undefined)
    legacy.close()
    assert.equal(existsSync(artifacts), true)
  } finally {
    process.chdir(previousCwd)
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome
    await rm(temp, { force: true, recursive: true })
  }
})

test('prune repository selection includes nested run roots', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-prune-nested-root-'))
  const group = path.join(temp, 'group')
  const repo = path.join(group, 'repo-a')
  const home = path.join(temp, 'home')
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  process.env.ORCA_NO_MISTAKES_HOME = home
  try {
    await mkdir(group)
    const commit = await initRepo(repo)
    const repoRoot = git(repo, 'rev-parse', '--show-toplevel')
    const runId = 'nested-prune-selection'
    recordLegacyRun(repoRoot, runId, commit)
    const artifacts = path.join(artifactsRoot(), runId)
    await mkdir(artifacts, { recursive: true })

    await main(['prune', '--before=2999-01-01', `--repo=${group}`])

    const legacy = new DomainLedger(legacyLedgerPath())
    assert.equal(legacy.runStatus(runId), undefined)
    legacy.close()
    assert.equal(existsSync(artifacts), false)
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome
    await rm(temp, { force: true, recursive: true })
  }
})
