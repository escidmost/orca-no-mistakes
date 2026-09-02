import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  admissionReadinessPath,
  deriveAdmissionId,
  initializeLocalGate,
  launchLockPath,
  readGateMetadata,
  repositoryGatePaths
} from '../scripts/admission.ts'
import { main } from '../scripts/orca-no-mistakes.ts'
import { DomainLedger } from '../scripts/ledger.ts'

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

async function commitAll(
  repo: string,
  file: string,
  contents: string,
  message: string
): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path.join(repo, file), contents, 'utf8')
  git(repo, 'add', '-A')
  execFileSync('git', ['-C', repo, 'commit', '-m', message], { stdio: 'ignore' })
}

test('init fails closed when the origin HEAD conflicts with local tracking evidence', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-conflict-'))
  try {
    const origin = path.join(temp, 'origin.git')
    execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
    const repo = await realpath(path.join(temp, 'repo'))
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin], { stdio: 'ignore' })
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await commitAll(repo, 'file.txt', 'first\n', 'first')
    git(repo, 'push', 'origin', 'main')
    execFileSync('git', ['--git-dir', origin, 'branch', '-m', 'main', 'trunk'], {
      stdio: 'ignore'
    })
    const paths = repositoryGatePaths(repo)
    await assert.rejects(
      initializeLocalGate(repo, process.argv[1]!),
      /the origin default branch trunk conflicts with local evidence main/
    )
    assert.equal(existsSync(paths.gatePath), false)
    assert.throws(() => git(repo, 'remote', 'get-url', 'orca-no-mistakes'))
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('init rejects a same-format non-bare repository at the gate path', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-nonbare-'))
  try {
    const origin = path.join(temp, 'origin.git')
    execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
    const repo = await realpath(path.join(temp, 'repo'))
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin], { stdio: 'ignore' })
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await commitAll(repo, 'file.txt', 'first\n', 'first')
    git(repo, 'push', 'origin', 'main')
    git(repo, 'checkout', '-b', 'feature')
    await commitAll(repo, 'file.txt', 'second\n', 'second')
    git(repo, 'push', 'origin', 'feature')
    await initializeLocalGate(repo, process.argv[1]!)
    const paths = repositoryGatePaths(repo)
    git(repo, 'remote', 'remove', 'orca-no-mistakes')
    await rm(paths.stateDir, { force: true, recursive: true })
    execFileSync('git', ['init', '-b', 'main', paths.gatePath], { stdio: 'ignore' })
    await assert.rejects(
      initializeLocalGate(repo, process.argv[1]!),
      /the existing gate path is not a bare repository/
    )
    assert.equal(existsSync(paths.gatePath), true)
    assert.throws(() => git(repo, 'remote', 'get-url', 'orca-no-mistakes'))
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

interface GateFixture {
  head: string
  intent: string
  metadata: Awaited<ReturnType<typeof readGateMetadata>>
  repo: string
  temp: string
}

async function gateFixture(prefix: string, intent: string): Promise<GateFixture> {
  const temp = await mkdtemp(path.join(tmpdir(), prefix))
  const origin = path.join(temp, 'origin.git')
  execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
  const repo = await realpath(path.join(temp, 'repo'))
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin], { stdio: 'ignore' })
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  await commitAll(repo, 'file.txt', 'first\n', 'first')
  git(repo, 'push', 'origin', 'main')
  git(repo, 'checkout', '-b', 'feature')
  await commitAll(repo, 'file.txt', 'second\n', 'second')
  git(repo, 'push', 'origin', 'feature')
  const head = git(repo, 'rev-parse', 'HEAD')
  await initializeLocalGate(repo, process.argv[1]!)
  const metadata = await readGateMetadata(repositoryGatePaths(repo).gatePath)
  execFileSync(
    'git',
    ['--git-dir', metadata.gatePath, 'fetch', '--quiet', repo, 'refs/heads/feature:refs/heads/feature'],
    { stdio: 'ignore' }
  )
  return { head, intent, metadata, repo, temp }
}

test('the coordinator settles before custody acceptance when the pipeline run cannot be created', async () => {
  const intent = 'Settle admission failures before acceptance.'
  const fixture = await gateFixture('onm-gate-settle-', intent)
  const previousOrcaCommand = process.env.ORCA_CLI_COMMAND
  process.env.ORCA_CLI_COMMAND = path.join(fixture.temp, 'missing-orca-cli')
  try {
    const ledger = new DomainLedger({ repositoryPath: fixture.repo })
    try {
      const admissionId = deriveAdmissionId({
        gateIdentity: fixture.metadata.gateIdentity,
        intent,
        newOid: fixture.head,
        oldOid: '0'.repeat(40),
        refName: 'refs/heads/feature'
      })
      ledger.beginSubmissionAdmission({
        admissionId,
        gateIdentity: fixture.metadata.gateIdentity,
        intent,
        newOid: fixture.head,
        oldOid: '0'.repeat(40),
        refName: 'refs/heads/feature',
        repoRoot: fixture.repo,
        source: 'gate'
      })
      const readinessPath = admissionReadinessPath(fixture.metadata, admissionId)
      const launchNonce = 'settle-launch'
      const lockPath = launchLockPath(readinessPath)
      await mkdir(lockPath, { recursive: true })
      await writeFile(path.join(lockPath, 'nonce'), launchNonce)
      await assert.rejects(
        main([
          'gate',
          'coordinator',
          '--gate',
          fixture.metadata.gatePath,
          '--admission-id',
          admissionId,
          '--readiness',
          readinessPath,
          '--launch-nonce',
          launchNonce
        ])
      )
      const readiness = JSON.parse(await readFile(readinessPath, 'utf8')) as {
        state: string
      }
      assert.equal(readiness.state, 'failed')
      const row = ledger.submissionAdmission(admissionId)
      assert.equal(row?.status, 'failed')
      assert.equal(row?.run_id, null)
      assert.equal(
        git(
          fixture.metadata.gatePath,
          'for-each-ref',
          '--format=%(refname)',
          'refs/orca-no-mistakes/heads/'
        ),
        ''
      )
    } finally {
      ledger.close()
    }
  } finally {
    if (previousOrcaCommand === undefined) delete process.env.ORCA_CLI_COMMAND
    else process.env.ORCA_CLI_COMMAND = previousOrcaCommand
    await rm(fixture.temp, { force: true, recursive: true })
  }
})

test('an accepted admission with a bound domain run replays without relaunching', async () => {
  const intent = 'Replay accepted admissions with a bound run.'
  const fixture = await gateFixture('onm-gate-accepted-replay-', intent)
  try {
    const ledger = new DomainLedger({ repositoryPath: fixture.repo })
    try {
      const admissionId = deriveAdmissionId({
        gateIdentity: fixture.metadata.gateIdentity,
        intent,
        newOid: fixture.head,
        oldOid: fixture.head,
        refName: 'refs/heads/feature'
      })
      ledger.beginSubmissionAdmission({
        admissionId,
        gateIdentity: fixture.metadata.gateIdentity,
        intent,
        newOid: fixture.head,
        oldOid: fixture.head,
        refName: 'refs/heads/feature',
        repoRoot: fixture.repo,
        source: 'gate'
      })
      ledger.startRun({
        baseBranch: 'main',
        branch: 'feature',
        intent,
        policySha256: 'c'.repeat(64),
        repoRoot: fixture.repo,
        runId: 'recovery-run',
        submissionCommitOid: fixture.head
      })
      ledger.bindSubmissionAdmission(admissionId, 'recovery-run')
      ledger.markSubmissionAccepted({
        acceptedOid: fixture.head,
        admissionId,
        runId: 'recovery-run'
      })
      const logs: string[] = []
      const originalLog = console.log
      console.log = (line: string) => {
        logs.push(line)
      }
      try {
        await main(['run', '--repo', fixture.repo, '--intent', intent])
      } finally {
        console.log = originalLog
      }
      const replay = JSON.parse(logs[0]) as { replayed: boolean; runId: string }
      assert.equal(replay.replayed, true)
      assert.equal(replay.runId, 'recovery-run')
      assert.equal(ledger.submissionAdmission(admissionId)?.status, 'accepted')
    } finally {
      ledger.close()
    }
  } finally {
    await rm(fixture.temp, { force: true, recursive: true })
  }
})
