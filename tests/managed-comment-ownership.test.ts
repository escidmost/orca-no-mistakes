import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { GithubIssueCommentObservation } from '../scripts/github.ts'
import { bindPullRequest } from '../scripts/pull-request.ts'

const OID = 'a'.repeat(40)
const MANAGED_MARKER = '<!-- orca-no-mistakes:managed-summary:v1 -->'

function pullRequest() {
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
    url: 'https://github.com/acme/repo/pull/7'
  }
}

function harness(route: { actor_id: string; actor_login: string; actor_node_id: string | null }) {
  const ledger = {
    publicationRoute: () => ({
      base_branch: 'main', base_repository_id: '1', forge_host: 'github.com',
      head_branch: 'feature', head_owner: 'forker', head_repository_id: '2',
      route_fingerprint: 'route'
    }),
    recordMutationIntent: () => 'intent',
    recordRemoteObservation: () => 'post-read',
    remoteObservation: () => undefined,
    remoteReceipt: (_runId: string, kind: string) => kind === 'candidate-publication'
      ? { candidate_commit_oid: OID, receipt_sha256: 'push-receipt' }
      : undefined,
    repositoryPublicationRoute: () => ({
      actor_id: route.actor_id,
      actor_login: route.actor_login,
      actor_node_id: route.actor_node_id,
      base_repository_name: 'acme/repo', base_repository_node_id: 'R_base',
      head_repository_name: 'forker/repo', head_repository_node_id: 'R_head',
      route_fingerprint: 'route'
    }),
    ownsLease: () => true,
    run: () => ({ branch: 'feature', repo_root: '/repo' }),
    settleRemoteStage: () => ({ receiptSha256: 'pr-receipt' })
  }
  return { ledger }
}

function comment(author: GithubIssueCommentObservation['author'], id: string, body: string): GithubIssueCommentObservation {
  return {
    author, body,
    createdAt: '2026-01-01T00:00:00.000Z', id,
    updatedAt: '2026-01-01T00:00:00.000Z', url: `https://example.test/${id}`
  }
}

const NODE_ROUTE = { actor_id: '12345', actor_login: 'bot', actor_node_id: 'MDQ6VXNlcjE' }

async function bind(
  ledger: Record<string, unknown>,
  authority: Record<string, unknown>
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-ownership-'))
  return bindPullRequest({
    artifactPath: path.join(directory, 'pr.json'), attemptId: 'attempt',
    authority: authority as never, candidateCommitOid: OID, generationToken: 1,
    intent: 'intent', ledger: ledger as never, now: () => '2026-01-01T00:00:00.000Z',
    pipelineEvidenceRoot: 'root', runId: 'run', stageSummaries: [], workerIdentity: 'coordinator'
  })
}

test('proves a newly created managed comment authored under the actor node id', async () => {
  const { ledger } = harness(NODE_ROUTE)
  let comments: GithubIssueCommentObservation[] = []
  let created = 0
  const authority = {
    createIssueComment: async ({ body }: { body: string }) => {
      created += 1
      comments = [comment({ id: 'MDQ6VXNlcjE', login: 'bot' }, 'comment-node', body)]
    },
    createPullRequest: async () => assert.fail('unexpected pull request creation'),
    observeIssueComments: async () => comments,
    observePullRequests: async () => ({ exact: pullRequest(), nearMatches: [] }),
    updateIssueComment: async () => assert.fail('unexpected comment update')
  }
  const result = await bind(ledger, authority)
  assert.equal(created, 1)
  assert.equal(result.outcome, 'updated')
  assert.equal(result.commentNodeId, 'comment-node')
})

test('updates an existing managed comment owned through the actor node id', async () => {
  const { ledger } = harness(NODE_ROUTE)
  let comments: GithubIssueCommentObservation[] = [
    comment({ id: 'MDQ6VXNlcjE', login: 'bot' }, 'comment-node', `${MANAGED_MARKER}\nold`)
  ]
  let update: { body: string; commentId: string } | undefined
  const authority = {
    createIssueComment: async () => assert.fail('unexpected comment creation'),
    createPullRequest: async () => assert.fail('unexpected pull request creation'),
    observeIssueComments: async () => comments,
    observePullRequests: async () => ({ exact: pullRequest(), nearMatches: [] }),
    updateIssueComment: async (input: { body: string; commentId: string }) => {
      update = input
      comments = [{ ...comments[0]!, body: input.body }]
    }
  }
  const result = await bind(ledger, authority)
  assert.equal(update?.commentId, 'comment-node')
  assert.equal(result.outcome, 'updated')
  assert.equal(result.commentNodeId, 'comment-node')
})

test('falls back to the actor login for routes without an actor node id', async () => {
  const { ledger } = harness({ actor_id: '12345', actor_login: 'bot', actor_node_id: null })
  let comments: GithubIssueCommentObservation[] = [
    comment({ id: 'MDQ6VXNlcjE', login: 'bot' }, 'comment-node', `${MANAGED_MARKER}\nold`)
  ]
  let update: { body: string; commentId: string } | undefined
  const authority = {
    createIssueComment: async () => assert.fail('unexpected comment creation'),
    createPullRequest: async () => assert.fail('unexpected pull request creation'),
    observeIssueComments: async () => comments,
    observePullRequests: async () => ({ exact: pullRequest(), nearMatches: [] }),
    updateIssueComment: async (input: { body: string; commentId: string }) => {
      update = input
      comments = [{ ...comments[0]!, body: input.body }]
    }
  }
  const result = await bind(ledger, authority)
  assert.equal(update?.commentId, 'comment-node')
  assert.equal(result.outcome, 'updated')
})

test('does not adopt a marker comment authored by another actor', async () => {
  const { ledger } = harness(NODE_ROUTE)
  const foreign = comment({ id: 'Zm9vYmFy', login: 'impersonator' }, 'foreign-comment', `${MANAGED_MARKER}\nfake`)
  let comments: GithubIssueCommentObservation[] = [foreign]
  let created = 0
  const authority = {
    createIssueComment: async ({ body }: { body: string }) => {
      created += 1
      comments = [foreign, comment({ id: 'MDQ6VXNlcjE', login: 'bot' }, 'comment-node', body)]
    },
    createPullRequest: async () => assert.fail('unexpected pull request creation'),
    observeIssueComments: async () => comments,
    observePullRequests: async () => ({ exact: pullRequest(), nearMatches: [] }),
    updateIssueComment: async () => assert.fail('unexpected comment update')
  }
  const result = await bind(ledger, authority)
  assert.equal(created, 1)
  assert.equal(result.commentNodeId, 'comment-node')
  assert.equal(foreign.body, `${MANAGED_MARKER}\nfake`)
})

test('does not use a matching login when the stored actor node id differs', async () => {
  const { ledger } = harness(NODE_ROUTE)
  const foreign = comment(
    { id: 'different-node', login: 'bot' },
    'foreign-comment',
    `${MANAGED_MARKER}\nfake`
  )
  let comments: GithubIssueCommentObservation[] = [foreign]
  let created = 0
  const authority = {
    createIssueComment: async ({ body }: { body: string }) => {
      created += 1
      comments = [foreign, comment({ id: NODE_ROUTE.actor_node_id, login: 'bot' }, 'comment-node', body)]
    },
    createPullRequest: async () => assert.fail('unexpected pull request creation'),
    observeIssueComments: async () => comments,
    observePullRequests: async () => ({ exact: pullRequest(), nearMatches: [] }),
    updateIssueComment: async () => assert.fail('unexpected comment update')
  }
  const result = await bind(ledger, authority)
  assert.equal(created, 1)
  assert.equal(result.commentNodeId, 'comment-node')
})

test('does not adopt a marker comment without an author', async () => {
  const { ledger } = harness({ actor_id: '12345', actor_login: 'bot', actor_node_id: null })
  const ghost = comment(null, 'ghost-comment', `${MANAGED_MARKER}\nghost`)
  let comments: GithubIssueCommentObservation[] = [ghost]
  let created = 0
  const authority = {
    createIssueComment: async ({ body }: { body: string }) => {
      created += 1
      comments = [ghost, comment({ id: 'MDQ6VXNlcjE', login: 'bot' }, 'comment-node', body)]
    },
    createPullRequest: async () => assert.fail('unexpected pull request creation'),
    observeIssueComments: async () => comments,
    observePullRequests: async () => ({ exact: pullRequest(), nearMatches: [] }),
    updateIssueComment: async () => assert.fail('unexpected comment update')
  }
  const result = await bind(ledger, authority)
  assert.equal(created, 1)
  assert.equal(result.commentNodeId, 'comment-node')
})
