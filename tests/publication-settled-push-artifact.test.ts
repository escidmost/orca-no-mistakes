import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

function fakeRemote(): CommandRunner {
  let head: string | null = null
  const runner: CommandRunner = async (_executable, args) => {
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
      head = args[4]!.split(':')[0]!
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 127, stdout: '', stderr: 'unexpected command' }
  }
  return runner
}

async function fixture(name: string): Promise<{
  artifactPath: string
  ledger: DomainLedger
  publish: () => Promise<{ candidateCommitOid: string; outcome: string; receiptSha256: string }>
  runId: string
  temp: string
}> {
  const temp = await mkdtemp(path.join(tmpdir(), `onm-pub-settled-${name}-`))
  const repoRoot = path.join(temp, 'source')
  await mkdir(repoRoot, { recursive: true })
  const base = `${OID}1`
  const candidate = `${OID}2`
  const destination = 'https://github.com/owner/repo.git'
  const runId = `run-${name}`
  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
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
  const lintArtifact = 'lint evidence\n'
  const lintArtifactPath = path.join(temp, 'lint.json')
  await writeFile(lintArtifactPath, lintArtifact)
  const entry = {
    artifactSha256: sha256(lintArtifact),
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
  const runner = fakeRemote()
  await admitCandidatePublication({
    ledger,
    runId,
    destination,
    resolveRepositoryIdentity,
    runner,
    observedAt: TIME
  })
  const artifactPath = path.join(temp, 'artifacts', 'push.json')
  return {
    artifactPath,
    ledger,
    publish: () =>
      publishCandidate({
        ledger,
        runId,
        attemptId,
        generationToken,
        destination,
        resolveRepositoryIdentity,
        artifactPath,
        workerIdentity: 'publisher',
        runner,
        now: () => TIME
      }),
    runId,
    temp
  }
}

test('settled retry rejects a deleted push artifact without mutating', async () => {
  const context = await fixture('deleted')
  try {
    const first = await context.publish()
    await rm(context.artifactPath, { force: true })
    await assert.rejects(
      context.publish(),
      /settled push round 0 retained evidence is invalid/
    )
    assert.equal(first.outcome, 'created')
  } finally {
    context.ledger.close()
    await rm(context.temp, { force: true, recursive: true })
  }
})

test('settled retry rejects a modified push artifact', async () => {
  const context = await fixture('modified')
  try {
    await context.publish()
    await writeFile(context.artifactPath, 'tampered\n')
    await assert.rejects(
      context.publish(),
      /settled push round 0 retained evidence is invalid/
    )
  } finally {
    context.ledger.close()
    await rm(context.temp, { force: true, recursive: true })
  }
})

test('settled retry reuses the receipt when the push artifact is intact', async () => {
  const context = await fixture('intact')
  try {
    const first = await context.publish()
    const before = await readFile(context.artifactPath, 'utf8')
    const retry = await context.publish()
    const after = await readFile(context.artifactPath, 'utf8')
    assert.equal(retry.receiptSha256, first.receiptSha256)
    assert.equal(retry.candidateCommitOid, first.candidateCommitOid)
    assert.equal(after, before)
  } finally {
    context.ledger.close()
    await rm(context.temp, { force: true, recursive: true })
  }
})
