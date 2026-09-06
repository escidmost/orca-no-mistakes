import assert from 'node:assert/strict'
import { test } from 'node:test'
import { monitorPullRequestChecks } from '../scripts/ci.ts'
import type { GithubCheckObservation, GithubPullRequestChecksObservation, GithubPullRequestObservation } from '../scripts/github.ts'

const HEAD = 'a'.repeat(40)

function pullRequest(state: 'OPEN' | 'CLOSED' | 'MERGED'): GithubPullRequestObservation {
  return { id: 'PR_1', number: 7, state, headOid: HEAD, url: 'https://github.com/o/r/pull/7' } as GithubPullRequestObservation
}

const failing: GithubCheckObservation = { bucket: 'fail', conclusion: 'FAILURE', kind: 'check-run', name: 'lint', status: 'COMPLETED', url: null }

function checks(extra: Partial<GithubPullRequestChecksObservation>): GithubPullRequestChecksObservation {
  return { baseRefOid: 'b'.repeat(40), checks: [failing], draft: false, headOid: HEAD, mergeable: 'MERGEABLE', number: 7, state: 'OPEN', ...extra }
}

function harness(ticks: Array<{ pr: GithubPullRequestObservation; checks?: GithubPullRequestChecksObservation }>) {
  const log: string[] = []
  const sleeps: number[] = []
  let settled = 0
  let index = -1
  const run = () => monitorPullRequestChecks({
    candidateCommitOid: HEAD,
    clock: { now: () => 0, sleep: async (ms) => { sleeps.push(ms) } },
    config: { no_ci: false, timeout_ms: 0 },
    heartbeat: () => {},
    log: (line) => log.push(line),
    observeChecks: async () => ticks[Math.min(index, ticks.length - 1)]!.checks ?? checks({ checks: [] }),
    observePullRequest: async () => ticks[Math.min(++index, ticks.length - 1)]!.pr,
    settleMerged: async () => { settled += 1; return { number: 7 } }
  })
  return { log, run, sleeps, settled: () => settled }
}

test('a merged state on the checks observation settles the merge instead of reporting failures', async () => {
  const h = harness([
    { pr: pullRequest('OPEN'), checks: checks({ state: 'MERGED' }) },
    { pr: pullRequest('MERGED') }
  ])
  const report = await h.run()
  assert.deepEqual(report.findings, [])
  assert.equal(h.settled(), 1)
  assert.deepEqual(h.sleeps, [])
  assert.ok(h.log.some((line) => line.includes('has been merged')), h.log.join('\n'))
})

test('a closed or draft state on the checks observation is re-read before any verdict', async () => {
  await assert.rejects(
    harness([{ pr: pullRequest('OPEN'), checks: checks({ state: 'CLOSED' }) }, { pr: pullRequest('CLOSED') }]).run(),
    /closed without merging/
  )
  const h = harness([
    { pr: pullRequest('OPEN'), checks: checks({ draft: true }) },
    { pr: pullRequest('OPEN'), checks: checks({}) }
  ])
  const report = await h.run()
  assert.deepEqual(report.findings.map((f) => f.id), ['ci-lint'])
  assert.deepEqual(h.sleeps, [30_000], 'an inconsistent checks read is retried at the CI polling interval')
})
