import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { GithubPullRequestObservation } from '../scripts/github.ts'
import { bindPullRequest, PullRequestBindingError } from '../scripts/pull-request.ts'

const OID = 'a'.repeat(40)
const content = { body: 'complete body', title: 'feat: complete report' }

function pullRequest(overrides: Partial<GithubPullRequestObservation> = {}): GithubPullRequestObservation {
  return {
    baseBranch: 'main',
    baseOid: 'b'.repeat(40),
    baseRepositoryId: '1',
    baseRepositoryNodeId: 'R_base',
    body: content.body,
    draft: false,
    headBranch: 'feature',
    headOid: OID,
    headRepositoryId: '2',
    headRepositoryNodeId: 'R_head',
    id: 'PR_node',
    number: 7,
    state: 'OPEN' as const,
    title: content.title,
    url: 'https://github.com/acme/repo/pull/7',
    ...overrides
  }
}

function harness() {
  const settlements: Array<Record<string, unknown>> = []
  let ownsLease = true
  const ledger = {
    heartbeatLease: () => {},
    ownsLease: () => ownsLease,
    publicationRoute: () => ({
      base_branch: 'main', base_repository_id: '1', forge_host: 'github.com',
      head_branch: 'feature', head_owner: 'forker', head_repository_id: '2',
      route_fingerprint: 'route'
    }),
    recordMutationIntent: () => 'mutation-intent',
    recordRemoteObservation: () => 'post-read',
    remoteReceipt: (_runId: string, kind: string) => kind === 'candidate-publication'
      ? { candidate_commit_oid: OID, receipt_sha256: 'push-receipt' }
      : undefined,
    repositoryPublicationRoute: () => ({
      base_repository_name: 'acme/repo', base_repository_node_id: 'R_base',
      head_repository_name: 'forker/repo', head_repository_node_id: 'R_head',
      route_fingerprint: 'route'
    }),
    run: () => ({ branch: 'feature', repo_root: '/repo' }),
    settleRemoteStage: (input: Record<string, unknown>) => {
      settlements.push(input)
      return { receiptSha256: 'pr-receipt' }
    }
  }
  return { ledger, settlements, setOwnsLease: (value: boolean) => { ownsLease = value } }
}

test('updates the original PR body and settles only after merge', async () => {
  const { ledger, settlements } = harness()
  let pr = pullRequest({ body: 'stale body', title: 'stale title' })
  let updates = 0
  const ready: string[] = []
  const authority = {
    createPullRequest: async () => assert.fail('unexpected PR creation'),
    observePullRequests: async () => ({ exact: pr, nearMatches: [] }),
    updatePullRequest: async ({ body, title }: { body: string; title: string }) => {
      updates += 1
      pr = pullRequest({ body, title })
    }
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-binding-'))
  try {
    const result = await bindPullRequest({
      artifactPath: path.join(directory, 'pr.json'),
      attemptId: 'attempt',
      authority,
      candidateCommitOid: OID,
      content,
      generationToken: 1,
      ledger: ledger as never,
      onReady: async ({ url }) => {
        assert.equal(settlements.length, 0)
        ready.push(url)
      },
      pipelineEvidenceRoot: 'c'.repeat(64),
      runId: 'run',
      sleep: async () => {
        assert.equal(settlements.length, 0)
        pr = pullRequest({ state: 'MERGED' })
      },
      workerIdentity: 'coordinator'
    })
    assert.equal(updates, 1)
    assert.deepEqual(ready, ['https://github.com/acme/repo/pull/7'])
    assert.equal(result.outcome, 'updated')
    assert.equal(settlements.length, 1)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('rejects conflicting or closed pull requests before mutation', async () => {
  const { ledger } = harness()
  let mutations = 0
  let observation: { exact: GithubPullRequestObservation | null; nearMatches: GithubPullRequestObservation[] } = {
    exact: null,
    nearMatches: [pullRequest()]
  }
  const authority = {
    createPullRequest: async () => { mutations += 1 },
    observePullRequests: async () => observation,
    updatePullRequest: async () => { mutations += 1 }
  }
  await assert.rejects(
    bindPullRequest({
      artifactPath: '/tmp/unwritten', attemptId: 'attempt', authority,
      candidateCommitOid: OID, content, generationToken: 1, ledger: ledger as never,
      pipelineEvidenceRoot: 'c'.repeat(64), runId: 'run', workerIdentity: 'coordinator'
    }),
    (error: unknown) => error instanceof PullRequestBindingError && /near matches/.test(error.message)
  )
  observation = { exact: pullRequest({ state: 'CLOSED' }), nearMatches: [] }
  await assert.rejects(
    bindPullRequest({
      artifactPath: '/tmp/unwritten', attemptId: 'attempt', authority,
      candidateCommitOid: OID, content, generationToken: 1, ledger: ledger as never,
      pipelineEvidenceRoot: 'c'.repeat(64), runId: 'run', workerIdentity: 'coordinator'
    }),
    /closed without merging/
  )
  assert.equal(mutations, 0)
})

test('rejects lease loss and PR identity drift while awaiting merge', async () => {
  const { ledger, setOwnsLease, settlements } = harness()
  let pr = pullRequest()
  const authority = {
    createPullRequest: async () => assert.fail('unexpected PR creation'),
    observePullRequests: async () => ({ exact: pr, nearMatches: [] }),
    updatePullRequest: async () => assert.fail('unexpected PR update')
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-drift-'))
  try {
    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(directory, 'pr.json'), attemptId: 'attempt', authority,
        candidateCommitOid: OID, content, generationToken: 1, ledger: ledger as never,
        pipelineEvidenceRoot: 'c'.repeat(64), runId: 'run',
        sleep: async () => { pr = pullRequest({ id: 'replacement', number: 8 }) },
        workerIdentity: 'coordinator'
      }),
      /facts changed while awaiting merge/
    )
    assert.equal(settlements.length, 0)

    pr = pullRequest()
    setOwnsLease(false)
    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(directory, 'lease.json'), attemptId: 'attempt', authority,
        candidateCommitOid: OID, content, generationToken: 1, ledger: ledger as never,
        pipelineEvidenceRoot: 'c'.repeat(64), runId: 'run', workerIdentity: 'coordinator'
      }),
      /lease/
    )
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
