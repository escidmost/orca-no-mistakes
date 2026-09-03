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
  PullRequestBindingError
} from '../scripts/pull-request.ts'

const OID = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
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

test('definite authentication failure during comment create resolves intent so resume can retry', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'onm-definite-auth-failure-'))
  const intent = 'ONM-80: retry after definite authentication failure'
  const runId = 'run-definite-auth'
  const { ledger } = await setupLedgerWithSettledPush(home, runId, intent)

  try {
    const existingPr = pullRequestFixture()
    let commentCallCount = 0
    let createdComment: GithubIssueCommentObservation | null = null

    // Attempt 1 fails with definite authentication failure
    const gen1 = startNextAttempt(ledger, runId, 'att-auth-fail')
    const failingAuthority = {
      createIssueComment: async () => {
        commentCallCount += 1
        throw new GithubAuthorityError('authentication', 'create-issue-comment', 'Bad credentials')
      },
      createPullRequest: async () => assert.fail('unexpected createPullRequest'),
      observeIssueComments: async () => (createdComment ? [createdComment] : []),
      observePullRequests: async () => ({ exact: existingPr, nearMatches: [] }),
      updateIssueComment: async () => {}
    }

    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(home, 'pr-att1.json'),
        attemptId: 'att-auth-fail',
        authority: failingAuthority,
        candidateCommitOid: OID,
        generationToken: gen1,
        intent,
        ledger,
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId,
        stageSummaries: ['summary'],
        workerIdentity: 'coordinator'
      }),
      (err: unknown) => err instanceof GithubAuthorityError && err.kind === 'authentication'
    )

    assert.equal(commentCallCount, 1)
    // The definite failure must be resolved, not left poisoning resume
    assert.equal(ledger.unresolvedManagedCommentCreateIntent(runId), undefined)

    // Attempt 2 (resume after fixing credentials) must succeed and create the comment
    const gen2 = startNextAttempt(ledger, runId, 'att-auth-fixed')
    const fixedAuthority = {
      createIssueComment: async (input: { body: string; subjectId: string }) => {
        commentCallCount += 1
        createdComment = {
          author: { id: 'A_node', login: 'bot' },
          body: input.body,
          createdAt: '2026-09-01T00:01:00.000Z',
          id: 'comment-created-after-auth-fix',
          updatedAt: '2026-09-01T00:01:00.000Z',
          url: 'https://example.test/comment/c1'
        }
      },
      createPullRequest: async () => assert.fail('unexpected createPullRequest'),
      observeIssueComments: async () => (createdComment ? [createdComment] : []),
      observePullRequests: async () => ({ exact: existingPr, nearMatches: [] }),
      updateIssueComment: async () => {}
    }

    const result = await bindPullRequest({
      artifactPath: path.join(home, 'pr-att2.json'),
      attemptId: 'att-auth-fixed',
      authority: fixedAuthority,
      candidateCommitOid: OID,
      generationToken: gen2,
      intent,
      ledger,
      pipelineEvidenceRoot: 'c'.repeat(64),
      runId,
      stageSummaries: ['summary'],
      workerIdentity: 'coordinator'
    })

    assert.equal(commentCallCount, 2)
    assert.equal(result.commentNodeId, 'comment-created-after-auth-fix')
    assert.equal(ledger.unresolvedManagedCommentCreateIntent(runId), undefined)
  } finally {
    ledger.close()
    await rm(home, { force: true, recursive: true })
  }
})

test('lease lost after observation before comment mutation resolves intent so resume can retry', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'onm-lease-lost-mutation-'))
  const intent = 'ONM-80: retry after lease lost before mutation'
  const runId = 'run-lease-lost'
  const { ledger } = await setupLedgerWithSettledPush(home, runId, intent)

  try {
    const existingPr = pullRequestFixture()
    let commentCallCount = 0
    let createdComment: GithubIssueCommentObservation | null = null

    // Attempt 1: release lease after recordMutationIntent before requireLease/createIssueComment
    const gen1 = startNextAttempt(ledger, runId, 'att-lease-lost')
    const originalRecord = ledger.recordMutationIntent.bind(ledger)
    ledger.recordMutationIntent = (input) => {
      const intentSha = originalRecord(input)
      if (input.kind === 'managed-comment') {
        ledger.releaseLease(runId)
      }
      return intentSha
    }
    const leaseLosingAuthority = {
      createIssueComment: async () => {
        commentCallCount += 1
      },
      createPullRequest: async () => assert.fail('unexpected createPullRequest'),
      observeIssueComments: async () => [],
      observePullRequests: async () => ({ exact: existingPr, nearMatches: [] }),
      updateIssueComment: async () => {}
    }

    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(home, 'pr-att1.json'),
        attemptId: 'att-lease-lost',
        authority: leaseLosingAuthority,
        candidateCommitOid: OID,
        generationToken: gen1,
        intent,
        ledger,
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId,
        stageSummaries: ['summary'],
        workerIdentity: 'coordinator'
      }),
      /pull-request binding lease is no longer owned/
    )

    ledger.recordMutationIntent = originalRecord
    assert.equal(commentCallCount, 0, 'createIssueComment was never called')
    assert.equal(ledger.unresolvedManagedCommentCreateIntent(runId), undefined)

    // Attempt 2: reacquire lease and retry, must succeed without poisoning
    const gen2 = startNextAttempt(ledger, runId, 'att-lease-recovered')
    const recoveredAuthority = {
      createIssueComment: async (input: { body: string; subjectId: string }) => {
        commentCallCount += 1
        createdComment = {
          author: { id: 'A_node', login: 'bot' },
          body: input.body,
          createdAt: '2026-09-01T00:02:00.000Z',
          id: 'comment-created-after-lease-recovered',
          updatedAt: '2026-09-01T00:02:00.000Z',
          url: 'https://example.test/comment/c2'
        }
      },
      createPullRequest: async () => assert.fail('unexpected createPullRequest'),
      observeIssueComments: async () => (createdComment ? [createdComment] : []),
      observePullRequests: async () => ({ exact: existingPr, nearMatches: [] }),
      updateIssueComment: async () => {}
    }

    const result = await bindPullRequest({
      artifactPath: path.join(home, 'pr-att2.json'),
      attemptId: 'att-lease-recovered',
      authority: recoveredAuthority,
      candidateCommitOid: OID,
      generationToken: gen2,
      intent,
      ledger,
      pipelineEvidenceRoot: 'c'.repeat(64),
      runId,
      stageSummaries: ['summary'],
      workerIdentity: 'coordinator'
    })

    assert.equal(commentCallCount, 1)
    assert.equal(result.commentNodeId, 'comment-created-after-lease-recovered')
    assert.equal(ledger.unresolvedManagedCommentCreateIntent(runId), undefined)
  } finally {
    ledger.close()
    await rm(home, { force: true, recursive: true })
  }
})

test('indeterminate mutation failure leaves intent unresolved and blocks automatic retry', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'onm-indeterminate-create-'))
  const intent = 'ONM-80: block automatic retry after indeterminate mutation'
  const runId = 'run-indeterminate-mutation'
  const { ledger } = await setupLedgerWithSettledPush(home, runId, intent)

  try {
    const existingPr = pullRequestFixture()
    let commentCallCount = 0

    // Attempt 1 fails with indeterminate mutation
    const gen1 = startNextAttempt(ledger, runId, 'att-indeterminate')
    const indeterminateAuthority = {
      createIssueComment: async () => {
        commentCallCount += 1
        throw new GithubAuthorityError('mutation-indeterminate', 'create-issue-comment', 'socket reset')
      },
      createPullRequest: async () => assert.fail('unexpected createPullRequest'),
      observeIssueComments: async () => [],
      observePullRequests: async () => ({ exact: existingPr, nearMatches: [] }),
      updateIssueComment: async () => {}
    }

    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(home, 'pr-att1.json'),
        attemptId: 'att-indeterminate',
        authority: indeterminateAuthority,
        candidateCommitOid: OID,
        generationToken: gen1,
        intent,
        ledger,
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId,
        stageSummaries: ['summary'],
        workerIdentity: 'coordinator'
      }),
      (err: unknown) => err instanceof PullRequestBindingError && /managed summary mutation was not proven/.test(err.message)
    )

    assert.equal(commentCallCount, 1)
    // Indeterminate failure MUST remain unresolved
    const unresolved = ledger.unresolvedManagedCommentCreateIntent(runId)
    assert.ok(unresolved, 'indeterminate create must remain unresolved')

    // Attempt 2 (resume while comment is still absent) must fail closed without issuing another create
    const gen2 = startNextAttempt(ledger, runId, 'att-resume-indeterminate')
    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(home, 'pr-att2.json'),
        attemptId: 'att-resume-indeterminate',
        authority: indeterminateAuthority,
        candidateCommitOid: OID,
        generationToken: gen2,
        intent,
        ledger,
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId,
        stageSummaries: ['summary'],
        workerIdentity: 'coordinator'
      }),
      (err: unknown) =>
        err instanceof PullRequestBindingError &&
        /unresolved managed comment create intent .* requires manual resolution/.test(err.message)
    )

    assert.equal(commentCallCount, 1, 'must not call createIssueComment again')
  } finally {
    ledger.close()
    await rm(home, { force: true, recursive: true })
  }
})
