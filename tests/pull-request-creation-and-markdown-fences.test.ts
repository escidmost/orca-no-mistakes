import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { repositoryIdentityFingerprint } from '../scripts/ledger.ts'

import type { GithubPullRequestObservation } from '../scripts/github.ts'
import {
  bindPullRequest,
  capEscapedMarkdown,
  findUnclosedFence,
  pullRequestContent,
  type PullRequestReport
} from '../scripts/pull-request.ts'
import { assertStructurallyVisible } from './markdown-visibility.ts'

const OID = 'a'.repeat(40)
const content = { body: 'complete body', title: 'feat: complete report' }

test('bindPullRequest captures createPullRequest with draft: false and settles open after readiness', async () => {
  const settlements: Array<Record<string, unknown>> = []
  let ownsLease = true
  const ledger = {
    heartbeatLease: () => {},
    ownsLease: () => ownsLease,
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
    recordRemoteObservation: () => 'post-read',
    remoteReceipt: (_runId: string, kind: string) => kind === 'candidate-publication'
      ? { candidate_commit_oid: OID, receipt_sha256: 'push-receipt' }
      : undefined,
    repositoryPublicationRoute: () => ({
      base_repository_name: 'acme/repo',
      base_repository_node_id: 'R_base',
      head_repository_name: 'forker/repo',
      head_repository_node_id: 'R_head',
      route_fingerprint: repositoryIdentityFingerprint({ base_repository_id: '1', forge_host: 'github.com', head_owner: 'forker', head_repository_id: '2' })
    }),
    run: () => ({ branch: 'feature', repo_root: '/repo' }),
    settleRemoteStage: (input: Record<string, unknown>) => {
      settlements.push(input)
      return { receiptSha256: 'pr-receipt' }
    }
  }

  type CreateRequest = {
    baseBranch: string
    baseRepositoryNodeId: string
    body: string
    draft: boolean
    headRefName: string
    title: string
  }
  let pr: GithubPullRequestObservation | null = null
  let capturedCreateRequest: CreateRequest | null = null
  const getCaptured = (): CreateRequest => {
    if (!capturedCreateRequest) throw new Error('createPullRequest must be called')
    return capturedCreateRequest
  }
  const ready: Array<{ number: number; outcome: string; title: string; url: string }> = []
  const authority = {
    createPullRequest: async (input: CreateRequest) => {
      capturedCreateRequest = input
      pr = {
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
        id: 'PR_created_node',
        number: 42,
        state: 'OPEN',
        title: content.title,
        url: 'https://github.com/acme/repo/pull/42'
      }
    },
    observePullRequests: async () => ({ exact: pr, nearMatches: [] }),
    updatePullRequest: async () => assert.fail('unexpected PR update')
  }

  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-create-'))
  try {
    const result = await bindPullRequest({
      artifactPath: path.join(directory, 'pr.json'),
      attemptId: 'attempt-create',
      authority,
      candidateCommitOid: OID,
      content,
      generationToken: 1,
      ledger: ledger as never,
      onReady: async (info) => {
        assert.equal(settlements.length, 0)
        ready.push(info)
      },
      pipelineEvidenceRoot: 'c'.repeat(64),
      runId: 'run',
      workerIdentity: 'coordinator'
    })

    const req = getCaptured()
    assert.equal(req.draft, false)
    assert.equal(req.baseBranch, 'main')
    assert.equal(req.baseRepositoryNodeId, 'R_base')
    assert.equal(req.headRefName, 'forker:feature')
    assert.equal(req.body, content.body)
    assert.equal(req.title, content.title)
    assert.equal(result.outcome, 'created')
    assert.equal(result.number, 42)
    assert.equal(result.url, 'https://github.com/acme/repo/pull/42')
    assert.deepEqual(ready, [{
      number: 42,
      outcome: 'created',
      title: content.title,
      url: 'https://github.com/acme/repo/pull/42'
    }])
    assert.equal(settlements.length, 1)
    assert.equal((settlements[0].receipt as { payload: { state: string } }).payload.state, 'open')
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('findUnclosedFence accurately tracks backtick and tilde fences across lengths and indentation', () => {
  assert.equal(findUnclosedFence(''), null)
  assert.equal(findUnclosedFence('hello world'), null)
  assert.equal(findUnclosedFence('const x = `inline`;'), null)
  assert.equal(findUnclosedFence('    ```\ncode\n    ```'), null)

  assert.deepEqual(findUnclosedFence('```\ncode'), { char: '`', length: 3 })
  assert.deepEqual(findUnclosedFence('```ts\ncode'), { char: '`', length: 3 })
  assert.deepEqual(findUnclosedFence('   ```\ncode'), { char: '`', length: 3 })
  assert.deepEqual(findUnclosedFence('~~~python\nprint(1)'), { char: '~', length: 3 })
  assert.deepEqual(findUnclosedFence('````markdown\n```\nfoo\n```'), { char: '`', length: 4 })
  assert.deepEqual(findUnclosedFence('~~~~~\ncode'), { char: '~', length: 5 })

  assert.equal(findUnclosedFence('```\ncode\n```'), null)
  assert.equal(findUnclosedFence('~~~python\nprint(1)\n~~~'), null)
  assert.equal(findUnclosedFence('````markdown\n```\nfoo\n```\n````'), null)
})

test('capEscapedMarkdown contains unclosed fences while honoring byte budgets', () => {
  const shortUnclosed = '```ts\nconst x = 1;'
  const balancedShort = capEscapedMarkdown(shortUnclosed, 100)
  assert.equal(findUnclosedFence(balancedShort), null)
  assert.ok(balancedShort.endsWith('```'))
  assert.ok(!balancedShort.includes('truncated'))

  const longUnclosed = `\`\`\`ts\n${'const line = 1;\n'.repeat(200)}`
  const budget = 300
  const balancedLong = capEscapedMarkdown(longUnclosed, budget)
  assert.equal(findUnclosedFence(balancedLong), null)
  assert.ok(Buffer.byteLength(balancedLong) <= budget)
  assert.ok(balancedLong.includes('truncated'))
  assert.ok(balancedLong.endsWith('```'))

  const longTilde = `~~~~python\n${'print(1)\n'.repeat(200)}`
  const balancedTilde = capEscapedMarkdown(longTilde, budget)
  assert.equal(findUnclosedFence(balancedTilde), null)
  assert.ok(Buffer.byteLength(balancedTilde) <= budget)
  assert.ok(balancedTilde.endsWith('~~~~'))
})

test('pullRequestContent balances already-unclosed fences across Intent, What Changed, and pipeline details', () => {
  const report: PullRequestReport = {
    candidateCommitOid: OID,
    pipelineSteps: [
      {
        name: 'test',
        status: 'passed',
        details: '```bash\n npm test\n running tests...'
      },
      {
        name: 'review',
        status: 'passed',
        details: '~~~~markdown\n review details without closing fence'
      }
    ],
    risk: {
      level: 'low',
      rationale: 'Safe bounded changes.'
    },
    testing: {
      artifacts: [
        {
          content: 'log with backticks ``` that should remain verbatim inside pre',
          name: 'test-log'
        }
      ],
      summary: 'All checks passed.',
      tested: ['npm test']
    },
    whatChanged: '```ts\nexport function transform(): void {\n  return'
  }

  const intent = '```text\nIntent opened without closer'
  const { body } = pullRequestContent(intent, report)

  assertStructurallyVisible(body, '## Intent')
  assertStructurallyVisible(body, '## What Changed')
  assertStructurallyVisible(body, '## Risk Assessment')
  assertStructurallyVisible(body, '## Testing')
  assertStructurallyVisible(body, '## Pipeline')
  assertStructurallyVisible(body, '<!-- orca-no-mistakes-pipeline-attestation:v1')

  assert.ok(body.includes('<pre>log with backticks ``` that should remain verbatim inside pre</pre>'))
  assert.ok(!body.includes('pre</pre>\n```'))
})

test('pullRequestContent balances truncation-opened fences across sections and stays within body budget', () => {
  const massiveCode = `\`\`\`\`typescript\n${'const statement = 1234567890;\n'.repeat(3000)}`
  const report: PullRequestReport = {
    candidateCommitOid: OID,
    pipelineSteps: [
      {
        name: 'ci',
        status: 'passed',
        details: `~~~sh\n${'echo step\n'.repeat(2000)}`
      }
    ],
    risk: {
      level: 'medium',
      rationale: 'Large structural update.'
    },
    testing: {
      artifacts: [],
      summary: 'Verified truncation safety.',
      tested: ['npm run build']
    },
    whatChanged: massiveCode
  }

  const { body } = pullRequestContent('Massive truncation test.', report)

  assert.ok(Buffer.byteLength(body) <= 63_488)
  assertStructurallyVisible(body, '## Intent')
  assertStructurallyVisible(body, '## What Changed')
  assertStructurallyVisible(body, '## Risk Assessment')
  assertStructurallyVisible(body, '## Testing')
  assertStructurallyVisible(body, '## Pipeline')
  assertStructurallyVisible(body, '<!-- orca-no-mistakes-pipeline-attestation:v1')
})

test('preserves valid Markdown constructs and framework HTML', () => {
  const validMarkdown = `
| Header 1 | Header 2 |
| --- | --- |
| Val 1 | Val 2 |

- List item 1
- List item 2

**bold text** and *italic text* and [link](https://example.com)

\`\`\`json
{ "status": "ok" }
\`\`\`

> Blockquote line
`
  const report: PullRequestReport = {
    candidateCommitOid: OID,
    pipelineSteps: [
      {
        name: 'lint',
        status: 'passed',
        details: 'Everything valid.'
      }
    ],
    risk: {
      level: 'low',
      rationale: 'Standard updates.'
    },
    testing: {
      artifacts: [],
      summary: 'Tested cleanly.',
      tested: ['npm test']
    },
    whatChanged: validMarkdown
  }

  const { body } = pullRequestContent('Preserve valid Markdown.', report)

  assert.ok(body.includes('| Header 1 | Header 2 |'))
  assert.ok(body.includes('**bold text**'))
  assert.ok(body.includes('&gt; Blockquote line'))
  assert.ok(body.includes('```json\n{ "status": "ok" }\n```'))
  assertStructurallyVisible(body, '## Risk Assessment')
  assertStructurallyVisible(body, '## Testing')
  assertStructurallyVisible(body, '## Pipeline')
})
