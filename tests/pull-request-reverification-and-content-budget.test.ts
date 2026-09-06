import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { GithubPullRequestObservation } from '../scripts/github.ts'
import { sha256 } from '../scripts/ledger.ts'
import {
  bindPullRequest,
  PullRequestBindingError,
  pullRequestContent
} from '../scripts/pull-request.ts'

const OID = 'a'.repeat(40)
const content = { body: 'complete body', title: 'feat: complete report' }

function pullRequest(
  overrides: Partial<GithubPullRequestObservation> = {}
): GithubPullRequestObservation {
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
  const recordedObservations: Array<Record<string, unknown>> = []
  const ledger = {
    heartbeatLease: () => {},
    ownsLease: () => true,
    publicationRoute: () => ({
      base_branch: 'main',
      base_repository_id: '1',
      forge_host: 'github.com',
      head_branch: 'feature',
      head_owner: 'forker',
      head_repository_id: '2',
      route_fingerprint: 'route'
    }),
    recordMutationIntent: () => 'mutation-intent',
    recordRemoteObservation: (input: Record<string, unknown>) => {
      recordedObservations.push(input)
      return 'post-read'
    },
    remoteReceipt: (_runId: string, kind: string) =>
      kind === 'candidate-publication'
        ? { candidate_commit_oid: OID, receipt_sha256: 'push-receipt' }
        : undefined,
    repositoryPublicationRoute: () => ({
      base_repository_name: 'acme/repo',
      base_repository_node_id: 'R_base',
      head_repository_name: 'forker/repo',
      head_repository_node_id: 'R_head',
      route_fingerprint: 'route'
    }),
    run: () => ({ branch: 'feature', repo_root: '/repo' }),
    settleRemoteStage: (input: Record<string, unknown>) => {
      settlements.push(input)
      return { receiptSha256: 'pr-receipt' }
    }
  }
  return { ledger, recordedObservations, settlements }
}

test('bindPullRequest rejects body or title drift after readiness notification and derives hashes from observed PR', async () => {
  const { ledger, recordedObservations, settlements } = harness()
  let pr = pullRequest()
  const authority = {
    createPullRequest: async () => assert.fail('unexpected create'),
    observePullRequests: async () => ({ exact: pr, nearMatches: [] }),
    updatePullRequest: async () => assert.fail('unexpected update')
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-reverify-'))
  try {
    pr = pullRequest()
    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(directory, 'drift-body.json'),
        attemptId: 'attempt',
        authority,
        candidateCommitOid: OID,
        content,
        generationToken: 1,
        ledger: ledger as never,
        onReady: async () => {
          pr = pullRequest({ body: 'altered body' })
        },
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId: 'run',
        workerIdentity: 'coordinator'
      }),
      /pull-request facts changed after readiness notification/
    )

    pr = pullRequest()
    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(directory, 'drift-title.json'),
        attemptId: 'attempt',
        authority,
        candidateCommitOid: OID,
        content,
        generationToken: 1,
        ledger: ledger as never,
        onReady: async () => {
          pr = pullRequest({ title: 'altered title' })
        },
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId: 'run',
        workerIdentity: 'coordinator'
      }),
      /pull-request facts changed after readiness notification/
    )

    pr = pullRequest()
    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(directory, 'drift-draft.json'),
        attemptId: 'attempt',
        authority,
        candidateCommitOid: OID,
        content,
        generationToken: 1,
        ledger: ledger as never,
        onReady: async () => {
          pr = pullRequest({ draft: true })
        },
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId: 'run',
        workerIdentity: 'coordinator'
      }),
      /pull-request facts changed after readiness notification/
    )

    pr = pullRequest()
    await bindPullRequest({
      artifactPath: path.join(directory, 'settled.json'),
      attemptId: 'attempt',
      authority,
      candidateCommitOid: OID,
      content,
      generationToken: 1,
      ledger: ledger as never,
      pipelineEvidenceRoot: 'c'.repeat(64),
      runId: 'run',
      workerIdentity: 'coordinator'
    })

    assert.equal(recordedObservations.length, 1)
    const observationPayload = (recordedObservations[0].payload ?? {}) as Record<string, unknown>
    assert.equal(observationPayload.state, 'open')
    assert.equal(observationPayload.bodySha256, sha256(content.body))
    assert.equal(observationPayload.titleSha256, sha256(content.title))

    assert.equal(settlements.length, 1)
    const receipt = settlements[0].receipt as { payload?: Record<string, unknown> }
    assert.equal(receipt.payload?.bodySha256, sha256(content.body))
    assert.equal(receipt.payload?.titleSha256, sha256(content.title))
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('bindPullRequest does not notify onReady when observed PR is already merged', async () => {
  const { ledger, settlements } = harness()
  const pr = pullRequest({ state: 'MERGED' })
  let readyCalled = false
  const authority = {
    createPullRequest: async () => assert.fail('unexpected create'),
    observePullRequests: async () => ({ exact: pr, nearMatches: [] }),
    updatePullRequest: async () => assert.fail('unexpected update')
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-already-merged-'))
  try {
    const result = await bindPullRequest({
      artifactPath: path.join(directory, 'merged.json'),
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
    })
    assert.equal(readyCalled, false)
    assert.equal(result.outcome, 'unchanged')
    assert.equal(settlements.length, 1)
    assert.equal((settlements[0].receipt as { payload: { state: string } }).payload.state, 'merged')
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('htmlEscape redacts known secrets before HTML escaping in pullRequestContent', () => {
  const secretKey = 'TEST_SECRET_KEY_FOR_REDACTION'
  process.env[secretKey] = 'secret<unsafe>&val>123'
  try {
    const result = pullRequestContent('feat: test secret redaction', {
      candidateCommitOid: OID,
      pipelineSteps: [
        {
          details: 'Step with secret<unsafe>&val>123 in details',
          name: 'step-secret<unsafe>&val>123',
          status: 'status-secret<unsafe>&val>123'
        }
      ],
      risk: { level: 'low', rationale: 'Testing redaction.' },
      testing: {
        artifacts: [
          {
            content: 'Artifact contains secret<unsafe>&val>123 here.',
            name: 'artifact-secret<unsafe>&val>123.txt'
          }
        ],
        summary: 'Exercised secret redaction.',
        tested: []
      },
      whatChanged: 'Redaction before HTML escaping.'
    })

    assert.doesNotMatch(result.body, /secret&lt;unsafe&gt;&amp;val&gt;123/)
    assert.doesNotMatch(result.body, /secret<unsafe>&val>123/)
    assert.match(result.body, /\[REDACTED\]/)
  } finally {
    delete process.env[secretKey]
  }
})

test('testingSection budgets artifact framing so unbounded empty artifacts fit', () => {
  const artifacts = Array.from({ length: 1_000 }, (_, index) => ({
    content: '',
    name: `empty-artifact-${index}.log`
  }))
  const result = pullRequestContent('feat: test empty artifact framing', {
    candidateCommitOid: OID,
    pipelineSteps: [],
    risk: { level: 'low', rationale: 'Low risk.' },
    testing: {
      artifacts,
      summary: 'Testing empty artifact framing.',
      tested: []
    },
    whatChanged: 'Framing is accounted for in budget.'
  })

  assert.ok(Buffer.byteLength(result.body) <= 63_488)
  assert.match(result.body, /## Testing/)
})

test('pullRequestContent preserves complete whatChanged summary whenever total body fits', () => {
  const fullSummary = '- Step item summary.\n'.repeat(500)
  assert.ok(Buffer.byteLength(fullSummary) > 8_192)

  const result = pullRequestContent('feat: keep complete summary', {
    candidateCommitOid: OID,
    pipelineSteps: [{ name: 'check', status: 'pass' }],
    risk: { level: 'low', rationale: 'All good.' },
    testing: {
      artifacts: [],
      summary: 'Short summary.',
      tested: []
    },
    whatChanged: fullSummary
  })

  assert.ok(Buffer.byteLength(result.body) <= 63_488)
  assert.doesNotMatch(result.body, /_\[truncated to fit GitHub PR body limits\]_/)
  assert.match(result.body, /## What Changed\n\n- Step item summary\./)
})

test('pullRequestContent truncates whatChanged when total PR body budget is exhausted', () => {
  const giantSummary = 'x'.repeat(70_000)
  const result = pullRequestContent('feat: truncate giant summary', {
    candidateCommitOid: OID,
    pipelineSteps: [],
    risk: { level: 'low', rationale: 'All good.' },
    testing: {
      artifacts: [],
      summary: 'Short.',
      tested: []
    },
    whatChanged: giantSummary
  })

  assert.ok(Buffer.byteLength(result.body) <= 63_488)
  assert.match(result.body, /_\[truncated to fit GitHub PR body limits\]_/)
})
