import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  deriveAdmissionId,
  deriveFallbackGateIdentity,
  repositoryGatePaths
} from '../scripts/admission.ts'
import type { GithubPullRequestObservation } from '../scripts/github.ts'
import { PIPELINE_STEPS } from '../scripts/config.ts'
import { DomainLedger, evidenceSha256, sha256 } from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'
const OID = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const REPO_ROOT = '/repo'
const STAGES = PIPELINE_STEPS

function localStageEvidence(stage: string, round: number, artifactPath: string, runId: string) {
  const entry = {
    artifactSha256: sha256('{}'),
    baseCommitOid: OID,
    candidateCommitOid: OID,
    evidenceSha256: '',
    exitCode: 0,
    round,
    stage,
    summary: `${stage} satisfied.`,
    workerIdentity: 'coordinator'
  }
  entry.evidenceSha256 = evidenceSha256({ ...entry, runId })
  return { ...entry, artifactPath }
}

function pullRequestFixture(overrides: Partial<GithubPullRequestObservation> = {}): GithubPullRequestObservation {
  return {
    baseBranch: 'main',
    baseOid: BASE,
    baseRepositoryId: '1',
    baseRepositoryNodeId: 'R_base',
    body: 'human body',
    draft: false,
    headBranch: 'feature',
    headOid: OID,
    headRepositoryId: '2',
    headRepositoryNodeId: 'R_head',
    id: 'PR_node',
    number: 7,
    state: 'OPEN',
    title: 'human title',
    url: 'https://github.com/acme/repo/pull/7',
    ...overrides
  }
}

function startNextAttempt(
  ledger: DomainLedger,
  runId: string,
  attemptId: string,
  startedAt: string = new Date().toISOString()
): number {
  ledger.releaseLease(runId)
  const token = ledger.acquireLease({ branch: 'feature', repoRoot: REPO_ROOT, runId })
  ledger.startAttempt({
    actorIdentity: 'operator',
    attemptId,
    coordinatorIdentity: 'coordinator',
    generationToken: token,
    runId,
    startedAt
  })
  return token
}

async function setupLedgerWithSettledPush(home: string, runId: string, intent: string) {
  const ledger = new DomainLedger(':memory:')
  const route = {
    baseBranch: 'main',
    baseRepositoryId: '1',
    forgeHost: 'github.com',
    headBranch: 'feature',
    headOwner: 'forker',
    headRepositoryId: '2'
  }
  ledger.startRun({
    baseBranch: 'main',
    branch: 'feature',
    intent,
    policySha256: 'b'.repeat(64),
    repoRoot: REPO_ROOT,
    runId,
    stagePlan: STAGES.map((stageId) => ({ requirement: 'required' as const, stageId })),
    submissionCommitOid: OID
  })
  const fingerprint = ledger.setRepositoryPublicationRoute({
    actorId: 'actor',
    actorLogin: 'bot',
    actorNodeId: 'A_node',
    backend: 'gh',
    backendVersion: 'test',
    baseBranch: route.baseBranch,
    baseRepositoryId: route.baseRepositoryId,
    baseRepositoryName: 'acme/repo',
    baseRepositoryNodeId: 'R_base',
    credentialSource: 'GITHUB_TOKEN',
    forgeHost: 'github.com',
    headBranch: route.headBranch,
    headOwner: route.headOwner,
    headRepositoryId: route.headRepositoryId,
    headRepositoryName: 'forker/repo',
    headRepositoryNodeId: 'R_head',
    networkRootRepositoryId: '1',
    observedAt: '2026-09-01T00:00:00.000Z',
    repoRoot: REPO_ROOT
  })
  for (const [index, stage] of STAGES.slice(0, 6).entries()) {
    const artifactPath = path.join(home, `${stage}.json`)
    await writeFile(artifactPath, '{}')
    const entry = localStageEvidence(stage, index, artifactPath, runId)
    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: entry.evidenceSha256,
      runId,
      stageId: stage
    })
    ledger.recordEvidence({
      artifactPath,
      artifactSha256: entry.artifactSha256,
      baseCommitOid: entry.baseCommitOid,
      candidateCommitOid: entry.candidateCommitOid,
      evidenceSha256: entry.evidenceSha256,
      exitCode: entry.exitCode,
      roundIndex: entry.round,
      runId,
      stageId: stage,
      summary: entry.summary,
      workerIdentity: entry.workerIdentity
    })
  }
  const generation = ledger.acquireLease({ branch: 'feature', repoRoot: REPO_ROOT, runId })
  ledger.startAttempt({
    actorIdentity: 'operator',
    attemptId: 'att-push',
    coordinatorIdentity: 'coordinator',
    generationToken: generation,
    runId,
    startedAt: '2026-09-01T00:00:01.000Z'
  })
  const routeFingerprint = ledger.recordPublicationRoute({ ...route, runId })
  assert.equal(routeFingerprint, fingerprint)
  ledger.recordPublicationBaseline({
    headCommitOid: null,
    observedAt: '2026-09-01T00:00:02.000Z',
    routeFingerprint,
    runId,
    transportUrl: 'github.com/forker/repo'
  })
  const subject = 'github.com/2:refs/heads/feature'
  const preRead = ledger.recordRemoteObservation({
    attemptId: 'att-push',
    kind: 'publication-head',
    observedAt: '2026-09-01T00:00:02.500Z',
    payload: {
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'forker',
      repositoryId: '2',
      state: 'absent'
    },
    runId,
    subject
  })
  const pushMutation = ledger.recordMutationIntent({
    attemptId: 'att-push',
    createdAt: '2026-09-01T00:00:03.000Z',
    kind: 'candidate-publication',
    payload: { expected: 'absent', update: OID },
    runId,
    targetFingerprint: routeFingerprint
  })
  const pushArtifact = path.join(home, 'push.json')
  await writeFile(pushArtifact, '{}')
  const pushEvidence = localStageEvidence('push', 6, pushArtifact, runId)
  const pushObservation = ledger.recordRemoteObservation({
    attemptId: 'att-push',
    kind: 'publication-head',
    observedAt: '2026-09-01T00:00:04.000Z',
    payload: {
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'forker',
      oid: OID,
      repositoryId: '2'
    },
    runId,
    subject
  })
  ledger.settleRemoteStage({
    checkpoint: { inputCommitOid: OID, outputCommitOid: OID, roundIndex: 6 },
    evidence: {
      artifactPath: pushArtifact,
      artifactSha256: pushEvidence.artifactSha256,
      baseCommitOid: OID,
      candidateCommitOid: OID,
      evidenceSha256: pushEvidence.evidenceSha256,
      exitCode: 0,
      roundIndex: 6,
      runId,
      stageId: 'push',
      summary: pushEvidence.summary,
      workerIdentity: pushEvidence.workerIdentity
    },
    ownership: { branch: 'feature', generationToken: generation, repoRoot: REPO_ROOT },
    receipt: {
      authoritativePostObservationSha256: pushObservation,
      candidateCommitOid: OID,
      kind: 'candidate-publication',
      payload: {
        mutationIntent: pushMutation,
        outcome: 'created',
        postRead: pushObservation,
        preRead,
        routeFingerprint
      }
    },
    runId,
    stageId: 'push'
  })
  return { ledger }
}

const gitExec = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

const commitAll = async (
  repo: string,
  file: string,
  contents: string,
  message: string
): Promise<void> => {
  await writeFile(path.join(repo, file), contents)
  gitExec(repo, 'add', file)
  gitExec(repo, 'commit', '-m', message)
}

const scrubLaunchEnvironment = (): (() => void) => {
  const keys = [
    'NO_MISTAKES_ORIGIN_WORKTREE',
    'NO_MISTAKES_GATE_WORKTREE_ID',
    'NO_MISTAKES_GATE_WORKTREE_ROOT',
    'NO_MISTAKES_DELIVERY_BRANCH',
    'ORCA_CLI_COMMAND',
    'FAKE_ORCA_LOG'
  ]
  const saved = keys.map((key) => [key, process.env[key]] as const)
  for (const key of keys) delete process.env[key]
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('new direct Release 2 run without init fails after admission before creating Orca or domain run', async () => {
  const restore = scrubLaunchEnvironment()
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-direct-no-init-'))
  const intent = 'Reject direct Release 2 run without initialized route.'
  try {
    const fakeOrca = path.join(temp, 'orca')
    await writeFile(fakeOrca, '#!/bin/sh\nprintf \'{"ok":true,"result":{}}\\n\'\n')
    await chmod(fakeOrca, 0o755)
    process.env.ORCA_CLI_COMMAND = fakeOrca
    const origin = path.join(temp, 'origin.git')
    execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
    const repo = await realpath(path.join(temp, 'repo'))
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin], { stdio: 'ignore' })
    gitExec(repo, 'config', 'user.email', 'test@example.com')
    gitExec(repo, 'config', 'user.name', 'Test User')
    await commitAll(repo, 'file.txt', 'first\n', 'first commit')
    gitExec(repo, 'push', '-q', 'origin', 'main')
    gitExec(repo, 'fetch', '-q', 'origin')
    gitExec(repo, 'checkout', '-b', 'feature')
    await commitAll(repo, 'file.txt', 'second\n', 'second commit')
    gitExec(repo, 'push', '-q', 'origin', 'feature')
    gitExec(repo, 'remote', 'set-url', 'origin', 'https://github.com/owner/repo.git')

    const head = gitExec(repo, 'rev-parse', 'HEAD')
    const paths = repositoryGatePaths(repo)
    const gateIdentity = deriveFallbackGateIdentity(paths)
    const admissionId = deriveAdmissionId({
      gateIdentity,
      intent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/feature'
    })
    const ledger = new DomainLedger({ repositoryPath: repo })
    ledger.beginSubmissionAdmission({
      admissionId,
      gateIdentity,
      intent,
      newOid: head,
      oldOid: head,
      refName: 'refs/heads/feature',
      repoRoot: paths.commonDir,
      source: 'direct'
    })
    ledger.markSubmissionLaunched(admissionId)
    ledger.close()

    await assert.rejects(
      main([
        'run',
        '--attached',
        '--repo',
        repo,
        '--intent',
        intent,
        '--admission-id',
        admissionId
      ]),
      /new GitHub runs require successful orca-no-mistakes init/
    )

    const settled = new DomainLedger({ repositoryPath: repo })
    assert.equal(settled.submissionAdmission(admissionId)?.status, 'failed')
    assert.equal(settled.submissionAdmission(admissionId)?.run_id, null)
    assert.deepEqual(settled.listRuns(), [])
    settled.close()
  } finally {
    await rm(temp, { force: true, recursive: true })
    restore()
  }
})
