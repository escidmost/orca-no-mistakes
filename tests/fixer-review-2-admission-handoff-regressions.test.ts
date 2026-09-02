import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  admissionReadinessPath,
  deriveAdmissionId,
  deriveFallbackGateIdentity,
  launchLockPath,
  repositoryGatePaths
} from '../scripts/admission.ts'
import { DomainLedger, sha256 } from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const oid = (character: string): string => character.repeat(40)

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

async function commitAll(repo: string, file: string, contents: string, message: string): Promise<void> {
  await writeFile(path.join(repo, file), contents)
  git(repo, 'add', file)
  git(repo, 'commit', '-m', message)
}

test('a launched direct admission retains its ref lease until settlement', () => {
  const ledger = new DomainLedger(':memory:')
  const repoRoot = '/shared/repository'
  const refName = 'refs/heads/feature'
  const firstIntent = 'Validate the admitted candidate.'
  const secondIntent = 'Validate a competing candidate.'
  const gateIdentity = sha256('shared-gate')
  const firstId = deriveAdmissionId({
    gateIdentity,
    intent: firstIntent,
    newOid: oid('a'),
    oldOid: oid('b'),
    refName
  })
  const secondId = deriveAdmissionId({
    gateIdentity,
    intent: secondIntent,
    newOid: oid('c'),
    oldOid: oid('b'),
    refName
  })
  const admission = (admissionId: string, intent: string, newOid: string) => ({
    admissionId,
    gateIdentity,
    intent,
    newOid,
    oldOid: oid('b'),
    refName,
    repoRoot,
    source: 'direct' as const
  })

  try {
    ledger.beginSubmissionAdmission(admission(firstId, firstIntent, oid('a')))
    ledger.markSubmissionLaunched(firstId, process.pid)
    assert.throws(
      () => ledger.beginSubmissionAdmission(admission(secondId, secondIntent, oid('c'))),
      /pending admission lease already exists/
    )

    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: firstIntent,
      policySha256: sha256('policy'),
      repoRoot,
      runId: 'admission-lease-run',
      submissionCommitOid: oid('a')
    })
    ledger.bindSubmissionAdmission(firstId, 'admission-lease-run')
    ledger.markSubmissionAccepted({
      acceptedOid: oid('a'),
      admissionId: firstId,
      runId: 'admission-lease-run'
    })
    assert.equal(
      ledger.beginSubmissionAdmission(admission(secondId, secondIntent, oid('c'))).status,
      'pending'
    )
  } finally {
    ledger.close()
  }
})

test('fallback admission identity is stable across linked worktrees', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-shared-admission-identity-'))
  try {
    execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
    const repo = await realpath(path.join(temp, 'repo'))
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await commitAll(repo, 'file.txt', 'content\n', 'initial')
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', path.join(temp, 'linked'), 'HEAD'], {
      stdio: 'ignore'
    })
    const linked = await realpath(path.join(temp, 'linked'))

    assert.equal(
      deriveFallbackGateIdentity(repositoryGatePaths(repo)),
      deriveFallbackGateIdentity(repositoryGatePaths(linked))
    )
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('accepted gate handoff releases nonce-bound launch custody', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-handoff-custody-'))
  const previousOrca = process.env.ORCA_CLI_COMMAND
  const previousConfig = process.env.ORCA_NO_MISTAKES_USER_CONFIG
  try {
    const origin = path.join(temp, 'origin.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
    execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
    const repo = await realpath(path.join(temp, 'repo'))
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await commitAll(repo, 'file.txt', 'base\n', 'base')
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'push', '-q', 'origin', 'main')
    git(repo, 'checkout', '-b', 'feature')
    await commitAll(repo, 'file.txt', 'feature\n', 'feature')

    const fakeOrca = path.join(temp, 'fake-orca')
    await writeFile(fakeOrca, '#!/bin/sh\nexit 1\n')
    await chmod(fakeOrca, 0o755)
    const config = path.join(temp, 'config.json')
    await writeFile(config, '{}\n')
    process.env.ORCA_CLI_COMMAND = fakeOrca
    process.env.ORCA_NO_MISTAKES_USER_CONFIG = config

    const paths = repositoryGatePaths(repo)
    const intent = 'Preserve gate custody through accepted handoff.'
    const head = git(repo, 'rev-parse', 'HEAD')
    const gateIdentity = sha256('gate-identity')
    const admissionId = deriveAdmissionId({
      gateIdentity,
      intent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/feature'
    })
    const ledger = new DomainLedger({ repositoryPath: repo })
    ledger.beginSubmissionAdmission({
      admissionId,
      gateIdentity,
      intent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/feature',
      repoRoot: paths.commonDir,
      source: 'gate'
    })
    ledger.close()

    const lockPath = launchLockPath(admissionReadinessPath(paths, admissionId))
    await mkdir(lockPath, { recursive: true })
    await writeFile(path.join(lockPath, 'nonce'), 'launch-generation')
    await writeFile(path.join(lockPath, 'owner'), `${process.pid}`)
    await writeFile(path.join(lockPath, 'coordinator'), `${process.pid}`)

    await assert.rejects(
      main([
        'run',
        '--attached',
        '--repo',
        repo,
        '--intent',
        intent,
        '--admission-id',
        admissionId,
        '--run-id',
        'gate-handoff-run',
        '--no-tui'
      ]),
      /fake-orca/
    )

    assert.equal(existsSync(lockPath), false)
    const settled = new DomainLedger({ repositoryPath: repo })
    assert.equal(settled.submissionAdmission(admissionId)?.status, 'accepted')
    settled.close()
  } finally {
    if (previousOrca === undefined) delete process.env.ORCA_CLI_COMMAND
    else process.env.ORCA_CLI_COMMAND = previousOrca
    if (previousConfig === undefined) delete process.env.ORCA_NO_MISTAKES_USER_CONFIG
    else process.env.ORCA_NO_MISTAKES_USER_CONFIG = previousConfig
    await rm(temp, { force: true, recursive: true })
  }
})
