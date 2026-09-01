import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { CommandRunner } from '../scripts/github.ts'
import { DomainLedger, evidenceSha256 } from '../scripts/ledger.ts'
import {
  admitCandidatePublication,
  publishCandidate
} from '../scripts/publication.ts'

const POLICY = 'f'.repeat(64)
const TIME = '2026-09-01T12:00:00.000Z'
const OID = '0123456789abcdef'.repeat(3)

type Context = {
  artifactPath: string
  attemptId: string
  base: string
  candidate: string
  destination: string
  forgedDigest: string
  generationToken: number
  ledger: DomainLedger
  runId: string
  temp: string
}

async function setup(name: string, forgeDigest: boolean): Promise<Context> {
  const temp = await mkdtemp(path.join(tmpdir(), `onm-review4-${name}-`))
  const repoRoot = path.join(temp, 'source')
  const runId = `run-${name}`
  const attemptId = `attempt-${name}`
  const base = `${OID}1`
  const candidate = `${OID}2`
  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
  ledger.setRepositoryPublicationRoute({
    actorId: 'A_actor',
    actorLogin: 'owner',
    actorNodeId: 'AN_actor',
    backend: 'gh',
    backendVersion: 'test',
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
  })
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
    summary: 'lint passed',
    workerIdentity: 'lint-worker'
  }
  const digest = evidenceSha256(
    forgeDigest ? { ...lintEntry, summary: 'a different summary' } : lintEntry
  )
  ledger.recordEvidence({
    artifactPath: path.join(temp, 'lint.json'),
    artifactSha256: lintEntry.artifactSha256,
    baseCommitOid: base,
    candidateCommitOid: candidate,
    evidenceSha256: digest,
    exitCode: 0,
    roundIndex: 0,
    runId,
    stageId: 'lint',
    summary: lintEntry.summary,
    workerIdentity: lintEntry.workerIdentity
  })
  ledger.recordStageDisposition({
    disposition: 'satisfied',
    evidenceSha256: digest,
    runId,
    stageId: 'lint'
  })
  const generationToken = ledger.acquireLease({ branch: 'feature', repoRoot, runId })
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
    forgedDigest: digest,
    generationToken,
    ledger,
    runId,
    temp
  }
}

function fakeTransport(): CommandRunner {
  let head: string | null = null
  return async (_executable, args) => {
    if (args[0] === 'ls-remote') {
      if (head === null) return { code: 2, stdout: '', stderr: '' }
      return { code: 0, stdout: `${head}\t${args[4]}\n`, stderr: '' }
    }
    if (args[0] === 'push') {
      head = args[4]!.split(':')[0]!
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 127, stdout: '', stderr: 'unexpected command' }
  }
}

test('publication rejects retained evidence whose digest does not match its recorded fields', async () => {
  const context = await setup('forged-digest', true)
  try {
    const runner = fakeTransport()
    await admitCandidatePublication({
      ledger: context.ledger,
      runId: context.runId,
      destination: context.destination,
      runner,
      observedAt: TIME
    })
    await assert.rejects(
      publishCandidate({
        ledger: context.ledger,
        runId: context.runId,
        attemptId: context.attemptId,
        generationToken: context.generationToken,
        destination: context.destination,
        artifactPath: context.artifactPath,
        workerIdentity: 'publisher',
        runner,
        now: () => TIME
      }),
      /retained evidence digest does not match its recorded fields/
    )
    assert.ok(!context.ledger.remoteReceipt(context.runId, 'candidate-publication'))
  } finally {
    context.ledger.close()
    await rm(context.temp, { recursive: true, force: true })
  }
})

test('publication settles when retained evidence matches its recorded digest', async () => {
  const context = await setup('consistent-digest', false)
  try {
    const runner = fakeTransport()
    await admitCandidatePublication({
      ledger: context.ledger,
      runId: context.runId,
      destination: context.destination,
      runner,
      observedAt: TIME
    })
    const result = await publishCandidate({
      ledger: context.ledger,
      runId: context.runId,
      attemptId: context.attemptId,
      generationToken: context.generationToken,
      destination: context.destination,
      artifactPath: context.artifactPath,
      workerIdentity: 'publisher',
      runner,
      now: () => TIME
    })
    assert.equal(result.outcome, 'created')
    assert.ok(context.ledger.remoteReceipt(context.runId, 'candidate-publication'))
  } finally {
    context.ledger.close()
    await rm(context.temp, { recursive: true, force: true })
  }
})
