import { execFileSync, spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveAdmissionId,
  launchLockPath,
  readAdmissionLaunchClaim,
  recordCoordinatorLaunch,
  repositoryGatePaths
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
    'NO_MISTAKES_DELIVERY_BRANCH',
    'NO_MISTAKES_GATE_BRANCH',
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

const directFixture = async (
  prefix: string,
  intent: string
): Promise<{ head: string; intent: string; repo: string; temp: string }> => {
  const temp = await mkdtemp(path.join(tmpdir(), prefix))
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
  return { head: git(repo, 'rev-parse', 'HEAD'), intent, repo, temp }
}

const fakeOrcaCli = async (temp: string, runId: string): Promise<string> => {
  const file = path.join(temp, 'fake-orca')
  await writeFile(
    file,
    [
      '#!/bin/sh',
      'case "$*" in',
      `  *run-create*) echo '{"run":{"id":"${runId}"}}' ;;`,
      '  *) exit 1 ;;',
      'esac',
      'exit 0'
    ].join('\n')
  )
  await chmod(file, 0o755)
  return file
}

const deadPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await new Promise<void>((resolve) => child.on('exit', () => resolve()))
  return child.pid!
}

const directAdmission = (
  repo: string,
  intent: string,
  head: string
): { admissionId: string; input: Parameters<DomainLedger['beginSubmissionAdmission']>[0] } => {
  const paths = repositoryGatePaths(repo)
  const gateIdentity = sha256(canonicalJson({ gatePath: paths.gatePath, repoRoot: paths.repoRoot }))
  return {
    admissionId: deriveAdmissionId({
      gateIdentity,
      intent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/feature'
    }),
    input: {
      admissionId: deriveAdmissionId({
        gateIdentity,
        intent,
        newOid: head,
        oldOid: head,
        refName: 'refs/heads/feature'
      }),
      gateIdentity,
      intent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/feature',
      repoRoot: paths.repoRoot,
      source: 'direct' as const
    }
  }
}

test('the gate coordinator accepts the --launch-nonce flag', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-launch-nonce-'))
  try {
    const error = await main([
      'gate',
      'coordinator',
      '--gate',
      path.join(temp, 'missing-gate.git'),
      '--admission-id',
      `admission-${oid('a')}`,
      '--readiness',
      path.join(temp, 'readiness.json'),
      '--launch-nonce',
      'nonce-value'
    ]).then(
      () => undefined,
      (rejection: Error) => rejection
    )
    assert.ok(error instanceof Error)
    assert.doesNotMatch(error.message, /unknown flag/)
    assert.doesNotMatch(error.message, /not valid for the gate subcommand/)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('branch lease contention after binding reclaims the admission to pending', async () => {
  const restore = scrubLaunchEnvironment()
  const intent = 'Retry a submission that lost its branch lease.'
  const fixture = await directFixture('onm-lease-contention-', intent)
  process.env.ORCA_CLI_COMMAND = await fakeOrcaCli(fixture.temp, 'contention-run')
  try {
    const { admissionId, input } = directAdmission(fixture.repo, intent, fixture.head)
    const ledger = new DomainLedger({ repositoryPath: fixture.repo })
    ledger.beginSubmissionAdmission(input)
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Hold the branch lease.',
      policySha256: sha256('policy'),
      repoRoot: input.repoRoot,
      runId: 'lease-holder-run',
      submissionCommitOid: fixture.head
    })
    ledger.settleRun('lease-holder-run', 'failed')
    ledger.acquireLease({ branch: 'feature', repoRoot: input.repoRoot, runId: 'lease-holder-run' })
    ledger.close()

    await assert.rejects(
      main([
        'run',
        '--attached',
        '--repo',
        fixture.repo,
        '--intent',
        intent,
        '--admission-id',
        admissionId
      ]),
      /already leased by run lease-holder-run/
    )

    const settled = new DomainLedger({ repositoryPath: fixture.repo })
    const row = settled.submissionAdmission(admissionId)
    assert.equal(row?.status, 'pending')
    assert.equal(row?.run_id, null)
    assert.equal(row?.launcher_pid, null)
    assert.equal(settled.runIdentity('contention-run')?.status, 'failed')
    const competing = directAdmission(fixture.repo, 'Compete for the leased ref.', fixture.head)
    assert.throws(
      () => settled.beginSubmissionAdmission(competing.input),
      /pending admission lease already exists/
    )
    settled.close()
  } finally {
    await rm(fixture.temp, { force: true, recursive: true })
    restore()
  }
})

test('a launched admission with a dead launcher is reclaimed instead of replayed', async () => {
  const restore = scrubLaunchEnvironment()
  const intent = 'Relaunch a submission whose coordinator died.'
  const fixture = await directFixture('onm-dead-launcher-', intent)
  process.env.ORCA_CLI_COMMAND = await fakeOrcaCli(fixture.temp, 'relaunch-run')
  try {
    const { admissionId, input } = directAdmission(fixture.repo, intent, fixture.head)
    const ledger = new DomainLedger({ repositoryPath: fixture.repo })
    ledger.beginSubmissionAdmission(input)
    ledger.markSubmissionLaunched(admissionId, await deadPid())
    ledger.close()

    await assert.rejects(main(['run', '--repo', fixture.repo, '--intent', intent]))

    const settled = new DomainLedger({ repositoryPath: fixture.repo })
    const row = settled.submissionAdmission(admissionId)
    assert.equal(row?.status, 'failed')
    assert.equal(row?.run_id, null)
    settled.close()
  } finally {
    await rm(fixture.temp, { force: true, recursive: true })
    restore()
  }
})

test('a launched admission with a live launcher still replays without relaunching', async () => {
  const restore = scrubLaunchEnvironment()
  const intent = 'Replay a submission whose coordinator lives.'
  const fixture = await directFixture('onm-live-launcher-', intent)
  try {
    const { admissionId, input } = directAdmission(fixture.repo, intent, fixture.head)
    const ledger = new DomainLedger({ repositoryPath: fixture.repo })
    ledger.beginSubmissionAdmission(input)
    ledger.markSubmissionLaunched(admissionId, process.pid)
    ledger.close()

    const lines: string[] = []
    const originalLog = console.log
    console.log = (line: unknown) => {
      lines.push(String(line))
    }
    try {
      await main(['run', '--repo', fixture.repo, '--intent', intent])
    } finally {
      console.log = originalLog
    }
    assert.deepEqual(JSON.parse(lines[0]!), { admissionId, replayed: true, runId: null })

    const settled = new DomainLedger({ repositoryPath: fixture.repo })
    const row = settled.submissionAdmission(admissionId)
    assert.equal(row?.status, 'launched')
    assert.equal(row?.run_id, null)
    settled.close()
  } finally {
    await rm(fixture.temp, { force: true, recursive: true })
    restore()
  }
})

test('pruning a run removes its accepted admission and retains leased runs', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-prune-admission-'))
  try {
    execFileSync('git', ['init', '-b', 'main', temp], { stdio: 'ignore' })
    const repo = await realpath(temp)
    const start = (runId: string) => ({
      baseBranch: 'main',
      branch: 'feature',
      intent: `Intent for ${runId}.`,
      policySha256: sha256('policy'),
      repoRoot: repo,
      runId,
      submissionCommitOid: oid('1')
    })
    const ledger = new DomainLedger({ repositoryPath: repo })
    ledger.startRun(start('prunable-run'))
    ledger.settleRun('prunable-run', 'failed')
    ledger.startRun(start('leased-run'))
    ledger.settleRun('leased-run', 'failed')
    ledger.acquireLease({ branch: 'feature', repoRoot: temp, runId: 'leased-run' })

    const gateIdentity = sha256(canonicalJson({ gatePath: path.join(repo, 'gate.git'), repoRoot: repo }))
    const admitted = {
      admissionId: deriveAdmissionId({
        gateIdentity,
        intent: 'Prune with the bound admission.',
        newOid: oid('2'),
        oldOid: oid('3'),
        refName: 'refs/heads/feature'
      }),
      gateIdentity,
      intent: 'Prune with the bound admission.',
      newOid: oid('2'),
      oldOid: oid('3'),
      refName: 'refs/heads/feature',
      repoRoot: repo,
      source: 'direct' as const
    }
    ledger.beginSubmissionAdmission(admitted)
    ledger.markSubmissionLaunched(admitted.admissionId)
    ledger.bindSubmissionAdmission(admitted.admissionId, 'leased-run')
    ledger.markSubmissionAccepted({
      acceptedOid: oid('2'),
      admissionId: admitted.admissionId,
      runId: 'leased-run'
    })
    ledger.close()

    const pruning = new DomainLedger({ repositoryPath: repo })
    assert.equal(pruning.prune(['prunable-run']), 1)
    assert.equal(pruning.prune(['leased-run']), 0)
    assert.ok(pruning.submissionAdmission(admitted.admissionId))
    pruning.releaseLease('leased-run')
    assert.equal(pruning.prune(['leased-run']), 1)
    assert.equal(pruning.submissionAdmission(admitted.admissionId), undefined)
    pruning.close()
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('a stale coordinator generation cannot clobber the fresh coordinator pid', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-coordinator-fence-'))
  try {
    const readinessPath = path.join(temp, 'admissions', 'admission.json')
    const lockPath = launchLockPath(readinessPath)
    await mkdir(path.dirname(lockPath), { recursive: true })
    await mkdir(lockPath)
    await writeFile(path.join(lockPath, 'nonce'), 'generation-b')
    await writeFile(path.join(lockPath, 'owner'), `${process.pid}`)
    await writeFile(path.join(lockPath, 'coordinator'), '4194304')

    await assert.rejects(
      recordCoordinatorLaunch(lockPath, 'generation-a'),
      /launch generation changed/
    )
    assert.equal(await readFile(path.join(lockPath, 'coordinator'), 'utf8'), '4194304')
    assert.equal(
      await readFile(path.join(lockPath, 'coordinator-generation'), 'utf8').then(
        () => 'present',
        () => 'absent'
      ),
      'absent'
    )

    await recordCoordinatorLaunch(lockPath, 'generation-b')
    assert.equal(await readFile(path.join(lockPath, 'coordinator'), 'utf8'), `${process.pid}`)
    assert.equal(
      await readFile(path.join(lockPath, 'coordinator-generation'), 'utf8'),
      'generation-b'
    )
    assert.equal((await readAdmissionLaunchClaim(lockPath))?.coordinatorPid, process.pid)

    await writeFile(path.join(lockPath, 'coordinator-generation'), 'generation-a')
    assert.equal((await readAdmissionLaunchClaim(lockPath))?.coordinatorPid, undefined)

    await rm(path.join(lockPath, 'coordinator-generation'))
    assert.equal((await readAdmissionLaunchClaim(lockPath))?.coordinatorPid, process.pid)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
