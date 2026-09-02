import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  admissionReadinessPath,
  deriveAdmissionId,
  deriveFallbackGateIdentity,
  initializeLocalGate,
  repositoryGatePaths
} from '../scripts/admission.ts'
import { main } from '../scripts/orca-no-mistakes.ts'
import { DomainLedger } from '../scripts/ledger.ts'

const oid = (character: string) => character.repeat(40)

function git(repo: string, ...args: string[]): string {
  return String(execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })).trim()
}

async function commitAll(repo: string, file: string, contents: string, message: string): Promise<void> {
  await writeFile(path.join(repo, file), contents)
  git(repo, 'add', file)
  git(repo, 'commit', '-m', message)
}

test('init inherits the source object format and a never-fetched non-main default branch', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-format-'))
  try {
    execFileSync('git', ['init', '--object-format=sha256', '-b', 'trunk', path.join(temp, 'repo')], { stdio: 'ignore' })
    const repo = await realpath(path.join(temp, 'repo'))
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await commitAll(repo, 'file.txt', 'first\n', 'first')
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', path.join(temp, 'origin.git')])
    const metadata = await initializeLocalGate(repo, process.argv[1]!)
    assert.equal(metadata.defaultBranch, 'trunk')
    assert.equal(git(metadata.gatePath, 'rev-parse', '--show-object-format'), 'sha256')
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('init fails closed and rolls back when the origin default branch is ambiguous', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-ambiguous-'))
  try {
    const origin = path.join(temp, 'origin.git')
    execFileSync('git', ['init', '-b', 'trunk', path.join(temp, 'repo')], { stdio: 'ignore' })
    const repo = await realpath(path.join(temp, 'repo'))
    execFileSync('git', ['init', '--bare', '-b', 'trunk', origin], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin], { stdio: 'ignore' })
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await commitAll(repo, 'file.txt', 'first\n', 'first')
    git(repo, 'push', 'origin', 'trunk')
    git(repo, 'checkout', '-b', 'feature')
    await commitAll(repo, 'file.txt', 'second\n', 'second')
    git(repo, 'push', 'origin', 'feature')
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/missing')
    const paths = repositoryGatePaths(repo)
    await assert.rejects(initializeLocalGate(repo, process.argv[1]!), /could not determine the default branch/)
    assert.equal(git(repo, 'remote', 'get-url', 'origin'), origin)
    assert.throws(() => git(repo, 'remote', 'get-url', 'orca-no-mistakes'))
    assert.equal(existsSync(paths.gatePath), false)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('gate admit replays only accepted admissions, not launched ones', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-replay-'))
  const intent = 'Replay only accepted admissions.'
  const encodedIntent = Buffer.from(intent).toString('base64url')
  const origin = path.join(temp, 'origin.git')
  try {
    execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
    const repo = await realpath(path.join(temp, 'repo'))
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin], { stdio: 'ignore' })
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await commitAll(repo, 'file.txt', 'first\n', 'first')
    git(repo, 'checkout', '-b', 'feature')
    await commitAll(repo, 'file.txt', 'second\n', 'second')
    git(repo, 'push', 'origin', 'main', 'feature')
    const metadata = await initializeLocalGate(repo, process.argv[1]!)
    const head = git(repo, 'rev-parse', 'HEAD')
    execFileSync('git', ['--git-dir', metadata.gatePath, 'fetch', '--quiet', repo, head])

    const admissionId = deriveAdmissionId({
      gateIdentity: metadata.gateIdentity,
      intent,
      newOid: head,
      oldOid: oid('0'),
      refName: 'refs/heads/feature'
    })
    let ledger = new DomainLedger({ repositoryPath: repo })
    ledger.beginSubmissionAdmission({
      admissionId,
      gateIdentity: metadata.gateIdentity,
      intent,
      newOid: head,
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
      runId: 'gate-replay-run',
      submissionCommitOid: head
    })
    ledger.bindSubmissionAdmission(admissionId, 'gate-replay-run')
    ledger.close()

    const readinessPath = admissionReadinessPath(metadata, admissionId)
    await mkdir(path.dirname(readinessPath), { recursive: true })
    await mkdir(`${readinessPath}.lock`)
    await writeFile(readinessPath, `${JSON.stringify({ error: 'probe-no-replay', state: 'failed' })}\n`)

    const originalStdin = process.stdin
    const previousCount = process.env.GIT_PUSH_OPTION_COUNT
    const previousOption = process.env.GIT_PUSH_OPTION_0
    const originalLog = console.log
    const lines: string[] = []
    const feed = (): NodeJS.ReadableStream =>
      Readable.from([`${oid('0')} ${head} refs/heads/feature\n`]) as unknown as NodeJS.ReadableStream
    const setStdin = (stream: NodeJS.ReadableStream): void => {
      Object.defineProperty(process, 'stdin', { value: stream, configurable: true })
    }
    try {
      process.env.GIT_PUSH_OPTION_COUNT = '1'
      process.env.GIT_PUSH_OPTION_0 = `no-mistakes.intent=${encodedIntent}`
      console.log = (line: unknown) => {
        lines.push(String(line))
      }
      setStdin(feed())
      await assert.rejects(
        main(['gate', 'admit', '--gate', metadata.gatePath]),
        /probe-no-replay/
      )
      ledger = new DomainLedger({ repositoryPath: repo })
      ledger.markSubmissionAccepted({
        acceptedOid: head,
        admissionId,
        runId: 'gate-replay-run'
      })
      ledger.close()
      setStdin(feed())
      await main(['gate', 'admit', '--gate', metadata.gatePath])
    } finally {
      setStdin(originalStdin)
      if (previousCount === undefined) delete process.env.GIT_PUSH_OPTION_COUNT
      else process.env.GIT_PUSH_OPTION_COUNT = previousCount
      if (previousOption === undefined) delete process.env.GIT_PUSH_OPTION_0
      else process.env.GIT_PUSH_OPTION_0 = previousOption
      console.log = originalLog
    }
    const replay = JSON.parse(lines.at(-1) ?? '{}') as { replayed?: boolean; runId?: string }
    assert.equal(replay.replayed, true)
    assert.equal(replay.runId, 'gate-replay-run')
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('a repeated direct submission replays instead of relaunching a coordinator', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-direct-replay-'))
  const firstIntent = 'Validate the first direct submission.'
  const secondIntent = 'Validate a second direct submission.'
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
    const head = git(repo, 'rev-parse', 'HEAD')
    const paths = repositoryGatePaths(repo)
    const gateIdentity = deriveFallbackGateIdentity(paths)

    const beginDirect = (intent: string): string =>
      deriveAdmissionId({
        gateIdentity,
        intent,
        newOid: head,
        oldOid: head,
        refName: 'refs/heads/feature'
      })
    const launchedId = beginDirect(firstIntent)
    let ledger = new DomainLedger({ repositoryPath: repo })
    ledger.beginSubmissionAdmission({
      admissionId: launchedId,
      gateIdentity,
      intent: firstIntent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/feature',
      repoRoot: paths.commonDir,
      source: 'direct'
    })
    ledger.markSubmissionLaunched(launchedId)
    ledger.close()

    const originalLog = console.log
    const lines: string[] = []
    try {
      console.log = (line: unknown) => {
        lines.push(String(line))
      }
      await main(['run', '--repo', repo, '--intent', firstIntent])
    } finally {
      console.log = originalLog
    }
    ledger = new DomainLedger({ repositoryPath: repo })
    ledger.failSubmissionAdmission(launchedId)
    ledger.close()

    const acceptedId = beginDirect(secondIntent)
    ledger = new DomainLedger({ repositoryPath: repo })
    ledger.beginSubmissionAdmission({
      admissionId: acceptedId,
      gateIdentity,
      intent: secondIntent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/feature',
      repoRoot: paths.commonDir,
      source: 'direct'
    })
    ledger.markSubmissionLaunched(acceptedId)
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: secondIntent,
      policySha256: 'c'.repeat(64),
      repoRoot: paths.repoRoot,
      runId: 'direct-replay-run',
      submissionCommitOid: head
    })
    ledger.bindSubmissionAdmission(acceptedId, 'direct-replay-run')
    ledger.markSubmissionAccepted({
      acceptedOid: head,
      admissionId: acceptedId,
      runId: 'direct-replay-run'
    })
    ledger.close()

    try {
      console.log = (line: unknown) => {
        lines.push(String(line))
      }
      await main(['run', '--repo', repo, '--intent', secondIntent])
    } finally {
      console.log = originalLog
    }
    const launched = JSON.parse(lines[0] ?? '{}') as { replayed?: boolean; runId?: string | null }
    assert.equal(launched.replayed, true)
    assert.equal(launched.runId, null)
    const accepted = JSON.parse(lines[1] ?? '{}') as { replayed?: boolean; runId?: string }
    assert.equal(accepted.replayed, true)
    assert.equal(accepted.runId, 'direct-replay-run')
    ledger = new DomainLedger({ repositoryPath: repo })
    assert.equal(ledger.submissionAdmission(launchedId)?.status, 'failed')
    assert.equal(ledger.submissionAdmission(acceptedId)?.status, 'accepted')
    ledger.close()
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
