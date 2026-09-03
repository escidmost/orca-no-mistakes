import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { GithubAuthorityError, type GithubIssueCommentObservation } from '../scripts/github.ts'
import { bindPullRequest, managedSummary, PullRequestBindingError } from '../scripts/pull-request.ts'

const OID = 'a'.repeat(40)

function pullRequest(overrides: Record<string, unknown> = {}) {
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
    state: 'OPEN' as const,
    title: 'human title',
    url: 'https://github.com/acme/repo/pull/7',
    ...overrides
  }
}

function harness() {
  const intents: Array<Record<string, unknown>> = []
  const settlements: Array<Record<string, unknown>> = []
  const ledger = {
    publicationRoute: () => ({
      base_branch: 'main', base_repository_id: '1', forge_host: 'github.com',
      head_branch: 'feature', head_owner: 'forker', head_repository_id: '2',
      route_fingerprint: 'route'
    }),
    recordMutationIntent: (input: Record<string, unknown>) => {
      intents.push(input)
      return `intent-${intents.length}`
    },
    recordRemoteObservation: () => 'post-read',
    remoteObservation: () => undefined,
    remoteReceipt: (_runId: string, kind: string) => kind === 'candidate-publication'
      ? { candidate_commit_oid: OID, receipt_sha256: 'push-receipt' }
      : undefined,
    repositoryPublicationRoute: () => ({
      actor_id: 'actor',
      actor_login: 'bot', actor_node_id: 'actor-node',
      base_repository_name: 'acme/repo', base_repository_node_id: 'R_base',
      head_repository_name: 'forker/repo', head_repository_node_id: 'R_head',
      route_fingerprint: 'route'
    }),
    ownsLease: () => true,
    resolveMutationIntent: () => {},
    run: () => ({ branch: 'feature', repo_root: '/repo' }),
    settleRemoteStage: (input: Record<string, unknown>) => {
      settlements.push(input)
      return { receiptSha256: 'pr-receipt' }
    },
    unresolvedManagedCommentCreateIntent: () => undefined
  }
  return { intents, ledger, settlements }
}

test('creates a ready pull request and one managed summary, then settles exact facts', async () => {
  const { intents, ledger, settlements } = harness()
  let pr: ReturnType<typeof pullRequest> | null = null
  let comments: GithubIssueCommentObservation[] = []
  let createdPullRequest: Record<string, unknown> | undefined
  const authority = {
    createIssueComment: async ({ body }: { body: string }) => {
      comments = [{
        author: { id: 'actor-node', login: 'bot' }, body, createdAt: '2026-01-01T00:00:00.000Z', id: 'comment-node',
        updatedAt: '2026-01-01T00:00:00.000Z', url: 'https://example.test/comment'
      }]
    },
    createPullRequest: async (input: Record<string, unknown>) => {
      createdPullRequest = input
      pr = pullRequest({ body: input.body, title: input.title })
    },
    observeIssueComments: async () => comments,
    observePullRequests: async () => ({ exact: pr, nearMatches: [] }),
    updateIssueComment: async () => assert.fail('unexpected comment update')
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-'))
  try {
    process.env.ONM_BINDING_TEST_SECRET = 'secret'
    const result = await bindPullRequest({
      artifactPath: path.join(directory, 'pr.json'),
      attemptId: 'attempt', authority, candidateCommitOid: OID, generationToken: 1,
      intent: 'add remote settlement\nTOKEN=secret', ledger: ledger as never,
      now: (() => { let tick = 0; return () => `2026-01-01T00:00:0${tick++}.000Z` })(),
      pipelineEvidenceRoot: 'root', runId: 'run', stageSummaries: ['lint passed TOKEN=secret'],
      workerIdentity: 'coordinator'
    })
    assert.equal(createdPullRequest?.draft, false)
    assert.equal(createdPullRequest?.title, 'chore: add remote settlement')
    assert.match(String(createdPullRequest?.body), /## Intent[\s\S]*## What Changed/)
    assert.doesNotMatch(String(comments[0]?.body), /secret/)
    assert.equal(result.outcome, 'created')
    assert.equal(result.commentNodeId, 'comment-node')
    assert.equal(intents[1]?.kind, 'managed-comment')
    assert.equal(settlements.length, 1)
  } finally {
    delete process.env.ONM_BINDING_TEST_SECRET
    await rm(directory, { force: true, recursive: true })
  }
})

test('adopts an open pull request without mutating human content', async () => {
  const { ledger } = harness()
  const existing = pullRequest()
  let createCalls = 0
  let update: Record<string, unknown> | undefined
  let comments = [{
    author: { id: 'actor-node', login: 'bot' }, body: '<!-- orca-no-mistakes:managed-summary:v1 -->\nold',
    createdAt: '2026-01-01T00:00:00.000Z', id: 'comment-node',
    updatedAt: '2026-01-01T00:00:00.000Z', url: 'https://example.test/comment'
  }]
  const authority = {
    createIssueComment: async () => { createCalls += 1 },
    createPullRequest: async () => { createCalls += 1 },
    observeIssueComments: async () => comments,
    observePullRequests: async () => ({ exact: existing, nearMatches: [] }),
    updateIssueComment: async (input: { body: string; commentId: string }) => {
      update = input
      comments = [{ ...comments[0], body: input.body }]
    }
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-'))
  try {
    const result = await bindPullRequest({
      artifactPath: path.join(directory, 'pr.json'), attemptId: 'attempt', authority,
      candidateCommitOid: OID, generationToken: 1, intent: 'ignored', ledger: ledger as never,
      pipelineEvidenceRoot: 'root', runId: 'run', stageSummaries: [], workerIdentity: 'coordinator'
    })
    assert.equal(createCalls, 0)
    assert.equal(update?.commentId, 'comment-node')
    assert.equal(existing.title, 'human title')
    assert.equal(existing.body, 'human body')
    assert.equal(result.outcome, 'updated')
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('rejects conflicting near matches and deterministically caps managed summaries', async () => {
  const { ledger } = harness()
  const authority = {
    createIssueComment: async () => {}, createPullRequest: async () => {},
    observeIssueComments: async () => [],
    observePullRequests: async () => ({ exact: null, nearMatches: [pullRequest()] }),
    updateIssueComment: async () => {}
  }
  await assert.rejects(
    bindPullRequest({
      artifactPath: '/tmp/unwritten', attemptId: 'attempt', authority,
      candidateCommitOid: OID, generationToken: 1, intent: 'intent', ledger: ledger as never,
      pipelineEvidenceRoot: 'root', runId: 'run', stageSummaries: [], workerIdentity: 'coordinator'
    }),
    (error: unknown) => error instanceof PullRequestBindingError && /near matches/.test(error.message)
  )
  const summary = managedSummary({
    candidateCommitOid: OID, pipelineEvidenceRoot: 'root', runId: 'run',
    stageSummaries: ['x'.repeat(40_000)]
  })
  assert.ok(Buffer.byteLength(summary) <= 32 * 1024)
  assert.match(summary, /Candidate:/)
  assert.match(summary, /Pipeline Evidence Root:/)
  assert.match(summary, /Run:/)
  assert.equal(summary, managedSummary({
    candidateCommitOid: OID, pipelineEvidenceRoot: 'root', runId: 'run',
    stageSummaries: ['x'.repeat(40_000)]
  }))
})

test('rejects stale lease and mismatched publication receipts before mutation', async () => {
  const { ledger } = harness()
  let mutations = 0
  const authority = {
    createIssueComment: async () => { mutations += 1 },
    createPullRequest: async () => { mutations += 1 },
    observeIssueComments: async () => [],
    observePullRequests: async () => ({ exact: null, nearMatches: [] }),
    updateIssueComment: async () => { mutations += 1 }
  }
  await assert.rejects(bindPullRequest({
    artifactPath: '/tmp/unwritten', attemptId: 'attempt', authority,
    candidateCommitOid: 'b'.repeat(40), generationToken: 1, intent: 'intent',
    ledger: ledger as never, pipelineEvidenceRoot: 'root', runId: 'run',
    stageSummaries: [], workerIdentity: 'coordinator'
  }), /candidate publication/)
  assert.equal(mutations, 0)

  ledger.ownsLease = () => false
  await assert.rejects(bindPullRequest({
    artifactPath: '/tmp/unwritten', attemptId: 'attempt', authority,
    candidateCommitOid: OID, generationToken: 1, intent: 'intent',
    ledger: ledger as never, pipelineEvidenceRoot: 'root', runId: 'run',
    stageSummaries: [], workerIdentity: 'coordinator'
  }), /lease/)
  assert.equal(mutations, 0)
})

test('reconciles indeterminate creation and rejects closed or moved pull requests', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-'))
  const { ledger } = harness()
  let pr: ReturnType<typeof pullRequest> | null = null
  let comments: GithubIssueCommentObservation[] = []
  let observations = 0
  const authority = {
    createIssueComment: async ({ body }: { body: string }) => {
      comments = [{
        author: { id: 'actor-node', login: 'bot' }, body,
        createdAt: '2026-01-01T00:00:00.000Z', id: 'comment-node',
        updatedAt: '2026-01-01T00:00:00.000Z', url: 'https://example.test/comment'
      }]
    },
    createPullRequest: async () => {
      pr = pullRequest()
      throw new GithubAuthorityError('mutation-indeterminate', 'create-pull-request', 'disconnected')
    },
    observeIssueComments: async () => comments,
    observePullRequests: async () => {
      observations += 1
      return { exact: observations > 2 ? pullRequest({ headOid: 'b'.repeat(40) }) : pr, nearMatches: [] }
    },
    updateIssueComment: async () => assert.fail('unexpected comment update')
  }
  try {
    await assert.rejects(bindPullRequest({
      artifactPath: path.join(directory, 'pr.json'), attemptId: 'attempt', authority,
      candidateCommitOid: OID, generationToken: 1, intent: 'intent', ledger: ledger as never,
      pipelineEvidenceRoot: 'root', runId: 'run', stageSummaries: [], workerIdentity: 'coordinator'
    }), /facts changed/)
    const closedAuthority = {
      ...authority,
      observePullRequests: async () => ({ exact: pullRequest({ state: 'CLOSED' }), nearMatches: [] })
    }
    await assert.rejects(bindPullRequest({
      artifactPath: path.join(directory, 'closed.json'), attemptId: 'attempt', authority: closedAuthority,
      candidateCommitOid: OID, generationToken: 1, intent: 'intent', ledger: ledger as never,
      pipelineEvidenceRoot: 'root', runId: 'run', stageSummaries: [], workerIdentity: 'coordinator'
    }), /not open/)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('rejects a different pull request identity before settlement', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-identity-'))
  const { ledger } = harness()
  const original = pullRequest()
  let observations = 0
  let comments: GithubIssueCommentObservation[] = []
  const authority = {
    createIssueComment: async ({ body }: { body: string }) => {
      comments = [{
        author: { id: 'actor-node', login: 'bot' }, body,
        createdAt: '2026-01-01T00:00:00.000Z', id: 'comment-node',
        updatedAt: '2026-01-01T00:00:00.000Z', url: 'https://example.test/comment'
      }]
    },
    createPullRequest: async () => assert.fail('unexpected pull request creation'),
    observeIssueComments: async () => comments,
    observePullRequests: async () => ({
      exact: ++observations === 1
        ? original
        : pullRequest({ id: 'replacement-pr', number: original.number + 1 }),
      nearMatches: []
    }),
    updateIssueComment: async () => assert.fail('unexpected comment update')
  }
  try {
    await assert.rejects(bindPullRequest({
      artifactPath: path.join(directory, 'pr.json'), attemptId: 'attempt', authority,
      candidateCommitOid: OID, generationToken: 1, intent: 'intent', ledger: ledger as never,
      pipelineEvidenceRoot: 'root', runId: 'run', stageSummaries: [], workerIdentity: 'coordinator'
    }), /facts changed/)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('does not adopt human-quoted markers and rejects multiple owned markers', async () => {
  const { ledger } = harness()
  const human = {
    author: { id: 'human', login: 'human' },
    body: `quoted ${'<!-- orca-no-mistakes:managed-summary:v1 -->'}`,
    createdAt: '2026-01-01T00:00:00.000Z', id: 'human-comment',
    updatedAt: '2026-01-01T00:00:00.000Z', url: 'https://example.test/human'
  }
  let comments: GithubIssueCommentObservation[] = [human]
  let created = 0
  const authority = {
    createIssueComment: async ({ body }: { body: string }) => {
      created += 1
      comments.push({ ...human, author: { id: 'actor-node', login: 'bot' }, body, id: 'owned-comment' })
    },
    createPullRequest: async () => assert.fail('unexpected PR creation'),
    observeIssueComments: async () => comments,
    observePullRequests: async () => ({ exact: pullRequest(), nearMatches: [] }),
    updateIssueComment: async () => assert.fail('unexpected comment update')
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-'))
  try {
    await bindPullRequest({
      artifactPath: path.join(directory, 'pr.json'), attemptId: 'attempt', authority,
      candidateCommitOid: OID, generationToken: 1, intent: 'intent', ledger: ledger as never,
      pipelineEvidenceRoot: 'root', runId: 'run', stageSummaries: [], workerIdentity: 'coordinator'
    })
    assert.equal(created, 1)
    assert.equal(comments[0], human)

    comments.push({ ...comments[1]!, id: 'second-owned-comment' })
    await assert.rejects(bindPullRequest({
      artifactPath: path.join(directory, 'ambiguous.json'), attemptId: 'attempt', authority,
      candidateCommitOid: OID, generationToken: 1, intent: 'intent', ledger: ledger as never,
      pipelineEvidenceRoot: 'root', runId: 'run', stageSummaries: [], workerIdentity: 'coordinator'
    }), /multiple managed summary markers/)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
