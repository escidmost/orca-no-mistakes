import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { CommandRunner } from '../scripts/github.ts'
import {
  DomainLedger,
  evidenceSha256,
  type RepositoryPublicationRouteInput
} from '../scripts/ledger.ts'
import {
  admitCandidatePublication,
  publishCandidate,
  type RepositoryIdentity,
  type RepositoryIdentityResolver
} from '../scripts/publication.ts'

const POLICY = 'f'.repeat(64)
const TIME = '2026-09-01T12:00:00.000Z'
const OID = '0123456789abcdef'.repeat(3)

type Setup = {
  artifactPath: string
  attemptId: string
  base: string
  candidate: string
  destination: string
  generationToken: number
  ledger: DomainLedger
  runId: string
  temp: string
}

async function setup(name: string): Promise<Setup> {
  const temp = await mkdtemp(path.join(tmpdir(), `onm-destination-identity-${name}-`))
  const repoRoot = path.join(temp, 'source')
  await mkdir(repoRoot, { recursive: true })
  const base = `${OID}1`
  const candidate = `${OID}2`
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
  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
  const runId = `run-${name}`
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
  const lintEntry = {
    artifactSha256: 'e'.repeat(64),
    baseCommitOid: base,
    candidateCommitOid: candidate,
    exitCode: 0,
    round: 0,
    runId,
    stage: 'lint',
    summary: 'clean',
    workerIdentity: 'lint-worker'
  }
  const lintDigest = evidenceSha256(lintEntry)
  ledger.recordEvidence({
    artifactPath: path.join(temp, 'lint.json'),
    artifactSha256: lintEntry.artifactSha256,
    baseCommitOid: base,
    candidateCommitOid: candidate,
    evidenceSha256: lintDigest,
    exitCode: 0,
    roundIndex: 0,
    runId,
    stageId: 'lint',
    summary: lintEntry.summary,
    workerIdentity: lintEntry.workerIdentity
  })
  ledger.recordStageDisposition({
    disposition: 'satisfied',
    evidenceSha256: lintDigest,
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
  return {
    artifactPath: path.join(temp, 'artifacts', 'push.json'),
    attemptId,
    base,
    candidate,
    destination: 'https://github.com/owner/repo.git',
    generationToken,
    ledger,
    runId,
    temp
  }
}

function fakeTransport(): { runner: CommandRunner } {
  let head: string | null = null
  const runner: CommandRunner = async (_executable, args) => {
    if (args[0] === 'ls-remote') {
      return head === null
        ? { code: 2, stdout: '', stderr: '' }
        : { code: 0, stdout: `${head}\t${args[4]}\n`, stderr: '' }
    }
    if (args[0] === 'push') {
      head = args[4]!.split(':')[0]!
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 127, stdout: '', stderr: 'unexpected command' }
  }
  return { runner }
}

test('admission rejects a destination name that resolves to a different repository', async () => {
  const ctx = await setup('recreated-name')
  try {
    const { runner } = fakeTransport()
    const resolveRepositoryIdentity: RepositoryIdentityResolver = async () => ({
      id: 'R_other',
      nodeId: 'RN_other'
    })
    await assert.rejects(
      admitCandidatePublication({
        ledger: ctx.ledger,
        runId: ctx.runId,
        destination: ctx.destination,
        resolveRepositoryIdentity,
        runner,
        observedAt: TIME
      }),
      /resolves to repository R_other, not the stored route repository R_base/
    )
    assert.ok(ctx.ledger.publicationBaseline(ctx.runId) == null)
  } finally {
    ctx.ledger.close()
    await rm(ctx.temp, { force: true, recursive: true })
  }
})

test('publication refuses to settle when the destination identity changes after the push', async () => {
  const ctx = await setup('post-read-mismatch')
  try {
    const { runner } = fakeTransport()
    const identities: RepositoryIdentity[] = [
      { id: 'R_base', nodeId: 'RN_base' },
      { id: 'R_base', nodeId: 'RN_base' },
      { id: 'R_other', nodeId: 'RN_other' }
    ]
    let cursor = 0
    const resolveRepositoryIdentity: RepositoryIdentityResolver = async () =>
      identities[Math.min(cursor++, identities.length - 1)]!
    await admitCandidatePublication({
      ledger: ctx.ledger,
      runId: ctx.runId,
      destination: ctx.destination,
      resolveRepositoryIdentity,
      runner,
      observedAt: TIME
    })
    await assert.rejects(
      publishCandidate({
        ledger: ctx.ledger,
        runId: ctx.runId,
        attemptId: ctx.attemptId,
        generationToken: ctx.generationToken,
        destination: ctx.destination,
        resolveRepositoryIdentity,
        artifactPath: ctx.artifactPath,
        workerIdentity: 'publisher',
        runner,
        now: () => TIME
      }),
      /could not be re-verified/
    )
    const settled = ctx.ledger
      .listEvidence(ctx.runId)
      .find((row) => row.stage_id === 'push' && row.round_index === 0)
    assert.equal(settled, undefined)
    assert.ok(ctx.ledger.remoteReceipt(ctx.runId, 'candidate-publication') == null)
  } finally {
    ctx.ledger.close()
    await rm(ctx.temp, { force: true, recursive: true })
  }
})

test('publication settles with authoritative destination identity verification', async () => {
  const ctx = await setup('verified')
  try {
    const { runner } = fakeTransport()
    const calls: string[] = []
    const resolveRepositoryIdentity: RepositoryIdentityResolver = async (reference) => {
      calls.push(reference)
      return { id: 'R_base', nodeId: 'RN_base' }
    }
    await admitCandidatePublication({
      ledger: ctx.ledger,
      runId: ctx.runId,
      destination: ctx.destination,
      resolveRepositoryIdentity,
      runner,
      observedAt: TIME
    })
    const result = await publishCandidate({
      ledger: ctx.ledger,
      runId: ctx.runId,
      attemptId: ctx.attemptId,
      generationToken: ctx.generationToken,
      destination: ctx.destination,
      resolveRepositoryIdentity,
      artifactPath: ctx.artifactPath,
      workerIdentity: 'publisher',
      runner,
      now: () => TIME
    })
    assert.equal(result.outcome, 'created')
    assert.deepEqual(calls, ['owner/repo', 'owner/repo', 'owner/repo'])
    assert.ok(ctx.ledger.remoteReceipt(ctx.runId, 'candidate-publication'))
  } finally {
    ctx.ledger.close()
    await rm(ctx.temp, { force: true, recursive: true })
  }
})
