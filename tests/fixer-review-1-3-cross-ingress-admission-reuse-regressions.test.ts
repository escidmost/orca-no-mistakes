import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  deriveAdmissionId,
  initializeLocalGate,
  repositoryGatePaths
} from '../scripts/admission.ts'
import { main } from '../scripts/orca-no-mistakes.ts'
import { canonicalJson, DomainLedger, sha256 } from '../scripts/ledger.ts'

const oid = (character: string) => character.repeat(40)

function git(repo: string, ...args: string[]): string {
  return String(execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })).trim()
}

async function commitAll(repo: string, file: string, contents: string, message: string): Promise<void> {
  await writeFile(path.join(repo, file), contents)
  git(repo, 'add', file)
  git(repo, 'commit', '-m', message)
}

test('admission rows are reused across ingress and retried under the retrying source', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-cross-ingress-'))
  const intent = 'Converge direct and gate ingress.'
  try {
    execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
    const repo = await realpath(path.join(temp, 'repo'))
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await commitAll(repo, 'file.txt', 'first\n', 'first')
    const head = git(repo, 'rev-parse', 'HEAD')
    const paths = repositoryGatePaths(repo)
    const gateIdentity = sha256(
      canonicalJson({ gatePath: paths.gatePath, repoRoot: paths.repoRoot })
    )
    const linkedRoot = `${repo}-linked`
    const admissionId = deriveAdmissionId({
      gateIdentity,
      intent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/feature'
    })
    const admissionInput = (repoRoot: string, source: 'direct' | 'gate') => ({
      admissionId,
      gateIdentity,
      intent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/feature',
      repoRoot,
      source
    })
    const ledger = new DomainLedger({ repositoryPath: repo })
    const gateRow = ledger.beginSubmissionAdmission(admissionInput(paths.repoRoot, 'gate'))
    assert.equal(gateRow.status, 'pending')
    const directRow = ledger.beginSubmissionAdmission(admissionInput(linkedRoot, 'direct'))
    assert.equal(directRow.admission_id, admissionId)
    assert.equal(directRow.status, 'pending')
    assert.equal(directRow.source, 'gate')

    ledger.failSubmissionAdmission(admissionId)
    assert.equal(ledger.submissionAdmission(admissionId)?.status, 'failed')
    const retried = ledger.beginSubmissionAdmission(admissionInput(linkedRoot, 'direct'))
    assert.equal(retried.status, 'pending')
    assert.equal(retried.source, 'direct')

    assert.throws(
      () =>
        ledger.beginSubmissionAdmission({
          ...admissionInput(linkedRoot, 'direct'),
          gateIdentity: sha256(
            canonicalJson({ gatePath: paths.gatePath, repoRoot: linkedRoot })
          )
        }),
      /does not match its identity/
    )

    const otherAdmissionId = deriveAdmissionId({
      gateIdentity,
      intent,
      newOid: oid('1'),
      oldOid: oid('1'),
      refName: 'refs/heads/feature'
    })
    assert.throws(
      () =>
        ledger.beginSubmissionAdmission({
          admissionId: otherAdmissionId,
          gateIdentity,
          intent,
          newOid: oid('1'),
          oldOid: oid('1'),
          refName: 'refs/heads/feature',
          repoRoot: paths.repoRoot,
          source: 'gate'
        }),
      /pending admission lease already exists/
    )

    ledger.markSubmissionLaunched(admissionId)
    const relaunched = ledger.beginSubmissionAdmission(admissionInput(paths.repoRoot, 'gate'))
    assert.equal(relaunched.status, 'launched')
    ledger.close()
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('direct runs launch from linked worktrees sharing the repository gate', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-linked-worktree-'))
  const intent = 'Run direct submissions from any linked worktree.'
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
    const metadata = await initializeLocalGate(repo, process.argv[1]!)
    const head = git(repo, 'rev-parse', 'HEAD')
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'feature2', path.join(temp, 'linked'), 'feature'], { stdio: 'ignore' })
    const linkedRoot = await realpath(path.join(temp, 'linked'))
    const admissionId = deriveAdmissionId({
      gateIdentity: metadata.gateIdentity,
      intent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/feature2'
    })
    const ledger = new DomainLedger({ repositoryPath: repo })
    ledger.beginSubmissionAdmission({
      admissionId,
      gateIdentity: metadata.gateIdentity,
      intent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/feature2',
      repoRoot: linkedRoot,
      source: 'direct'
    })
    ledger.markSubmissionLaunched(admissionId)
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature2',
      intent,
      policySha256: oid('c').slice(0, 64),
      repoRoot: linkedRoot,
      runId: 'linked-worktree-run',
      submissionCommitOid: head
    })
    ledger.bindSubmissionAdmission(admissionId, 'linked-worktree-run')
    ledger.markSubmissionAccepted({
      acceptedOid: head,
      admissionId,
      runId: 'linked-worktree-run'
    })
    ledger.finishRun('linked-worktree-run', 'passed')
    ledger.close()

    const originalLog = console.log
    const lines: string[] = []
    try {
      console.log = (line: unknown) => {
        lines.push(String(line))
      }
      await main(['run', '--repo', linkedRoot, '--intent', intent])
    } finally {
      console.log = originalLog
    }
    const replay = JSON.parse(lines[0] ?? '{}') as { replayed?: boolean; runId?: string }
    assert.equal(replay.replayed, true)
    assert.equal(replay.runId, 'linked-worktree-run')
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('failed init restores the saved push URLs exactly', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-init-pushurl-'))
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
    git(repo, 'remote', 'add', 'orca-no-mistakes', path.join(temp, 'previous.git'))
    git(repo, 'config', '--add', 'remote.orca-no-mistakes.pushurl', 'file:///tmp/first.git')
    git(repo, 'config', '--add', 'remote.orca-no-mistakes.pushurl', 'file:///tmp/second.git')
    const paths = repositoryGatePaths(repo)
    await mkdir(paths.gatePath, { recursive: true })
    await assert.rejects(initializeLocalGate(repo, process.argv[1]!), /not a bare repository/)
    assert.equal(
      git(repo, 'config', '--get-all', 'remote.orca-no-mistakes.pushurl'),
      'file:///tmp/first.git\nfile:///tmp/second.git'
    )
    assert.equal(
      git(repo, 'remote', 'get-url', 'orca-no-mistakes'),
      path.join(temp, 'previous.git')
    )
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
