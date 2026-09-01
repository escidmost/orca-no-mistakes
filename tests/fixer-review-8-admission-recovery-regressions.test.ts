import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  admissionReadinessPath,
  deriveAdmissionId,
  initializeLocalGate,
  readGateMetadata,
  repositoryGatePaths,
  type GateMetadata
} from '../scripts/admission.ts'
import { canonicalJson, DomainLedger, sha256 } from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const oid = (character: string): string => character.repeat(40)

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

const commitAll = async (
  repo: string,
  file: string,
  contents: string,
  message: string
): Promise<void> => {
  await writeFile(path.join(repo, file), contents)
  git(repo, 'add', file)
  git(repo, 'commit', '-m', message)
}

const scrubLaunchEnvironment = (): (() => void) => {
  const keys = [
    'NO_MISTAKES_ORIGIN_WORKTREE',
    'NO_MISTAKES_GATE_WORKTREE_ID',
    'NO_MISTAKES_GATE_WORKTREE_ROOT',
    'ORCA_CLI_COMMAND',
    'FAKE_ORCA_LOG'
  ]
  const saved = keys.map((key) => [key, process.env[key]] as const)
  for (const key of keys) delete process.env[key]
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('a direct run whose checkout drifted from the admission is rejected and the admission settles', async () => {
  const restore = scrubLaunchEnvironment()
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-direct-drift-'))
  const intent = 'Reject a checkout that drifted from the admission.'
  try {
    const origin = path.join(temp, 'origin.git')
    execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
    const repo = await realpath(path.join(temp, 'repo'))
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin], { stdio: 'ignore' })
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await commitAll(repo, 'file.txt', 'first\n', 'first')
    git(repo, 'push', '-q', 'origin', 'main')
    git(repo, 'fetch', '-q', 'origin')
    git(repo, 'checkout', '-b', 'feature')
    await commitAll(repo, 'file.txt', 'second\n', 'second')
    git(repo, 'push', '-q', 'origin', 'feature')

    const base = git(repo, 'rev-parse', 'origin/main')
    const paths = repositoryGatePaths(repo)
    const gateIdentity = sha256(
      canonicalJson({ gatePath: paths.gatePath, repoRoot: paths.repoRoot })
    )
    const admissionId = deriveAdmissionId({
      gateIdentity,
      intent,
      newOid: base,
      oldOid: base,
      refName: 'refs/heads/feature'
    })
    const ledger = new DomainLedger({ repositoryPath: repo })
    ledger.beginSubmissionAdmission({
      admissionId,
      gateIdentity,
      intent,
      newOid: base,
      oldOid: base,
      refName: 'refs/heads/feature',
      repoRoot: paths.repoRoot,
      source: 'direct'
    })
    ledger.markSubmissionLaunched(admissionId)
    ledger.close()

    await assert.rejects(
      main([
        'run',
        '--attached',
        '--repo',
        repo,
        '--intent',
        intent,
        '--admission-id',
        admissionId
      ]),
      /does not match the admitted submission object/
    )
    const settled = new DomainLedger({ repositoryPath: repo })
    assert.equal(settled.submissionAdmission(admissionId)?.status, 'failed')
    assert.equal(settled.submissionAdmission(admissionId)?.run_id, null)
    settled.close()
  } finally {
    await rm(temp, { force: true, recursive: true })
    restore()
  }
})

const gateFixture = async (
  prefix: string,
  intent: string
): Promise<{ head: string; intent: string; metadata: GateMetadata; repo: string; temp: string }> => {
  const temp = await mkdtemp(path.join(tmpdir(), prefix))
  execFileSync('git', ['init', '-b', 'main', path.join(temp, 'origin.git'), '--bare'], {
    stdio: 'ignore'
  })
  execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
  const repo = await realpath(path.join(temp, 'repo'))
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  await writeFile(path.join(repo, '.git', 'info', 'exclude'), '.orca/\n', { flag: 'a' })
  await commitAll(repo, 'base.txt', 'base\n', 'base')
  git(repo, 'remote', 'add', 'origin', path.join(temp, 'origin.git'))
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'fetch', '-q', 'origin')
  git(repo, 'checkout', '-b', 'feature')
  await commitAll(repo, 'feature.txt', 'feature\n', 'feature')
  git(repo, 'push', '-q', 'origin', 'feature')
  const metadata = await initializeLocalGate(repo, process.argv[1]!)
  execFileSync(
    'git',
    ['--git-dir', metadata.gatePath, 'fetch', '-q', repo, 'refs/heads/feature:refs/heads/feature'],
    { stdio: 'ignore' }
  )
  return {
    head: git(repo, 'rev-parse', 'HEAD'),
    intent,
    metadata: await readGateMetadata(metadata.gatePath),
    repo,
    temp
  }
}

const fakeOrcaCli = async (temp: string): Promise<string> => {
  const file = path.join(temp, 'fake-orca')
  await writeFile(
    file,
    [
      '#!/bin/sh',
      'case "$*" in',
      '  *run-create*) echo \'{"run":{"id":"recover-run"}}\' ;;',
      '  *) exit 1 ;;',
      'esac',
      'exit 0'
    ].join('\n')
  )
  await chmod(file, 0o755)
  return file
}

test('a materialized gate admission stays recoverable when the pipeline handoff fails', async () => {
  const restore = scrubLaunchEnvironment()
  const intent = 'Keep a materialized submission recoverable.'
  const fixture = await gateFixture('onm-gate-recover-', intent)
  process.env.ORCA_CLI_COMMAND = await fakeOrcaCli(fixture.temp)
  try {
    const admissionId = deriveAdmissionId({
      gateIdentity: fixture.metadata.gateIdentity,
      intent,
      newOid: fixture.head,
      oldOid: oid('0'),
      refName: 'refs/heads/feature'
    })
    const ledger = new DomainLedger({ repositoryPath: fixture.repo })
    ledger.beginSubmissionAdmission({
      admissionId,
      gateIdentity: fixture.metadata.gateIdentity,
      intent,
      newOid: fixture.head,
      oldOid: oid('0'),
      refName: 'refs/heads/feature',
      repoRoot: fixture.metadata.repoRoot,
      source: 'gate'
    })
    ledger.close()
    git(fixture.metadata.gatePath, 'update-ref', 'refs/heads/feature', fixture.head)
    const readinessPath = admissionReadinessPath(fixture.metadata, admissionId)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        main([
          'gate',
          'coordinator',
          '--gate',
          fixture.metadata.gatePath,
          '--admission-id',
          admissionId,
          '--readiness',
          readinessPath
        ])
      )
      const settled = new DomainLedger({ repositoryPath: fixture.repo })
      assert.equal(settled.submissionAdmission(admissionId)?.status, 'pending')
      assert.equal(settled.submissionAdmission(admissionId)?.run_id, null)
      settled.close()
    }

    const readiness = JSON.parse(await readFile(readinessPath, 'utf8')) as { state?: string }
    assert.equal(readiness.state, 'failed')
    assert.equal(
      git(
        fixture.metadata.gatePath,
        'rev-parse',
        'refs/orca-no-mistakes/heads/recover-run'
      ),
      fixture.head
    )

    const competingId = deriveAdmissionId({
      gateIdentity: fixture.metadata.gateIdentity,
      intent: 'Compete for the admitted ref.',
      newOid: fixture.head,
      oldOid: oid('0'),
      refName: 'refs/heads/feature'
    })
    const competing = new DomainLedger({ repositoryPath: fixture.repo })
    assert.throws(
      () =>
        competing.beginSubmissionAdmission({
          admissionId: competingId,
          gateIdentity: fixture.metadata.gateIdentity,
          intent: 'Compete for the admitted ref.',
          newOid: fixture.head,
          oldOid: oid('0'),
          refName: 'refs/heads/feature',
          repoRoot: fixture.metadata.repoRoot,
          source: 'gate'
        }),
      /pending admission lease already exists/
    )
    competing.close()
  } finally {
    await rm(fixture.temp, { force: true, recursive: true })
    restore()
  }
})
