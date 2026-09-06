import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { repositoryIdentityFingerprint } from '../scripts/ledger.ts'

import type { GithubPullRequestObservation } from '../scripts/github.ts'
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
      route_fingerprint: repositoryIdentityFingerprint({ base_repository_id: '1', forge_host: 'github.com', head_owner: 'forker', head_repository_id: '2' })
    }),
    run: () => ({ branch: 'feature', repo_root: '/repo' }),
    settleRemoteStage: (input: Record<string, unknown>) => {
      settlements.push(input)
      return { receiptSha256: 'pr-receipt' }
    }
  }
  return { ledger, settlements, setOwnsLease: (value: boolean) => { ownsLease = value } }
}

test('rejects candidate headOid-only drift with stable PR identity and unchanged content after readiness notification', async () => {
  const { ledger, settlements } = harness()
  let pr = pullRequest()
  const authority = {
    createPullRequest: async () => assert.fail('unexpected PR creation'),
    observePullRequests: async () => ({ exact: pr, nearMatches: [] }),
    updatePullRequest: async () => assert.fail('unexpected PR update')
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-head-drift-'))
  try {
    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(directory, 'pr.json'), attemptId: 'attempt', authority,
        candidateCommitOid: OID, content, generationToken: 1, ledger: ledger as never,
        onReady: async () => {
          pr = pullRequest({ headOid: 'f'.repeat(40) })
        },
        pipelineEvidenceRoot: 'c'.repeat(64), runId: 'run',
        workerIdentity: 'coordinator'
      }),
      /facts changed after readiness notification/
    )
    assert.equal(settlements.length, 0)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
