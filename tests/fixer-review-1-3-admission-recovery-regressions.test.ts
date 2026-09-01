import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  admissionReadinessPath,
  deriveAdmissionId,
  initializeLocalGate,
  launchLockPath,
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

const gateFixture = async (
  prefix: string,
  intent: string
): Promise<{ head: string; intent: string; metadata: Awaited<ReturnType<typeof initializeLocalGate>>; repo: string; temp: string }> => {
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
  git(repo, 'checkout', '-b', 'feature')
  await commitAll(repo, 'file.txt', 'second\n', 'second')
  git(repo, 'push', '-q', 'origin', 'feature')
  const metadata = await initializeLocalGate(repo, process.argv[1]!)
  const head = git(repo, 'rev-parse', 'HEAD')
  execFileSync('git', ['--git-dir', metadata.gatePath, 'fetch', '--quiet', repo, head])
  return { head, intent, metadata, repo, temp }
}

const feedGateAdmit = async (
  metadata: Awaited<ReturnType<typeof initializeLocalGate>>,
  update: string,
  intent: string,
  run: () => Promise<void>
): Promise<string[]> => {
  const originalStdin = process.stdin
  const previousCount = process.env.GIT_PUSH_OPTION_COUNT
  const previousOption = process.env.GIT_PUSH_OPTION_0
  const originalLog = console.log
  const lines: string[] = []
  const encodedIntent = Buffer.from(intent, 'utf8').toString('base64url')
  try {
    process.env.GIT_PUSH_OPTION_COUNT = '1'
    process.env.GIT_PUSH_OPTION_0 = `no-mistakes.intent=${encodedIntent}`
    console.log = (line: unknown) => {
      lines.push(String(line))
    }
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([update]) as unknown as NodeJS.ReadableStream,
      configurable: true
    })
    await run()
  } finally {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true })
    if (previousCount === undefined) delete process.env.GIT_PUSH_OPTION_COUNT
    else process.env.GIT_PUSH_OPTION_COUNT = previousCount
    if (previousOption === undefined) delete process.env.GIT_PUSH_OPTION_0
    else process.env.GIT_PUSH_OPTION_0 = previousOption
    console.log = originalLog
  }
  return lines
}

test('the gate coordinator rejects a launch without a nonce', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-nonce-required-'))
  try {
    await assert.rejects(
      main([
        'gate',
        'coordinator',
        '--gate',
        path.join(temp, 'gate.git'),
        '--admission-id',
        `admission-${'a'.repeat(64)}`,
        '--readiness',
        path.join(temp, 'readiness.json')
      ]),
      /gate coordinator requires --gate, --admission-id, --readiness, and --launch-nonce/
    )
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('an unfenced coordinator launch records no coordinator pid', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-unfenced-launch-'))
  try {
    const lockPath = path.join(temp, 'admissions', 'admission.lock')
    await mkdir(lockPath, { recursive: true })
    await writeFile(path.join(lockPath, 'nonce'), 'generation-a')
    await writeFile(path.join(lockPath, 'owner'), `${process.pid}`)
    await writeFile(path.join(lockPath, 'coordinator'), '4194304')
    await recordCoordinatorLaunch(lockPath)
    assert.equal(await readFile(path.join(lockPath, 'coordinator'), 'utf8'), '4194304')
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('a materialized pipeline failure before acceptance reclaims the admission', async () => {
  const restore = scrubLaunchEnvironment()
  const intent = 'Retry a materialized submission that lost its branch lease.'
  const fixture = await directFixture('onm-materialized-lease-', intent)
  process.env.ORCA_CLI_COMMAND = await fakeOrcaCli(fixture.temp, 'materialized-run')
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
        admissionId,
        '--admission-materialized'
      ]),
      /already leased by run lease-holder-run/
    )

    const settled = new DomainLedger({ repositoryPath: fixture.repo })
    const row = settled.submissionAdmission(admissionId)
    assert.equal(row?.status, 'pending')
    assert.equal(row?.run_id, null)
    assert.equal(settled.runIdentity('materialized-run')?.status, 'failed')
    settled.close()
  } finally {
    await rm(fixture.temp, { force: true, recursive: true })
    restore()
  }
})

test('a same-head gate push consults the unfinished admission', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-same-head-'))
  const freshIntent = 'Nothing unfinished for this head.'
  const intent = 'Re-engage an unfinished same-head admission.'
  try {
    const fixture = await gateFixture('onm-same-head-', intent)
    const metadata = fixture.metadata
    const update = `${fixture.head} ${fixture.head} refs/heads/feature\n`

    const fresh = await feedGateAdmit(metadata, update, freshIntent, () =>
      main(['gate', 'admit', '--gate', metadata.gatePath])
    )
    assert.deepEqual(JSON.parse(fresh.at(-1) ?? '{}'), { accepted: true, noEvent: true })

    const admissionId = deriveAdmissionId({
      gateIdentity: metadata.gateIdentity,
      intent,
      newOid: fixture.head,
      oldOid: oid('0'),
      refName: 'refs/heads/feature'
    })
    const ledger = new DomainLedger({ repositoryPath: fixture.repo })
    ledger.beginSubmissionAdmission({
      admissionId,
      gateIdentity: metadata.gateIdentity,
      intent,
      newOid: fixture.head,
      oldOid: oid('0'),
      refName: 'refs/heads/feature',
      repoRoot: metadata.repoRoot,
      source: 'gate'
    })
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent,
      policySha256: 'c'.repeat(64),
      repoRoot: metadata.repoRoot,
      runId: 'same-head-run',
      submissionCommitOid: fixture.head
    })
    ledger.bindSubmissionAdmission(admissionId, 'same-head-run')
    ledger.close()

    const readinessPath = admissionReadinessPath(metadata, admissionId)
    const lockPath = launchLockPath(readinessPath)
    await mkdir(path.dirname(readinessPath), { recursive: true })
    await mkdir(lockPath)
    await writeFile(path.join(lockPath, 'nonce'), 'same-head-nonce')
    await writeFile(path.join(lockPath, 'owner'), `${process.pid}`)
    await writeFile(path.join(lockPath, 'coordinator'), `${process.pid}`)
    await writeFile(
      readinessPath,
      `${JSON.stringify({ nonce: 'same-head-nonce', runId: 'same-head-run', state: 'ready' })}\n`
    )

    const replay = await feedGateAdmit(metadata, update, intent, () =>
      main(['gate', 'admit', '--gate', metadata.gatePath])
    )
    assert.equal(
      replay.some((line) => line.includes('"runId":"same-head-run"')),
      true
    )
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('legacy cleanup skips a missing source admission table', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-legacy-admissions-'))
  const legacyPath = path.join(temp, 'legacy.sqlite')
  try {
    await mkdir(path.join(temp, 'repo'))
    const repo = await realpath(path.join(temp, 'repo'))
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])

    const legacy = new DomainLedger(legacyPath)
    legacy.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Migrate from a pre-admission legacy ledger.',
      policySha256: 'f'.repeat(64),
      repoRoot: repo,
      runId: 'legacy-run',
      submissionCommitOid: 'a'.repeat(40)
    })
    legacy.finishRun('legacy-run', 'failed')
    legacy.close()

    const source = new DatabaseSync(legacyPath)
    source.exec('DROP TABLE pending_admission_leases')
    source.exec('DROP TABLE submission_admissions')
    source.close()

    new DomainLedger({ legacyPath, repositoryPath: repo }).close()

    const cleaned = new DatabaseSync(legacyPath)
    assert.equal(
      (
        cleaned.prepare('SELECT COUNT(*) AS count FROM runs').get() as {
          count: number | bigint
        }
      ).count,
      0
    )
    cleaned.close()
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
