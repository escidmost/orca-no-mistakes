import assert from 'node:assert/strict'
import test from 'node:test'
import { GithubAuthority, type CommandRunner, type GithubCheckObservation } from '../scripts/github.ts'
import { monitorPullRequestChecks } from '../scripts/ci.ts'

const head = 'a'.repeat(40)
const other = 'b'.repeat(40)
const page = (nodes: unknown[], endCursor: string | null = null) => ({ nodes, pageInfo: { endCursor, hasNextPage: endCursor !== null } })
const comment = (id: string, body = 'A real concern') => ({ id, body, author: { __typename: 'Bot', login: 'greptile-apps' },
  commit: { oid: head }, url: `https://github.com/o/r/pull/1#${id}` })
const thread = (id: string, comments: ReturnType<typeof page>, extra = {}) => ({ id, isResolved: false, isOutdated: false,
  path: 'src/a.ts', line: 8, pullRequest: { id: 'PR_1', headRefOid: head }, comments, ...extra })
const threads = (nodes: unknown[], cursor: string | null = null) => ({ id: 'PR_1', headRefOid: head, reviewThreads: page(nodes, cursor) })

const supported: GithubCheckObservation = { id: 'CR_1', databaseId: '1', app: { id: 'APP', databaseId: '867647', slug: 'greptile-apps' },
  bucket: 'pass', conclusion: 'SUCCESS', kind: 'check-run', name: 'review', status: 'COMPLETED', url: null }

const mergedMonitor = (observeReviewConcerns: (id: string, oid: string) => Promise<never[] | Array<Record<string, unknown>>>) =>
  monitorPullRequestChecks({
    candidateCommitOid: head, config: { no_ci: false, timeout_ms: 0 }, heartbeat: () => {}, log: () => {},
    observePullRequest: async () => ({ id: 'PR_1', number: 1, state: 'MERGED', headOid: head } as never),
    observeChecks: async () => ({ baseRefOid: other, checks: [supported], headOid: head,
      draft: false, mergeable: 'MERGEABLE', number: 1, state: 'MERGED' }),
    observeReviewConcerns: observeReviewConcerns as never,
    settleMerged: async () => assert.fail('unresolved review concerns must not settle'),
  })

test('a merge does not waive unresolved or unreadable review concerns', async () => {
  const gated = await mergedMonitor(async () => [{ id: 'C', threadId: 'T', body: 'Use after close',
    file: 'src/a.ts', line: 8, url: 'https://github.com/o/r/pull/1' }])
  assert.equal(gated.findings.length, 1)
  assert.equal(gated.findings[0].severity, 'error')
  assert.match(gated.findings[0].description, /Use after close/)

  const unavailable = await mergedMonitor(async () => { throw new Error('read failed') })
  assert.deepEqual(unavailable.findings.map((finding) => finding.id), ['ci-review-unavailable'])
})

test('a merged pull request with no concerns still settles', async () => {
  let settled = 0
  const result = await monitorPullRequestChecks({
    candidateCommitOid: head, config: { no_ci: false, timeout_ms: 0 }, heartbeat: () => {}, log: () => {},
    observePullRequest: async () => ({ id: 'PR_1', number: 1, state: 'MERGED', headOid: head } as never),
    observeChecks: async () => ({ baseRefOid: other, checks: [supported], headOid: head,
      draft: false, mergeable: 'MERGEABLE', number: 1, state: 'MERGED' }),
    observeReviewConcerns: async () => [],
    settleMerged: async () => { settled++; return { number: 1 } },
  })
  assert.equal(settled, 1)
  assert.deepEqual(result.findings, [])
})

test('a thread that resolves between pages refunds its retained bytes', async () => {
  const runner: CommandRunner = (() => {
    const responses: unknown[] = [
      threads([thread('T_big', page([comment('C_big', 'x'.repeat(30 * 1024))], 'more'))], 'threads-next'),
      thread('T_big', page([]), { isResolved: true }),
      threads([thread('T_real', page([comment('C_real')]))]),
    ]
    return async (exe, args) => {
      if (exe === 'gh' && args[0] === '--version') return { code: 0, stdout: 'gh test', stderr: '' }
      if (exe === 'gh-axi') return { code: 127, stdout: '', stderr: '' }
      return { code: 0, stdout: JSON.stringify({ data: { node: responses.shift() } }), stderr: '' }
    }
  })()
  const api = await GithubAuthority.connect({ runner, maxReadAttempts: 1 })
  assert.deepEqual((await api.observeGreptileConcerns('PR_1', head)).map((entry) => entry.id), ['C_real'])
})
