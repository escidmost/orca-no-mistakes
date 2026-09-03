import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  GithubAuthorityError,
  type GithubIssueCommentObservation,
  type GithubPullRequestObservation
} from '../scripts/github.ts'
import { DomainLedger, evidenceSha256, sha256 } from '../scripts/ledger.ts'
import {
  bindPullRequest,
  pullRequestContent,
  PullRequestBindingError
} from '../scripts/pull-request.ts'

const OID = 'a'.repeat(40)
const REPO_ROOT = '/repo'
const STAGES = ['intent', 'rebase', 'review', 'test', 'document', 'lint', 'push', 'pr']

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
    baseOid: 'b'.repeat(40),
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

function startNextAttempt(ledger: DomainLedger, runId: string, attemptId: string): number {
  ledger.releaseLease(runId)
  const token = ledger.acquireLease({ branch: 'feature', repoRoot: REPO_ROOT, runId })
  ledger.startAttempt({
    actorIdentity: 'operator',
    attemptId,
    coordinatorIdentity: 'coordinator',
    generationToken: token,
    runId,
    startedAt: new Date().toISOString()
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

test('pullRequestContent caps oversized intents within 65536 bytes while preserving structure', () => {
  const giantIntent = 'feat: add a very large pipeline feature\n' + 'x'.repeat(120_000)
  const result = pullRequestContent(giantIntent)

  assert.equal(result.title, 'feat: add a very large pipeline feature')
  assert.ok(Buffer.byteLength(result.body) <= 65536)
  assert.ok(result.body.startsWith('## Intent\n\n'))
  assert.ok(result.body.endsWith('\n\n## What Changed\n\nCompleted the validated pipeline changes for this run.\n'))
})

test('bindPullRequest caps generated pull request body within GitHub budget', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'onm-pr-budget-'))
  const giantIntent = 'feat: add very long intent\n' + 'y'.repeat(100_000)
  const { ledger } = await setupLedgerWithSettledPush(home, 'run-budget', giantIntent)
  try {
    const generation = startNextAttempt(ledger, 'run-budget', 'att-pr')

    let createdBody: string | undefined
    let pr = pullRequestFixture()
    let comments: GithubIssueCommentObservation[] = [{
      author: { id: 'A_node', login: 'bot' },
      body: '<!-- orca-no-mistakes:managed-summary:v1 -->\nold',
      createdAt: '2026-09-01T00:00:00.000Z',
      id: 'comment-1',
      updatedAt: '2026-09-01T00:00:00.000Z',
      url: 'https://example.test/comment/1'
    }]
    const authority = {
      createIssueComment: async () => {},
      createPullRequest: async (input: { body: string; title: string }) => {
        createdBody = input.body
        pr = pullRequestFixture({ body: input.body, title: input.title })
      },
      observeIssueComments: async () => comments,
      observePullRequests: async () => ({ exact: null, nearMatches: [] }),
      updateIssueComment: async (input: { body: string; commentId: string }) => {
        comments = [{ ...comments[0], body: input.body }]
      }
    }

    await bindPullRequest({
      artifactPath: path.join(home, 'pr.json'),
      attemptId: 'att-pr',
      authority: {
        ...authority,
        observePullRequests: async () => ({ exact: createdBody ? pr : null, nearMatches: [] })
      },
      candidateCommitOid: OID,
      generationToken: generation,
      intent: giantIntent,
      ledger,
      pipelineEvidenceRoot: 'c'.repeat(64),
      runId: 'run-budget',
      stageSummaries: ['summary'],
      workerIdentity: 'coordinator'
    })

    assert.ok(createdBody)
    assert.ok(Buffer.byteLength(createdBody) <= 65536)
  } finally {
    ledger.close()
    await rm(home, { force: true, recursive: true })
  }
})

test('indeterminate comment create fails closed when comment is absent, and reconciles when present', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'onm-pr-reconcile-'))
  const intent = 'ONM-80: reconcile indeterminate comment create'
  const { ledger } = await setupLedgerWithSettledPush(home, 'run-reconcile', intent)
  try {
    const existingPr = pullRequestFixture()
    let createCommentCalls = 0
    let remotelyExposedComments: GithubIssueCommentObservation[] = []
    let createdCommentBody = ''

    const authority = {
      createIssueComment: async (input: { body: string; subjectId: string }) => {
        createCommentCalls += 1
        createdCommentBody = input.body
        throw new GithubAuthorityError('mutation-indeterminate', 'create-issue-comment', 'socket reset')
      },
      createPullRequest: async () => assert.fail('unexpected createPullRequest'),
      observeIssueComments: async () => remotelyExposedComments,
      observePullRequests: async () => ({ exact: existingPr, nearMatches: [] }),
      updateIssueComment: async () => {}
    }

    // Attempt 1: create comment is indeterminate and immediate post-read exposes no comment
    const gen1 = startNextAttempt(ledger, 'run-reconcile', 'attempt-1')

    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(home, 'pr-att1.json'),
        attemptId: 'attempt-1',
        authority,
        candidateCommitOid: OID,
        generationToken: gen1,
        intent,
        ledger,
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId: 'run-reconcile',
        stageSummaries: ['summary'],
        workerIdentity: 'coordinator'
      }),
      (err: unknown) => err instanceof PullRequestBindingError && /managed summary mutation was not proven/.test(err.message)
    )

    assert.equal(createCommentCalls, 1)
    const pendingIntent = ledger.unresolvedManagedCommentCreateIntent('run-reconcile')
    assert.ok(pendingIntent)
    assert.equal(pendingIntent.payload.managedCommentNodeId, null)

    // Attempt 2: fast resume while comment is still absent must fail closed without issuing another create
    const gen2 = startNextAttempt(ledger, 'run-reconcile', 'attempt-2')

    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(home, 'pr-att2.json'),
        attemptId: 'attempt-2',
        authority,
        candidateCommitOid: OID,
        generationToken: gen2,
        intent,
        ledger,
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId: 'run-reconcile',
        stageSummaries: ['summary'],
        workerIdentity: 'coordinator'
      }),
      (err: unknown) =>
        err instanceof PullRequestBindingError &&
        /unresolved managed comment create intent .* requires manual resolution/.test(err.message)
    )

    assert.equal(createCommentCalls, 1)

    // Attempt 3: resume once authoritative read exposes the comment reconciles it without creating another
    const gen3 = startNextAttempt(ledger, 'run-reconcile', 'attempt-3')

    remotelyExposedComments = [{
      author: { id: 'A_node', login: 'bot' },
      body: createdCommentBody,
      createdAt: '2026-09-01T00:00:03.000Z',
      id: 'comment-node-reconciled',
      updatedAt: '2026-09-01T00:00:03.000Z',
      url: 'https://example.test/comment/reconciled'
    }]

    const result = await bindPullRequest({
      artifactPath: path.join(home, 'pr-att3.json'),
      attemptId: 'attempt-3',
      authority,
      candidateCommitOid: OID,
      generationToken: gen3,
      intent,
      ledger,
      pipelineEvidenceRoot: 'c'.repeat(64),
      runId: 'run-reconcile',
      stageSummaries: ['summary'],
      workerIdentity: 'coordinator'
    })

    assert.equal(createCommentCalls, 1)
    assert.equal(result.commentNodeId, 'comment-node-reconciled')
    assert.equal(result.outcome, 'unchanged')
    assert.equal(ledger.unresolvedManagedCommentCreateIntent('run-reconcile'), undefined)
  } finally {
    ledger.close()
    await rm(home, { force: true, recursive: true })
  }
})
