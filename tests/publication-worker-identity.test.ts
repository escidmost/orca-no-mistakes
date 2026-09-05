import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
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

const runner: CommandRunner = async (_executable, args) => {
  if (args[0] === 'config') return { code: 1, stdout: '', stderr: '' }
  if (args[0] === 'ls-remote') {
    return args.includes('refs/heads/feature') && args.includes('--exit-code')
      ? { code: 0, stdout: `${OID}2\trefs/heads/feature\n`, stderr: '' }
      : { code: 2, stdout: '', stderr: '' }
  }
  return { code: 127, stdout: '', stderr: `unexpected command: ${args[0]}` }
}

async function fixture(name: string): Promise<{
  artifactPath: string
  destination: string
  ledger: DomainLedger
  publish: (workerIdentity: string) => ReturnType<typeof publishCandidate>
  runId: string
  temp: string
}> {
  const temp = await mkdtemp(path.join(tmpdir(), `onm-pub-identity-${name}-`))
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
    publish: (workerIdentity: string) =>
      publishCandidate({
        ledger,
        runId,
        attemptId,
        generationToken,
        destination,
        resolveRepositoryIdentity,
        artifactPath: path.join(temp, 'artifacts', 'push.json'),
        workerIdentity,
        runner,
        now: () => TIME
      }),
    runId,
    temp
  }
}

test('publication rejects a non-authoritative worker identity before mutation', async () => {
  const context = await fixture('advisory')
  try {
    await assert.rejects(
      context.publish('coordinator:fixer-guardrail-advisory'),
      /publication worker identity is not authoritative/
    )
    assert.equal(
      context.ledger
        .listEvidence(context.runId)
        .some((row) => row.stage_id === 'push'),
      false
    )
    assert.equal(existsSync(context.artifactPath), false)
    const retry = await context.publish('publisher')
    assert.equal(retry.outcome, 'unchanged')
  } finally {
    context.ledger.close()
    await rm(context.temp, { force: true, recursive: true })
  }
})
