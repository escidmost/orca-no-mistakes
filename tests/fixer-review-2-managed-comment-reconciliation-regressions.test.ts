import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { GithubIssueCommentObservation, GithubPullRequestObservation } from '../scripts/github.ts'
import { DomainLedger, evidenceSha256, sha256 } from '../scripts/ledger.ts'
import { bindPullRequest, PullRequestBindingError } from '../scripts/pull-request.ts'

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
  const routeFingerprint = ledger.setRepositoryPublicationRoute({
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
  ledger.recordPublicationRoute({ ...route, runId })
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
  return { ledger, routeFingerprint }
}

test('managed comment reconciliation is deferred until after settleRemoteStage succeeds', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'onm-pr-reconcile-defer-'))
  const intent = 'ONM-80: defer managed comment reconciliation'
  const runId = 'run-defer-reconcile'
  const { ledger, routeFingerprint } = await setupLedgerWithSettledPush(home, runId, intent)

  try {
    const existingPr = pullRequestFixture()
    let observeExactCallCount = 0

    const remotelyExposedComments: GithubIssueCommentObservation[] = [{
      author: { id: 'A_node', login: 'bot' },
      body: '<!-- orca-no-mistakes:managed-summary:v1 -->\n## Pipeline Summary\n\n- Pipeline stages completed without publishable details.\n\n- Candidate: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`\n- Pipeline Evidence Root: `cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc`\n- Run: `run-defer-reconcile`\n',
      createdAt: '2026-09-01T00:00:03.000Z',
      id: 'comment-node-1',
      updatedAt: '2026-09-01T00:00:03.000Z',
      url: 'https://example.test/comment/1'
    }]

    // Seed an unresolved create intent from a prior attempt
    const genPrior = startNextAttempt(ledger, runId, 'att-prior')
    ledger.recordMutationIntent({
      attemptId: 'att-prior',
      createdAt: '2026-09-01T00:00:02.000Z',
      kind: 'managed-comment',
      payload: {
        action: 'ensure-managed-summary',
        bodySha256: sha256(remotelyExposedComments[0].body),
        managedCommentNodeId: null,
        number: existingPr.number
      },
      runId,
      targetFingerprint: routeFingerprint
    })

    const pendingBefore = ledger.unresolvedManagedCommentCreateIntent(runId)
    assert.ok(pendingBefore)

    // Attempt 1: observes the comment, but facts change before settlement during second observeExact
    const gen1 = startNextAttempt(ledger, runId, 'attempt-1')

    const authorityFailBeforeSettlement = {
      createIssueComment: async () => assert.fail('unexpected createIssueComment'),
      createPullRequest: async () => assert.fail('unexpected createPullRequest'),
      observeIssueComments: async () => remotelyExposedComments,
      observePullRequests: async () => {
        observeExactCallCount++
        if (observeExactCallCount === 1) {
          return { exact: existingPr, nearMatches: [] }
        }
        return { exact: pullRequestFixture({ state: 'CLOSED' }), nearMatches: [] }
      },
      updateIssueComment: async () => {}
    }

    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(home, 'pr-att1.json'),
        attemptId: 'attempt-1',
        authority: authorityFailBeforeSettlement,
        candidateCommitOid: OID,
        generationToken: gen1,
        intent,
        ledger,
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId,
        stageSummaries: [],
        workerIdentity: 'coordinator'
      }),
      (err: unknown) =>
        err instanceof PullRequestBindingError &&
        /pull-request facts changed before settlement/.test(err.message)
    )

    // Unresolved intent must NOT be resolved because settlement did not succeed!
    const pendingAfterFailure = ledger.unresolvedManagedCommentCreateIntent(runId)
    assert.ok(pendingAfterFailure, 'unresolved intent must remain pending when binding fails before settlement')
    assert.equal(pendingAfterFailure.intentSha256, pendingBefore.intentSha256)

    // Attempt 2: retry succeeds all the way through settlement
    const gen2 = startNextAttempt(ledger, runId, 'attempt-2')

    const authoritySuccess = {
      createIssueComment: async () => assert.fail('unexpected createIssueComment'),
      createPullRequest: async () => assert.fail('unexpected createPullRequest'),
      observeIssueComments: async () => remotelyExposedComments,
      observePullRequests: async () => ({ exact: existingPr, nearMatches: [] }),
      updateIssueComment: async () => {}
    }

    const result = await bindPullRequest({
      artifactPath: path.join(home, 'pr-att2.json'),
      attemptId: 'attempt-2',
      authority: authoritySuccess,
      candidateCommitOid: OID,
      generationToken: gen2,
      intent,
      ledger,
      pipelineEvidenceRoot: 'c'.repeat(64),
      runId,
      stageSummaries: [],
      workerIdentity: 'coordinator'
    })

    assert.equal(result.number, existingPr.number)
    assert.equal(result.commentNodeId, 'comment-node-1')
    assert.ok(ledger.remoteReceipt(runId, 'pull-request-binding'))

    // Now after successful settlement, the intent must be durably resolved
    assert.equal(ledger.unresolvedManagedCommentCreateIntent(runId), undefined)
  } finally {
    ledger.close()
    await rm(home, { force: true, recursive: true })
  }
})
