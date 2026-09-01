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
import { admitCandidatePublication, publishCandidate } from '../scripts/publication.ts'

const POLICY = 'f'.repeat(64)
const TIME = '2026-09-01T12:00:00.000Z'
const OID = '0123456789abcdef'.repeat(3)
const resolveRepositoryIdentity = async () => ({ id: 'R_base', nodeId: 'RN_base' })

type Setup = {
  artifactPath: string
  attemptId: string
  candidate: string
  destination: string
  generationToken: number
  ledger: DomainLedger
  repoRoot: string
  runId: string
  temp: string
}

async function setup(name: string): Promise<Setup> {
  const temp = await mkdtemp(path.join(tmpdir(), `onm-lease-fence-${name}-`))
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
  const lintArtifactPath = path.join(temp, 'lint.json')
  const lintArtifact = 'lint evidence\n'
  await writeFile(lintArtifactPath, lintArtifact)
  const lintEntry = {
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
  const lintDigest = evidenceSha256(lintEntry)
  ledger.recordEvidence({
    artifactPath: lintArtifactPath,
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
    candidate,
    destination: 'https://github.com/owner/repo.git',
    generationToken,
    ledger,
    repoRoot,
    runId,
    temp
  }
}

function fakeTransport(onPush?: () => void): CommandRunner {
  let head: string | null = null
  const runner: CommandRunner = async (_executable, args) => {
    if (args[0] === 'config') return { code: 1, stdout: '', stderr: '' }
    if (args[0] === 'ls-remote') {
      return head === null
        ? { code: 2, stdout: '', stderr: '' }
        : { code: 0, stdout: `${head}\t${args[4]}\n`, stderr: '' }
    }
    if (args[0] === 'push') {
      onPush?.()
      head = args[4]!.split(':')[0]!
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 127, stdout: '', stderr: 'unexpected command' }
  }
  return runner
}

test('force-reclaiming the branch lease during the push prevents settlement', async () => {
  const ctx = await setup('reclaimed-mid-push')
  try {
    ctx.ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Supersede the stale publisher.',
      policySha256: POLICY,
      repoRoot: ctx.repoRoot,
      runId: 'run-superseder',
      stagePlan: [{ requirement: 'required', stageId: 'lint' }],
      submissionCommitOid: `${OID}9`
    })
    const runner = fakeTransport(() => {
      ctx.ledger.acquireLease({
        branch: 'feature',
        force: true,
        repoRoot: ctx.repoRoot,
        runId: 'run-superseder'
      })
    })
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
      /current branch lease generation|owns the branch lease|no longer owned/
    )
    const settled = ctx.ledger
      .listEvidence(ctx.runId)
      .find((row) => row.stage_id === 'push' && row.round_index === 0)
    assert.equal(settled, undefined)
    assert.ok(ctx.ledger.remoteReceipt(ctx.runId, 'candidate-publication') == null)
    const checkpoint = ctx.ledger
      .listCheckpoints(ctx.runId)
      .find((row) => row.stage_id === 'push' && row.round_index === 0)
    assert.equal(checkpoint, undefined)
  } finally {
    ctx.ledger.close()
    await rm(ctx.temp, { force: true, recursive: true })
  }
})

test('the same fixture settles when the lease is not reclaimed', async () => {
  const ctx = await setup('undisturbed')
  try {
    const runner = fakeTransport()
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
    assert.ok(ctx.ledger.remoteReceipt(ctx.runId, 'candidate-publication'))
  } finally {
    ctx.ledger.close()
    await rm(ctx.temp, { force: true, recursive: true })
  }
})
