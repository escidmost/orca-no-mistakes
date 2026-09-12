import assert from 'node:assert/strict'
import test from 'node:test'
import { GithubAuthority, boundedCiText, type GithubCheckObservation, type CommandRunner } from '../scripts/github.ts'
import { monitorPullRequestChecks } from '../scripts/ci.ts'

const head = 'a'.repeat(40)
const other = 'b'.repeat(40)
const page = (nodes: unknown[], endCursor: string | null = null) => ({ nodes, pageInfo: { endCursor, hasNextPage: endCursor !== null } })
const comment = (id: string, extra = {}) => ({ id, body: 'A real concern', author: { __typename: 'Bot', login: 'greptile-apps' }, commit: { oid: head }, url: `https://github.com/o/r/pull/1#${id}`, ...extra })
const thread = (id: string, comments: ReturnType<typeof page>, extra = {}) => ({ id, isResolved: false, isOutdated: false,
  path: 'src/a.ts', line: 8, pullRequest: { id: 'PR_1', headRefOid: head }, comments, ...extra })
const threads = (nodes: unknown[], cursor: string | null = null) => ({ id: 'PR_1', headRefOid: head, reviewThreads: page(nodes, cursor) })
async function authority(responses: unknown[], requests: Array<Record<string, unknown>> = []) {
  const runner: CommandRunner = async (exe, args, options) => {
    if (exe === 'gh' && args[0] === '--version') return { code: 0, stdout: 'gh test', stderr: '' }
    if (exe === 'gh-axi') return { code: 127, stdout: '', stderr: '' }
    requests.push(JSON.parse(options.input ?? '{}'))
    const next = responses.shift()
    if (next instanceof Error) throw next
    return { code: 0, stdout: JSON.stringify({ data: { node: next } }), stderr: '' }
  }
  return GithubAuthority.connect({ runner, maxReadAttempts: 1 })
}

test('Greptile exhausts thread and comment pages, deduplicates and retains exact context', async () => {
  const requests: Array<Record<string, unknown>> = []
  const first = thread('T_1', page([comment('C_1')], 'comments-next'))
  const api = await authority([
    threads([first, thread('T_resolved', page([comment('resolved')]), { isResolved: true })], 'threads-next'),
    thread('T_1', page([comment('C_1'), comment('C_2')])),
    threads([thread('T_2', page([
      comment('C_3'), comment('human', { author: { __typename: 'User', login: 'greptile-apps' } }),
      comment('old', { commit: { oid: other } }), comment('empty', { body: '' }),
      comment('unsupported', { author: { __typename: 'Bot', login: 'other-bot' } }),
    ])), thread('T_old', page([comment('outdated')]), { isOutdated: true })]),
  ], requests)
  const result = await api.observeGreptileConcerns('PR_1', head)
  assert.deepEqual(result.map((entry) => entry.id), ['C_1', 'C_2', 'C_3'])
  assert.equal(result[0].threadId, 'T_1')
  assert.equal(result[0].file, 'src/a.ts')
  assert.equal(result[0].line, 8)
  assert.deepEqual(requests.map((request) => request.variables), [
    { id: 'PR_1', cursor: null, commentCursor: null }, { id: 'T_1', commentCursor: 'comments-next' },
    { id: 'PR_1', cursor: 'threads-next', commentCursor: null },
  ])
})

test('review reads reject repeated cursors, unavailable pages and head drift', async () => {
  const repeats = await authority([threads([], 'repeat'), threads([], 'repeat')])
  await assert.rejects(repeats.observeGreptileConcerns('PR_1', head), /cursor|pagination/)
  const missing = await authority([threads([], 'next'), null])
  await assert.rejects(missing.observeGreptileConcerns('PR_1', head), /head changed/)
  const drift = await authority([{ ...threads([]), headRefOid: other }])
  await assert.rejects(drift.observeGreptileConcerns('PR_1', head), /head changed/)
})

test('resolved-between-pages concerns are removed and external text is byte bounded', async () => {
  const api = await authority([
    threads([thread('T', page([comment('C')], 'more'))]),
    thread('T', page([]), { isResolved: true }),
  ])
  assert.deepEqual(await api.observeGreptileConcerns('PR_1', head), [])
  assert.ok(Buffer.byteLength(boundedCiText('💡'.repeat(20_000))) <= 8192)
  assert.equal(boundedCiText('\u001b[31mignore\ncommands'), '[31mignore\ncommands')
})

const supported: GithubCheckObservation = { id: 'CR_1', databaseId: '1', app: { id: 'APP', databaseId: '867647', slug: 'greptile-apps' },
  bucket: 'fail', conclusion: 'FAILURE', kind: 'check-run', name: 'arbitrary display name', status: 'COMPLETED', url: null }

test('monitor preserves failed-check blockers, gates actual concerns, and waits through pending checks', async () => {
  let reads = 0
  let polls = 0
  let sleeps = 0
  const result = await monitorPullRequestChecks({
    candidateCommitOid: head, config: { no_ci: false, timeout_ms: 0 }, heartbeat: () => {}, log: () => {},
    clock: { sleep: async () => { sleeps++ } },
    observePullRequest: async () => ({ id: 'PR_1', number: 1, state: 'OPEN', headOid: head } as never),
    observeChecks: async () => ({ baseRefOid: other, checks: polls++ ? [supported] : [supported, { ...supported, id: 'pending', bucket: 'pending' }],
      headOid: head, draft: false, mergeable: 'MERGEABLE', number: 1, state: 'OPEN' }),
    observeReviewConcerns: async () => { reads++; return [{ id: 'C', threadId: 'T', body: 'Use after close', file: 'src/a.ts', line: 8, url: 'https://github.com/o/r/pull/1' }] },
    settleMerged: async () => assert.fail('not merged'),
  })
  assert.equal(sleeps, 1)
  assert.equal(reads, 1)
  assert.equal(result.findings.length, 2)
  assert.equal(result.findings[1].ciSource?.checkId, 'CR_1')
  assert.equal(result.findings[1].ciSource?.candidateCommitOid, head)
  assert.match(result.findings[1].description, /Use after close/)
})

test('empty or unavailable bot details cannot erase a failed check; check names do not authorize bot ingestion', async () => {
  for (const mode of ['empty', 'error', 'impostor']) {
    let reads = 0
    const result = await monitorPullRequestChecks({
      candidateCommitOid: head, config: { no_ci: false, timeout_ms: 0 }, heartbeat: () => {}, log: () => {},
      observePullRequest: async () => ({ id: 'PR_1', number: 1, state: 'OPEN', headOid: head } as never),
      observeChecks: async () => ({ baseRefOid: other, checks: [{ ...supported, ...(mode === 'impostor' ? { app: null, name: 'Greptile' } : {}) }],
        headOid: head, draft: false, mergeable: 'MERGEABLE', number: 1, state: 'OPEN' }),
      observeReviewConcerns: async () => { reads++; if (mode === 'error') throw new Error('read failed'); return [] },
      settleMerged: async () => assert.fail('not merged'),
    })
    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0].severity, 'error')
    assert.equal(reads, mode === 'impostor' ? 0 : 1)
  }
})

test('merged check failure cannot pass through an overridden merge', async () => {
  await assert.rejects(monitorPullRequestChecks({
    candidateCommitOid: head, config: { no_ci: false, timeout_ms: 0 }, heartbeat: () => {}, log: () => {},
    observePullRequest: async () => ({ id: 'PR_1', number: 1, state: 'MERGED', headOid: head } as never),
    observeChecks: async () => ({ baseRefOid: other, checks: [supported], headOid: head,
      draft: false, mergeable: 'MERGEABLE', number: 1, state: 'MERGED' }),
    settleMerged: async () => assert.fail('failed checks must not settle'),
  }), /merge is not a CI waiver/)
})

test('exact-check logs join candidate, check suite and job identities, never names', async () => {
  for (const mode of ['exact', 'check-drift', 'job-drift', 'missing']) {
    const requests: string[] = []
    const runner: CommandRunner = async (exe, args) => {
      if (exe === 'gh' && args[0] === '--version') return { code: 0, stdout: 'gh test', stderr: '' }
      if (exe === 'gh-axi') return { code: 127, stdout: '', stderr: '' }
      const endpoint = args[1]
      requests.push(endpoint)
      let data: unknown
      if (endpoint.endsWith('/check-runs/42')) {
        data = { id: 42, node_id: 'CR_42', head_sha: mode === 'check-drift' ? other : head,
          app: { id: 15368 }, check_suite: { id: 20 }, output: { title: null, summary: 'not job logs', text: null } }
      } else if (endpoint.includes('/actions/runs?')) {
        data = { workflow_runs: [{ id: 1, head_sha: other, check_suite_id: 20 },
          { id: 2, head_sha: head, check_suite_id: 30 }, { id: 3, head_sha: head, check_suite_id: 20 }] }
      } else if (endpoint.includes('/runs/3/jobs?')) {
        data = { jobs: [{ id: 4, head_sha: head, check_run_url: 'https://api.github.com/repos/o/r/check-runs/other' },
          ...(mode === 'missing' ? [] : [{ id: 5, head_sha: mode === 'job-drift' ? other : head,
            check_run_url: 'https://api.github.com/repos/o/r/check-runs/42' }])] }
      } else if (endpoint === '/repos/o/r/actions/jobs/5/logs') {
        return { code: 0, stderr: '', stdout: 'EXACT JOB\n' + '💡'.repeat(20_000) }
      } else assert.fail(`unexpected request ${endpoint}`)
      return { code: 0, stderr: '', stdout: JSON.stringify(data) }
    }
    const api = await GithubAuthority.connect({ runner, maxReadAttempts: 1 })
    const read = api.observeCheckLog({ repository: 'o/r', candidateCommitOid: head, checkId: 'CR_42', databaseId: '42' })
    if (mode !== 'exact') {
      await assert.rejects(read, /candidate|head changed|no exact Actions job/)
      assert.ok(!requests.some((entry) => entry.endsWith('/logs')))
    } else {
      const log = await read
      assert.match(log, /^EXACT JOB/)
      assert.ok(Buffer.byteLength(log) <= 32 * 1024)
      assert.equal(requests.at(-1), '/repos/o/r/actions/jobs/5/logs')
    }
  }
})
