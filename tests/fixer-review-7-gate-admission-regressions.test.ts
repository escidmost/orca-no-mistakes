import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { equal, rejects, strictEqual, throws } from 'node:assert/strict'
import test from 'node:test'

import {
  admissionReadinessPath,
  deriveAdmissionId,
  initializeLocalGate,
  launchLockPath,
  readGateMetadata,
  recordCoordinatorLaunch,
  repositoryGatePaths,
  type GateMetadata
} from '../scripts/admission.ts'
import { DomainLedger } from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const zeros = (): string => '0'.repeat(40)

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

const gateFixture = async (
  prefix: string,
  intent: string
): Promise<{ head: string; intent: string; metadata: GateMetadata; repo: string; temp: string }> => {
  const temp = await mkdtemp(path.join(tmpdir(), prefix))
  try {
    execFileSync('git', ['init', '-b', 'main', path.join(temp, 'origin.git'), '--bare'], {
      stdio: 'ignore'
    })
    execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
    const repo = await realpath(path.join(temp, 'repo'))
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
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
  } catch (error) {
    await rm(temp, { force: true, recursive: true })
    throw error
  }
}

test('init resets managed remote push URLs and verifies none remain', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-pushurl-reset-'))
  try {
    execFileSync('git', ['init', '-b', 'main', path.join(temp, 'origin.git'), '--bare'], {
      stdio: 'ignore'
    })
    execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
    const repo = await realpath(path.join(temp, 'repo'))
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await commitAll(repo, 'base.txt', 'base\n', 'base')
    git(repo, 'remote', 'add', 'origin', path.join(temp, 'origin.git'))
    git(repo, 'push', '-q', 'origin', 'main')
    git(repo, 'fetch', '-q', 'origin')
    git(repo, 'remote', 'add', 'orca-no-mistakes', path.join(temp, 'origin.git'))
    git(repo, 'config', '--add', 'remote.orca-no-mistakes.pushurl', 'https://bypass.example/gate.git')
    const metadata = await initializeLocalGate(repo, process.argv[1]!)
    equal(git(repo, 'remote', 'get-url', 'orca-no-mistakes'), metadata.gatePath)
    let pushUrls: string | undefined
    try {
      pushUrls = git(repo, 'config', '--get-all', 'remote.orca-no-mistakes.pushurl')
    } catch {
      pushUrls = undefined
    }
    strictEqual(pushUrls, undefined)
    await readGateMetadata(metadata.gatePath)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('gate metadata verification rejects a pushurl override on the managed remote', async () => {
  const fixture = await gateFixture('onm-pushurl-verify-', 'Keep every push on the bare gate.')
  try {
    git(fixture.repo, 'config', '--add', 'remote.orca-no-mistakes.pushurl', 'https://bypass.example/gate.git')
    await rejects(
      readGateMetadata(fixture.metadata.gatePath),
      /local gate metadata does not match its repository/
    )
  } finally {
    await rm(fixture.temp, { force: true, recursive: true })
  }
})

test('init refuses to re-route the repository gate from a linked worktree', async () => {
  const fixture = await gateFixture('onm-init-route-', 'Keep one repository-wide gate route.')
  try {
    const worktree = path.join(fixture.temp, 'worktree-b')
    git(fixture.repo, 'worktree', 'add', '-b', 'feature-b', worktree, 'main')
    const metadataBefore = await readFile(
      path.join(fixture.metadata.stateDir, 'gate.json'),
      'utf8'
    )
    await rejects(initializeLocalGate(worktree, process.argv[1]!), /the local gate is routed to/)
    const metadataAfter = await readFile(path.join(fixture.metadata.stateDir, 'gate.json'), 'utf8')
    strictEqual(metadataAfter, metadataBefore)
  } finally {
    await rm(fixture.temp, { force: true, recursive: true })
  }
})

test('init reuses the repository gate while configuring a linked worktree', async () => {
  const fixture = await gateFixture('onm-init-linked-route-', 'Configure this branch without rerouting the gate.')
  try {
    const worktree = path.join(fixture.temp, 'worktree-b')
    git(fixture.repo, 'worktree', 'add', '-b', 'feature-b', worktree, 'main')
    const metadataBefore = await readFile(
      path.join(fixture.metadata.stateDir, 'gate.json'),
      'utf8'
    )

    await main(['init', '--repo', worktree])

    const metadataAfter = await readFile(path.join(fixture.metadata.stateDir, 'gate.json'), 'utf8')
    strictEqual(metadataAfter, metadataBefore)
  } finally {
    await rm(fixture.temp, { force: true, recursive: true })
  }
})

test('direct submissions from a linked worktree follow the routed gate', async () => {
  const fixture = await gateFixture('onm-direct-route-', 'Route direct submissions through one worktree.')
  const previousOrcaCommand = process.env.ORCA_CLI_COMMAND
  process.env.ORCA_CLI_COMMAND = path.join(fixture.temp, 'missing-orca-cli')
  try {
    const worktree = path.join(fixture.temp, 'worktree-b')
    git(fixture.repo, 'worktree', 'add', '-b', 'feature-b', worktree, 'main')
    await rejects(
      main(['run', '--attached', '--repo', worktree, '--intent', fixture.intent]),
      /missing-orca-cli/
    )
    const paths = repositoryGatePaths(worktree)
    const admissionId = deriveAdmissionId({
      gateIdentity: fixture.metadata.gateIdentity,
      intent: fixture.intent,
      newOid: git(worktree, 'rev-parse', 'HEAD'),
      oldOid: git(worktree, 'rev-parse', 'HEAD'),
      refName: 'refs/heads/feature-b'
    })
    const ledger = new DomainLedger({ repositoryPath: worktree })
    strictEqual(ledger.submissionAdmission(admissionId)?.repo_root, paths.commonDir)
    ledger.close()
  } finally {
    await rm(fixture.temp, { force: true, recursive: true })
    if (previousOrcaCommand === undefined) delete process.env.ORCA_CLI_COMMAND
    else process.env.ORCA_CLI_COMMAND = previousOrcaCommand
  }
})

test('a submission admission cannot bind a run before the domain run exists', async () => {
  const fixture = await gateFixture('onm-bind-fk-', 'Bind admissions only after their domain run.')
  const admissionId = deriveAdmissionId({
    gateIdentity: fixture.metadata.gateIdentity,
    intent: fixture.intent,
    newOid: fixture.head,
    oldOid: zeros(),
    refName: 'refs/heads/feature'
  })
  const ledger = new DomainLedger({ repositoryPath: fixture.repo })
  try {
    ledger.beginSubmissionAdmission({
      admissionId,
      gateIdentity: fixture.metadata.gateIdentity,
      intent: fixture.intent,
      newOid: fixture.head,
      oldOid: zeros(),
      refName: 'refs/heads/feature',
      repoRoot: fixture.metadata.repoRoot,
      source: 'gate'
    })
    throws(
      () => ledger.bindSubmissionAdmission(admissionId, 'fk-probe-run'),
      /FOREIGN KEY constraint failed/
    )
  } finally {
    ledger.close()
    await rm(fixture.temp, { force: true, recursive: true })
  }
})

test('a stale coordinator generation cannot adopt the current launch lock', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-coordinator-nonce-'))
  try {
    const lockPath = path.join(temp, 'admissions', 'admission.lock')
    await mkdir(lockPath, { recursive: true })
    await writeFile(path.join(lockPath, 'nonce'), 'generation-b')
    await rejects(recordCoordinatorLaunch(lockPath, 'generation-a'), /launch generation changed/)
    await recordCoordinatorLaunch(lockPath, 'generation-b')
    strictEqual(await readFile(path.join(lockPath, 'coordinator'), 'utf8'), `${process.pid}`)
    await recordCoordinatorLaunch(path.join(temp, 'admissions', 'missing.lock'))
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('the receiving hook keeps the launch lock through the pipeline handoff', async () => {
  const fixture = await gateFixture('onm-launch-handoff-', 'Hold the launch lock until the pipeline takes over.')
  const admissionId = deriveAdmissionId({
    gateIdentity: fixture.metadata.gateIdentity,
    intent: fixture.intent,
    newOid: fixture.head,
    oldOid: zeros(),
    refName: 'refs/heads/feature'
  })
  const ledger = new DomainLedger({ repositoryPath: fixture.repo })
  ledger.beginSubmissionAdmission({
    admissionId,
    gateIdentity: fixture.metadata.gateIdentity,
    intent: fixture.intent,
    newOid: fixture.head,
    oldOid: zeros(),
    refName: 'refs/heads/feature',
    repoRoot: fixture.metadata.repoRoot,
    source: 'gate'
  })
  ledger.startRun({
    baseBranch: 'main',
    branch: 'feature',
    intent: fixture.intent,
    policySha256: 'c'.repeat(64),
    repoRoot: fixture.metadata.repoRoot,
    runId: 'handoff-run',
    submissionCommitOid: fixture.head
  })
  ledger.bindSubmissionAdmission(admissionId, 'handoff-run')
  ledger.close()

  const readinessPath = admissionReadinessPath(fixture.metadata, admissionId)
  const lockPath = launchLockPath(readinessPath)
  await mkdir(path.dirname(readinessPath), { recursive: true })
  await mkdir(lockPath)
  await writeFile(path.join(lockPath, 'nonce'), 'handoff-nonce')
  await writeFile(path.join(lockPath, 'owner'), `${process.pid}`)
  await writeFile(path.join(lockPath, 'coordinator'), `${process.pid}`)
  await writeFile(
    readinessPath,
    `${JSON.stringify({ nonce: 'handoff-nonce', runId: 'handoff-run', state: 'ready' })}\n`
  )

  const originalStdin = process.stdin
  const previousCount = process.env.GIT_PUSH_OPTION_COUNT
  const previousOption = process.env.GIT_PUSH_OPTION_0
  const originalLog = console.log
  const lines: string[] = []
  const encodedIntent = Buffer.from(fixture.intent, 'utf8').toString('base64url')
  try {
    process.env.GIT_PUSH_OPTION_COUNT = '1'
    process.env.GIT_PUSH_OPTION_0 = `no-mistakes.intent=${encodedIntent}`
    console.log = (line: unknown) => {
      lines.push(String(line))
    }
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([`${zeros()} ${fixture.head} refs/heads/feature\n`]) as unknown as NodeJS.ReadableStream,
      configurable: true
    })
    await main(['gate', 'admit', '--gate', fixture.metadata.gatePath])
    equal(existsSync(lockPath), true)
    equal(lines.some((line) => line.includes('"runId":"handoff-run"')), true)
  } finally {
    console.log = originalLog
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true })
    if (previousCount === undefined) delete process.env.GIT_PUSH_OPTION_COUNT
    else process.env.GIT_PUSH_OPTION_COUNT = previousCount
    if (previousOption === undefined) delete process.env.GIT_PUSH_OPTION_0
    else process.env.GIT_PUSH_OPTION_0 = previousOption
    await rm(fixture.temp, { force: true, recursive: true })
  }
})
