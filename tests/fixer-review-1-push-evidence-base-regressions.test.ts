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
  publishCandidate
} from '../scripts/publication.ts'

const POLICY = 'f'.repeat(64)
const TIME = '2026-09-01T12:00:00.000Z'
const OID = '0123456789abcdef'.repeat(3)
const resolveRepositoryIdentity = async () => ({ id: 'R_base', nodeId: 'RN_base' })

test('settled push evidence binds the checkpoint input, not the run submission', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-push-evidence-base-'))
  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
  try {
    const repoRoot = path.join(temp, 'source')
    await mkdir(repoRoot, { recursive: true })
    const base = `${OID}1`
    const candidate = `${OID}2`
    const destination = 'https://github.com/owner/repo.git'
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
    const runId = 'run-push-evidence-base'
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
    const attemptId = 'attempt-push-evidence-base'
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId,
      coordinatorIdentity: 'coordinator',
      generationToken,
      runId,
      startedAt: TIME
    })

    let head: string | null = null
    const runner: CommandRunner = async (_executable, args) => {
      if (args[0] === 'config') return { code: 1, stdout: '', stderr: '' }
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

    await admitCandidatePublication({
      ledger,
      runId,
      destination,
      resolveRepositoryIdentity,
      runner,
      observedAt: TIME
    })
    const result = await publishCandidate({
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
    })
    assert.equal(result.outcome, 'created')

    const settled = ledger
      .listEvidence(runId)
      .find((row) => row.stage_id === 'push' && row.round_index === 0)
    assert.equal(settled?.base_commit_oid, candidate)
    const checkpoint = ledger
      .listCheckpoints(runId)
      .find((row) => row.stage_id === 'push' && row.round_index === 0)
    assert.equal(checkpoint?.input_commit_oid, candidate)
    assert.equal(settled?.base_commit_oid, checkpoint?.input_commit_oid)
  } finally {
    ledger.close()
    await rm(temp, { force: true, recursive: true })
  }
})
