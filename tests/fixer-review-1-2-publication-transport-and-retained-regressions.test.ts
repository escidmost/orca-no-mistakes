import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { CommandRunner } from '../scripts/github.ts'
import {
  DomainLedger,
  evidenceSha256,
  sha256,
  type RepositoryPublicationRouteInput
} from '../scripts/ledger.ts'
import {
  admitCandidatePublication,
  publishCandidate,
  type RepositoryIdentityResolver
} from '../scripts/publication.ts'

const POLICY = 'f'.repeat(64)
const TIME = '2026-09-01T12:00:00.000Z'
const OID = '0123456789abcdef'.repeat(3)

function fakeRemote(candidate: string): CommandRunner & { pushes(): number } {
  let head: string | null = null
  let pushes = 0
  const runner: CommandRunner & { pushes(): number } = async (_executable, args) => {
    if (args[0] === 'config') return { code: 1, stdout: '', stderr: '' }
    if (args[0] === 'ls-remote') {
      if (head === null) return { code: 2, stdout: '', stderr: '' }
      return { code: 0, stdout: `${head}\t${args[4]}\n`, stderr: '' }
    }
    if (args[0] === 'push') {
      const lease = args.find((argument) => argument.startsWith('--force-with-lease='))
      const expected = lease === undefined ? undefined : lease.split(':')[1]
      if (expected === undefined || (head ?? '') !== expected) {
        return { code: 1, stdout: '', stderr: 'fetch first' }
      }
      head = candidate
      pushes += 1
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 127, stdout: '', stderr: 'unexpected command' }
  }
  runner.pushes = () => pushes
  return runner
}

type Context = {
  candidate: string
  destination: string
  ledger: DomainLedger
  lintArtifactPath: string
  pushArtifactPath: string
  publish: (
    runner: CommandRunner,
    destination?: string
  ) => Promise<{ outcome: string; receiptSha256: string }>
  runId: string
  temp: string
}

async function fixture(name: string): Promise<Context> {
  const temp = await mkdtemp(path.join(tmpdir(), `onm-pub-transport-${name}-`))
  const repoRoot = path.join(temp, 'source')
  await mkdir(repoRoot, { recursive: true })
  const base = `${OID}1`
  const candidate = `${OID}2`
  const destination = 'https://github.com/owner/repo.git'
  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
  const runId = `run-${name}`
  const route: RepositoryPublicationRouteInput = {
    actorId: 'A1',
    actorLogin: 'owner',
    actorNodeId: 'AN1',
    backend: 'gh',
    backendVersion: 'v1',
    baseBranch: 'main',
    baseRepositoryId: 'R_base',
    baseRepositoryName: 'owner/repo',
    baseRepositoryNodeId: 'RN_base',
    credentialSource: 'GH_TOKEN',
    forgeHost: 'github.com',
    headBranch: 'feature',
    headOwner: 'owner',
    headRepositoryId: 'R_base',
    headRepositoryName: 'owner/repo',
    headRepositoryNodeId: 'RN_base',
    networkRootRepositoryId: 'R_base',
    observedAt: TIME,
    repoRoot
  }
  ledger.setRepositoryPublicationRoute(route)
  ledger.startRun({
    baseBranch: 'main',
    branch: 'feature',
    intent: 'Publish the exact candidate.',
    policySha256: POLICY,
    repoRoot,
    runId,
    stagePlan: [
      { requirement: 'required', stageId: 'lint' },
      { requirement: 'required', stageId: 'push' }
    ],
    submissionCommitOid: base
  })
  ledger.recordCheckpoint({
    inputCommitOid: base,
    outputCommitOid: candidate,
    roundIndex: 0,
    runId,
    stageId: 'lint'
  })
  const artifact = 'lint evidence\n'
  const lintArtifactPath = path.join(temp, 'lint.json')
  await writeFile(lintArtifactPath, artifact)
  const entry = {
    artifactSha256: sha256(artifact),
    baseCommitOid: base,
    candidateCommitOid: candidate,
    exitCode: 0,
    round: 0,
    runId,
    stage: 'lint',
    summary: 'clean',
    workerIdentity: 'lint-worker'
  }
  const digest = evidenceSha256(entry)
  ledger.recordEvidence({
    artifactPath: lintArtifactPath,
    artifactSha256: entry.artifactSha256,
    baseCommitOid: entry.baseCommitOid,
    candidateCommitOid: entry.candidateCommitOid,
    evidenceSha256: digest,
    exitCode: entry.exitCode,
    roundIndex: entry.round,
    runId,
    stageId: entry.stage,
    summary: entry.summary,
    workerIdentity: entry.workerIdentity
  })
  ledger.recordStageDisposition({
    disposition: 'satisfied',
    evidenceSha256: digest,
    runId,
    stageId: 'lint'
  })
  const generationToken = ledger.acquireLease({ branch: 'feature', repoRoot, runId })
  const attemptId = `attempt-${name}`
  ledger.startAttempt({
    actorIdentity: 'operator',
    attemptId,
    coordinatorIdentity: 'coordinator',
    generationToken,
    runId,
    startedAt: TIME
  })
  const resolveRepositoryIdentity: RepositoryIdentityResolver = async () => ({
    id: 'R_base',
    nodeId: 'RN_base'
  })
  const pushArtifactPath = path.join(temp, 'artifacts', 'push.json')
  return {
    candidate,
    destination,
    ledger,
    lintArtifactPath,
    pushArtifactPath,
    publish: (runner: CommandRunner, publishDestination = destination) =>
      publishCandidate({
        ledger,
        runId,
        attemptId,
        generationToken,
        destination: publishDestination,
        resolveRepositoryIdentity,
        artifactPath: pushArtifactPath,
        workerIdentity: 'publisher',
        runner,
        now: () => TIME
      }),
    runId,
    temp
  }
}

async function admit(context: Context, runner: CommandRunner, destination: string): Promise<void> {
  await admitCandidatePublication({
    ledger: context.ledger,
    runId: context.runId,
    destination,
    resolveRepositoryIdentity: async () => ({ id: 'R_base', nodeId: 'RN_base' }),
    runner,
    observedAt: TIME
  })
}

test('publication transport accepts only canonical https and git@github.com destinations', async (t) => {
  await t.test('rejects arbitrary remote-helper schemes', async () => {
    const context = await fixture('helper-scheme')
    try {
      await assert.rejects(
        admit(context, fakeRemote(context.candidate), 'foo://github.com/owner/repo.git'),
        /credential-free github\.com repository/
      )
    } finally {
      context.ledger.close()
      await rm(context.temp, { force: true, recursive: true })
    }
  })

  await t.test('rejects file-like transports', async () => {
    const context = await fixture('file-transport')
    try {
      await assert.rejects(
        admit(context, fakeRemote(context.candidate), 'file:///tmp/other.git'),
        /credential-free github\.com repository/
      )
    } finally {
      context.ledger.close()
      await rm(context.temp, { force: true, recursive: true })
    }
  })

  await t.test('rejects scp syntax with a non-git username', async () => {
    const context = await fixture('scp-user')
    try {
      await assert.rejects(
        admit(context, fakeRemote(context.candidate), 'attacker@github.com:owner/repo.git'),
        /credential-free github\.com repository/
      )
    } finally {
      context.ledger.close()
      await rm(context.temp, { force: true, recursive: true })
    }
  })

  await t.test('accepts canonical git@github.com scp syntax', async () => {
    const context = await fixture('scp-git')
    try {
      const runner = fakeRemote(context.candidate)
      const destination = 'git@github.com:owner/repo.git'
      await admit(context, runner, destination)
      const result = await context.publish(runner, destination)
      assert.equal(result.outcome, 'created')
      assert.equal(runner.pushes(), 1)
    } finally {
      context.ledger.close()
      await rm(context.temp, { force: true, recursive: true })
    }
  })

  await t.test('accepts ssh://git@github.com urls', async () => {
    const context = await fixture('ssh-git')
    try {
      const runner = fakeRemote(context.candidate)
      const destination = 'ssh://git@github.com/owner/repo.git'
      await admit(context, runner, destination)
      const result = await context.publish(runner, destination)
      assert.equal(result.outcome, 'created')
    } finally {
      context.ledger.close()
      await rm(context.temp, { force: true, recursive: true })
    }
  })
})

test('a settled publication retry verifies retained stage evidence', async (t) => {
  await t.test('rejects when a satisfied stage artifact was deleted', async () => {
    const context = await fixture('settled-deleted')
    try {
      const runner = fakeRemote(context.candidate)
      await admit(context, runner, context.destination)
      const first = await context.publish(runner)
      assert.equal(first.outcome, 'created')
      await rm(context.lintArtifactPath, { force: true })
      await assert.rejects(context.publish(runner), /retained evidence is invalid/)
      assert.equal(runner.pushes(), 1)
    } finally {
      context.ledger.close()
      await rm(context.temp, { force: true, recursive: true })
    }
  })

  await t.test('rejects when a satisfied stage artifact was modified', async () => {
    const context = await fixture('settled-modified')
    try {
      const runner = fakeRemote(context.candidate)
      await admit(context, runner, context.destination)
      await context.publish(runner)
      await writeFile(context.lintArtifactPath, 'tampered\n')
      await assert.rejects(context.publish(runner), /retained evidence is invalid/)
      assert.equal(runner.pushes(), 1)
    } finally {
      context.ledger.close()
      await rm(context.temp, { force: true, recursive: true })
    }
  })

  await t.test('reuses the receipt when retained evidence is intact', async () => {
    const context = await fixture('settled-intact')
    try {
      const runner = fakeRemote(context.candidate)
      await admit(context, runner, context.destination)
      const first = await context.publish(runner)
      const second = await context.publish(runner)
      assert.equal(second.outcome, first.outcome)
      assert.equal(second.receiptSha256, first.receiptSha256)
      assert.equal(runner.pushes(), 1)
    } finally {
      context.ledger.close()
      await rm(context.temp, { force: true, recursive: true })
    }
  })
})
