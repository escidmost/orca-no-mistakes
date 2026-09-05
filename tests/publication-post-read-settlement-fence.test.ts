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

class ReclaimingLedger extends DomainLedger {
  #observations = 0
  #reclaimAtObservation: number | undefined
  #reclaim: (() => void) | undefined

  armReclaimAfterObservation(index: number, reclaim: () => void): void {
    this.#reclaimAtObservation = index
    this.#reclaim = reclaim
  }

  override recordRemoteObservation(
    ...args: Parameters<DomainLedger['recordRemoteObservation']>
  ): ReturnType<DomainLedger['recordRemoteObservation']> {
    const result = super.recordRemoteObservation(...args)
    this.#observations += 1
    if (this.#observations === this.#reclaimAtObservation) this.#reclaim?.()
    return result
  }
}

type Context = {
  artifactPath: string
  destination: string
  ledger: DomainLedger
  publish: () => Promise<{ outcome: string }>
  runId: string
  temp: string
}

function fakeRemote(): CommandRunner {
  let head: string | null = null
  return async (_executable, args) => {
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
}

async function fixture(name: string, reclaiming = false): Promise<Context> {
  const temp = await mkdtemp(path.join(tmpdir(), `onm-pub-fence-${name}-`))
  const repoRoot = path.join(temp, 'source')
  await mkdir(repoRoot, { recursive: true })
  const base = `${OID}1`
  const candidate = `${OID}2`
  const destination = 'https://github.com/owner/repo.git'
  const runId = `run-${name}`
  const ledger = reclaiming
    ? new ReclaimingLedger(path.join(temp, 'ledger.sqlite'))
    : new DomainLedger(path.join(temp, 'ledger.sqlite'))
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
  const artifactPath = path.join(temp, 'lint.json')
  await writeFile(artifactPath, artifact)
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
    artifactPath,
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
  return {
    artifactPath: path.join(temp, 'artifacts', 'push.json'),
    destination,
    ledger,
    publish: () =>
      publishCandidate({
        ledger,
        runId,
        attemptId,
        generationToken,
        destination,
        resolveRepositoryIdentity,
        artifactPath: path.join(temp, 'artifacts', 'push.json'),
        workerIdentity: 'publisher',
        runner,
        now: () => TIME
      }),
    runId,
    temp
  }
}

test('publication settlement is fenced when the lease is reclaimed after the post-read', async () => {
  const context = await fixture('reclaim', true)
  const reclaiming = context.ledger as ReclaimingLedger
  reclaiming.armReclaimAfterObservation(2, () => reclaiming.releaseLease(context.runId))
  try {
    await assert.rejects(context.publish(), /no longer owns its branch lease/)
    assert.equal(
      context.ledger.listEvidence(context.runId).some((row) => row.stage_id === 'push'),
      false
    )
    assert.equal(context.ledger.remoteReceipt(context.runId, 'candidate-publication'), undefined)
    assert.equal(
      context.ledger.listCheckpoints(context.runId).some((row) => row.stage_id === 'push'),
      false
    )
  } finally {
    context.ledger.close()
    await rm(context.temp, { force: true, recursive: true })
  }
})

test('publication settles when the lease is retained through settlement', async () => {
  const context = await fixture('retained')
  try {
    const result = await context.publish()
    assert.equal(result.outcome, 'created')
    assert.equal(
      context.ledger.listEvidence(context.runId).some((row) => row.stage_id === 'push'),
      true
    )
    assert.notEqual(context.ledger.remoteReceipt(context.runId, 'candidate-publication'), undefined)
  } finally {
    context.ledger.close()
    await rm(context.temp, { force: true, recursive: true })
  }
})
