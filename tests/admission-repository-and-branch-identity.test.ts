import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  beginGateAdmission,
  deriveAdmissionId,
  initializeLocalGate,
  repositoryGatePaths
} from '../scripts/admission.ts'
import { DomainLedger } from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

function git(repo: string, ...args: string[]): string {
  return String(execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })).trim()
}

async function createRepository(parent: string, name: string): Promise<string> {
  const origin = path.join(parent, `${name}.git`)
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
  execFileSync('git', ['init', '-b', 'main', path.join(parent, name)], { stdio: 'ignore' })
  const repo = await realpath(path.join(parent, name))
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  await writeFile(path.join(repo, 'file.txt'), 'first\n')
  git(repo, 'add', 'file.txt')
  git(repo, 'commit', '-m', 'first')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-u', 'origin', 'main')
  return repo
}

async function withEmptyUserConfig<T>(temp: string, callback: () => Promise<T>): Promise<T> {
  const previous = process.env.ORCA_NO_MISTAKES_USER_CONFIG
  const config = path.join(temp, 'config.json')
  await writeFile(config, '{}\n')
  process.env.ORCA_NO_MISTAKES_USER_CONFIG = config
  try {
    return await callback()
  } finally {
    if (previous === undefined) delete process.env.ORCA_NO_MISTAKES_USER_CONFIG
    else process.env.ORCA_NO_MISTAKES_USER_CONFIG = previous
  }
}

test('direct and gate ingress share one pending lease across linked worktrees', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-admission-lease-identity-'))
  try {
    const repo = await createRepository(temp, 'repo')
    const metadata = await initializeLocalGate(repo, process.argv[1]!)
    git(repo, 'checkout', '-b', 'feature')
    const gateHead = git(repo, 'rev-parse', 'HEAD')
    execFileSync(
      'git',
      ['-C', repo, 'worktree', 'add', '-b', 'linked-feature', path.join(temp, 'linked'), 'feature'],
      { stdio: 'ignore' }
    )
    const linked = await realpath(path.join(temp, 'linked'))
    await writeFile(path.join(linked, 'file.txt'), 'second\n')
    git(linked, 'add', 'file.txt')
    git(linked, 'commit', '-m', 'second')

    const ledger = new DomainLedger({ repositoryPath: repo })
    beginGateAdmission(ledger, metadata, {
      intent: 'Admit the gate candidate.',
      newOid: gateHead,
      noEvent: false,
      oldOid: gateHead,
      refName: 'refs/heads/linked-feature'
    })
    ledger.close()

    await withEmptyUserConfig(temp, () =>
      assert.rejects(
        main(['run', '--repo', linked, '--intent', 'Admit the direct candidate.']),
        /pending admission lease already exists/
      )
    )
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('an admission cannot execute from another branch at the same commit', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-admission-branch-identity-'))
  try {
    const repo = await createRepository(temp, 'repo')
    const head = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-b', 'branch-a')
    const paths = repositoryGatePaths(repo)
    const intent = 'Bind the admitted branch.'
    const admissionId = deriveAdmissionId({
      gateIdentity: 'gate-identity',
      intent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/branch-a'
    })
    const ledger = new DomainLedger({ repositoryPath: repo })
    ledger.beginSubmissionAdmission({
      admissionId,
      gateIdentity: 'gate-identity',
      intent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/branch-a',
      repoRoot: paths.commonDir,
      source: 'direct'
    })
    ledger.close()
    git(repo, 'checkout', '-b', 'branch-b')

    await withEmptyUserConfig(temp, () =>
      assert.rejects(
        main([
          'run',
          '--repo',
          repo,
          '--intent',
          intent,
          '--admission-id',
          admissionId,
          '--attached',
          '--no-tui'
        ]),
        /pipeline checkout is on branch-b but the admission is for refs\/heads\/branch-a/
      )
    )
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('an admission cannot execute from another repository', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-admission-repo-identity-'))
  try {
    const repo = await createRepository(temp, 'repo')
    const other = await createRepository(temp, 'other')
    const head = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-b', 'feature')
    const intent = 'Bind the admitted repository.'
    const admissionId = deriveAdmissionId({
      gateIdentity: 'gate-identity',
      intent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/feature'
    })
    const ledger = new DomainLedger({ repositoryPath: repo })
    ledger.beginSubmissionAdmission({
      admissionId,
      gateIdentity: 'gate-identity',
      intent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/feature',
      repoRoot: repositoryGatePaths(other).commonDir,
      source: 'direct'
    })
    ledger.close()

    await withEmptyUserConfig(temp, () =>
      assert.rejects(
        main([
          'run',
          '--repo',
          repo,
          '--intent',
          intent,
          '--admission-id',
          admissionId,
          '--attached',
          '--no-tui'
        ]),
        /pipeline checkout does not belong to the admitted repository/
      )
    )
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
