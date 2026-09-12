import assert from 'node:assert/strict'
import test from 'node:test'

import { GithubAuthority, type CommandResult, type CommandRunner } from '../scripts/github.ts'

function page(nodes: unknown[], endCursor: string | null) {
  return { nodes, pageInfo: { endCursor, hasNextPage: endCursor !== null } }
}

function node(extra: Record<string, unknown>, contexts: ReturnType<typeof page>) {
  return {
    baseRef: { target: { oid: 'a'.repeat(40) } },
    commits: { nodes: [{ commit: { oid: 'b'.repeat(40), statusCheckRollup: { contexts } } }] },
    headRefOid: 'b'.repeat(40),
    isDraft: false,
    mergeable: 'MERGEABLE',
    number: 2,
    state: 'OPEN',
    ...extra
  }
}

const failing = { __typename: 'CheckRun', id: 'CR_1', databaseId: 1, checkSuite: { app: null }, conclusion: 'FAILURE', detailsUrl: null, name: 'lint', status: 'COMPLETED' }
const passing = { __typename: 'StatusContext', id: 'SC_2', context: 'ci/legacy', state: 'SUCCESS', targetUrl: null }

function runner(pages: unknown[]): CommandRunner {
  return async (executable, args): Promise<CommandResult> => {
    if (executable === 'gh' && args[0] === '--version') return { code: 0, stderr: '', stdout: 'gh version 2.97.0\n' }
    if (executable === 'gh-axi') return { code: 127, stderr: '', stdout: '' }
    return { code: 0, stderr: '', stdout: JSON.stringify({ data: { node: pages.shift() } }) }
  }
}

test('a later check page reporting a merged or draft pull request is not discarded', async () => {
  const merged = await GithubAuthority.connect({
    runner: runner([node({}, page([failing], 'page-2')), node({ state: 'MERGED' }, page([passing], null))])
  })
  const observation = await merged.observePullRequestChecks('PR_2')
  assert.equal(observation.state, 'MERGED')
  assert.deepEqual(observation.checks.map((check) => check.bucket), ['fail', 'pass'])

  const draft = await GithubAuthority.connect({
    runner: runner([node({}, page([failing], 'page-2')), node({ isDraft: true, mergeable: 'CONFLICTING' }, page([passing], null))])
  })
  const drafted = await draft.observePullRequestChecks('PR_2')
  assert.equal(drafted.draft, true)
  assert.equal(drafted.mergeable, 'CONFLICTING')
})
