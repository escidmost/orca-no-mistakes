import assert from 'node:assert/strict'
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { GithubPullRequestObservation } from '../scripts/github.ts'
import { pullRequestArtifacts } from '../scripts/orca-no-mistakes.ts'
import { bindPullRequest } from '../scripts/pull-request.ts'

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

test('pullRequestArtifacts rejects hard-linked artifacts with multiple links', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-hardlink-'))
  try {
    const target = path.join(directory, 'target.txt')
    await writeFile(target, 'secret data')
    const hardlink = path.join(directory, 'hardlink.txt')
    await link(target, hardlink)
    const single = path.join(directory, 'single.txt')
    await writeFile(single, 'normal data')

    const artifacts = await pullRequestArtifacts(directory, {
      artifacts: ['hardlink.txt', 'single.txt'],
      findings: [],
      summary: 'test'
    })

    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0]?.name, 'Single')
    assert.equal(artifacts[0]?.content, 'normal data')
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('bindPullRequest rejects draft conversion during update before sending onReady', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-draft-race-'))
  const { ledger } = harness()
  let readyCalled = false
  let pr = pullRequest({ body: 'stale body' })
  const authority = {
    createPullRequest: async () => assert.fail('unexpected PR creation'),
    observePullRequests: async () => ({ exact: pr, nearMatches: [] }),
    updatePullRequest: async ({ body, title }: { body: string; title: string }) => {
      pr = pullRequest({ body, draft: true, title })
    }
  }
  try {
    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(directory, 'pr.json'),
        attemptId: 'attempt',
        authority,
        candidateCommitOid: OID,
        content,
        generationToken: 1,
        ledger: ledger as never,
        onReady: async () => {
          readyCalled = true
        },
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId: 'run',
        workerIdentity: 'coordinator'
      }),
      /still a draft/
    )
    assert.equal(readyCalled, false)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('bindPullRequest rejects closed PR during update before sending onReady', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-closed-race-'))
  const { ledger } = harness()
  let readyCalled = false
  let pr = pullRequest({ body: 'stale body' })
  const authority = {
    createPullRequest: async () => assert.fail('unexpected PR creation'),
    observePullRequests: async () => ({ exact: pr, nearMatches: [] }),
    updatePullRequest: async ({ body, title }: { body: string; title: string }) => {
      pr = pullRequest({ body, state: 'CLOSED', title })
    }
  }
  try {
    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(directory, 'pr.json'),
        attemptId: 'attempt',
        authority,
        candidateCommitOid: OID,
        content,
        generationToken: 1,
        ledger: ledger as never,
        onReady: async () => {
          readyCalled = true
        },
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId: 'run',
        workerIdentity: 'coordinator'
      }),
      /closed without merging/
    )
    assert.equal(readyCalled, false)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('bindPullRequest rejects PR identity change during update before sending onReady', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-identity-race-'))
  const { ledger } = harness()
  let readyCalled = false
  let pr = pullRequest({ body: 'stale body' })
  const authority = {
    createPullRequest: async () => assert.fail('unexpected PR creation'),
    observePullRequests: async () => ({ exact: pr, nearMatches: [] }),
    updatePullRequest: async ({ body, title }: { body: string; title: string }) => {
      pr = pullRequest({ body, id: 'DIFFERENT_NODE', number: 99, title })
    }
  }
  try {
    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(directory, 'pr.json'),
        attemptId: 'attempt',
        authority,
        candidateCommitOid: OID,
        content,
        generationToken: 1,
        ledger: ledger as never,
        onReady: async () => {
          readyCalled = true
        },
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId: 'run',
        workerIdentity: 'coordinator'
      }),
      /pull-request body update was not proven by the authoritative post-read/
    )
    assert.equal(readyCalled, false)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
