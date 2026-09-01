import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  admissionReadinessPath,
  deriveAdmissionId,
  type GateMetadata,
  initializeLocalGate,
  repositoryGatePaths,
  waitForPermanentRef
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

test('init resolves an unfetched origin default branch from the origin remote itself', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-authoritative-'))
  const origin = path.join(temp, 'origin.git')
  try {
    execFileSync('git', ['init', '--bare', '-b', 'trunk', origin], { stdio: 'ignore' })
    const seed = path.join(temp, 'seed')
    execFileSync('git', ['clone', '--quiet', origin, seed], { stdio: 'ignore' })
    git(seed, 'config', 'user.email', 'test@example.com')
    git(seed, 'config', 'user.name', 'Test User')
    await commitAll(seed, 'file.txt', 'first\n', 'first')
    git(seed, 'push', '--quiet', 'origin', 'trunk')

    execFileSync('git', ['init', '-b', 'feature', path.join(temp, 'repo')], { stdio: 'ignore' })
    const repo = await realpath(path.join(temp, 'repo'))
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await commitAll(repo, 'file.txt', 'unrelated\n', 'unrelated')
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin], { stdio: 'ignore' })

    const metadata = await initializeLocalGate(repo, process.argv[1]!)
    assert.equal(metadata.defaultBranch, 'trunk')
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('init fails closed when no origin evidence and no named local HEAD exist', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-unresolvable-'))
  try {
    execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
    const repo = await realpath(path.join(temp, 'repo'))
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await commitAll(repo, 'file.txt', 'unrelated\n', 'unrelated')
    git(repo, 'checkout', '--detach')
    execFileSync(
      'git',
      ['-C', repo, 'remote', 'add', 'origin', path.join(temp, 'missing-origin.git')],
      { stdio: 'ignore' }
    )
    const paths = repositoryGatePaths(repo)
    await assert.rejects(
      initializeLocalGate(repo, process.argv[1]!),
      /could not determine the default branch/
    )
    assert.equal(existsSync(paths.gatePath), false)
    assert.throws(() => git(repo, 'remote', 'get-url', 'orca-no-mistakes'))
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('init rejects an existing gate whose object format differs from the repository', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-format-clash-'))
  try {
    execFileSync(
      'git',
      ['init', '--object-format=sha256', '-b', 'main', path.join(temp, 'repo')],
      { stdio: 'ignore' }
    )
    const repo = await realpath(path.join(temp, 'repo'))
    execFileSync('git', ['init', '--bare', '-b', 'main', path.join(temp, 'origin.git')], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', path.join(temp, 'origin.git')], { stdio: 'ignore' })
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await commitAll(repo, 'file.txt', 'first\n', 'first')

    await initializeLocalGate(repo, process.argv[1]!)
    const paths = repositoryGatePaths(repo)
    await rm(paths.stateDir, { force: true, recursive: true })
    await mkdir(paths.stateDir, { recursive: true })
    execFileSync(
      'git',
      ['init', '--bare', '--object-format=sha1', '--quiet', paths.gatePath],
      { stdio: 'ignore' }
    )
    execFileSync('git', ['-C', repo, 'remote', 'remove', 'orca-no-mistakes'], { stdio: 'ignore' })

    await assert.rejects(
      initializeLocalGate(repo, process.argv[1]!),
      /object format sha1 does not match the repository object format sha256/
    )
    assert.equal(existsSync(paths.gatePath), true)
    assert.throws(() => git(repo, 'remote', 'get-url', 'orca-no-mistakes'))

    await rm(paths.gatePath, { force: true, recursive: true })
    const metadata = await initializeLocalGate(repo, process.argv[1]!)
    assert.equal(git(metadata.gatePath, 'rev-parse', '--show-object-format'), 'sha256')
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('waitForPermanentRef stops waiting when an aborted new ref never appears', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-aborted-'))
  const gate = path.join(temp, 'gate.git')
  try {
    execFileSync('git', ['init', '--bare', '--quiet', gate], { stdio: 'ignore' })
    const metadata = {
      commonDir: temp,
      defaultBranch: 'main',
      gateIdentity: 'gate-identity',
      gatePath: gate,
      hookVersion: 1,
      remoteName: 'orca-no-mistakes',
      repoRoot: temp,
      stateDir: temp,
      version: 1
    } as GateMetadata
    await assert.rejects(
      waitForPermanentRef(
        metadata,
        { newOid: oid('a'), oldOid: oid('0'), refName: 'refs/heads/feature' },
        1,
        50
      ),
      /did not materialize/
    )
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

async function gateFixture(temp: string, intent: string): Promise<{
  gate: string
  head: string
  metadata: GateMetadata
  repo: string
}> {
  const origin = path.join(temp, 'origin.git')
  execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
  const repo = await realpath(path.join(temp, 'repo'))
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin], { stdio: 'ignore' })
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  await commitAll(repo, 'file.txt', 'first\n', 'first')
  git(repo, 'push', '--quiet', 'origin', 'main')
  git(repo, 'checkout', '-b', 'feature')
  await commitAll(repo, 'file.txt', 'second\n', 'second')
  git(repo, 'push', '--quiet', 'origin', 'feature')
  const metadata = await initializeLocalGate(repo, process.argv[1]!)
  const head = git(repo, 'rev-parse', 'HEAD')
  execFileSync('git', ['--git-dir', metadata.gatePath, 'fetch', '--quiet', repo, head])
  execFileSync(
    'git',
    ['--git-dir', metadata.gatePath, 'update-ref', 'refs/heads/feature', head]
  )
  return { gate: metadata.gatePath, head, metadata, repo }
}

test('a replayed accepted admission anchors gate custody through the coordinator', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-custody-'))
  const intent = 'Anchor custody for an accepted admission.'
  const runId = 'custody-run'
  try {
    const { gate, head, metadata, repo } = await gateFixture(temp, intent)
    const admissionId = deriveAdmissionId({
      gateIdentity: metadata.gateIdentity,
      intent,
      newOid: head,
      oldOid: oid('0'),
      refName: 'refs/heads/feature'
    })
    const ledger = new DomainLedger({ repositoryPath: repo })
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
      policySha256: oid('c'),
      repoRoot: metadata.repoRoot,
      runId,
      submissionCommitOid: head
    })
    ledger.bindSubmissionAdmission(admissionId, runId)
    ledger.markSubmissionAccepted({ acceptedOid: head, admissionId, runId })
    ledger.close()

    const readinessPath = admissionReadinessPath(metadata, admissionId)
    assert.throws(() => git(gate, 'rev-parse', '--verify', `refs/orca-no-mistakes/heads/${runId}`))
    await main([
      'gate',
      'coordinator',
      '--gate',
      gate,
      '--admission-id',
      admissionId,
      '--readiness',
      readinessPath
    ])
    assert.equal(git(gate, 'rev-parse', `refs/orca-no-mistakes/heads/${runId}`), head)
    const readiness = JSON.parse(await readFile(readinessPath, 'utf8')) as {
      runId?: string
      state?: string
    }
    assert.equal(readiness.state, 'ready')
    assert.equal(readiness.runId, runId)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('the coordinator rejects a checkout on another branch before acceptance', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-checkout-'))
  const intent = 'Reject an unbound checkout.'
  try {
    const { gate, head, metadata, repo } = await gateFixture(temp, intent)
    git(repo, 'checkout', '-b', 'other')
    const admissionId = deriveAdmissionId({
      gateIdentity: metadata.gateIdentity,
      intent,
      newOid: head,
      oldOid: oid('0'),
      refName: 'refs/heads/feature'
    })
    const ledger = new DomainLedger({ repositoryPath: repo })
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
    ledger.close()

    const readinessPath = admissionReadinessPath(metadata, admissionId)
    await assert.rejects(
      main([
        'gate',
        'coordinator',
        '--gate',
        gate,
        '--admission-id',
        admissionId,
        '--readiness',
        readinessPath
      ]),
      /the repository checkout is on other but the admission is for refs\/heads\/feature/
    )
    const settled = new DomainLedger({ repositoryPath: repo })
    assert.equal(settled.submissionAdmission(admissionId)?.status, 'failed')
    assert.equal(settled.submissionAdmission(admissionId)?.run_id, null)
    settled.close()
    const readiness = JSON.parse(await readFile(readinessPath, 'utf8')) as { state?: string }
    assert.equal(readiness.state, 'failed')
    assert.throws(() => git(gate, 'rev-parse', '--verify', 'refs/orca-no-mistakes/heads/*'))
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
