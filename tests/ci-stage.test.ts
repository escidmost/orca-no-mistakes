import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHECKS_PASSED_MSG,
  CHECKS_RUNNING_MSG,
  CI_TIMEOUT_SUMMARY,
  CiMonitorError,
  NO_CHECKS_PASSED_MSG,
  NO_CHECKS_YET_MSG,
  ciPollIntervalMs,
  monitorPullRequestChecks
} from '../scripts/ci.ts'
import type { GithubCheckObservation, GithubPullRequestChecksObservation, GithubPullRequestObservation } from '../scripts/github.ts'

const HEAD = 'a'.repeat(40)

function pullRequest(state: 'OPEN' | 'CLOSED' | 'MERGED', headOid = HEAD): GithubPullRequestObservation {
  return { id: 'PR_1', number: 7, state, headOid, url: 'https://github.com/o/r/pull/7' } as GithubPullRequestObservation
}

function check(name: string, bucket: GithubCheckObservation['bucket']): GithubCheckObservation {
  return { bucket, conclusion: bucket === 'pass' ? 'SUCCESS' : bucket === 'fail' ? 'FAILURE' : null, kind: 'check-run', name, status: 'COMPLETED', url: null }
}

function checks(list: GithubCheckObservation[], extra: Partial<GithubPullRequestChecksObservation> = {}): GithubPullRequestChecksObservation {
  return { baseRefOid: 'b'.repeat(40), checks: list, draft: false, headOid: HEAD, mergeable: 'MERGEABLE', number: 7, state: 'OPEN', ...extra }
}

/** Scripted monitor: each tick pulls the next PR state and check set; the clock never really sleeps. */
function harness(ticks: Array<{ pr: GithubPullRequestObservation; checks?: GithubPullRequestChecksObservation }>, config = { no_ci: false, timeout_ms: 0 }) {
  let clock = 0
  const log: string[] = []
  const sleeps: number[] = []
  let settled = 0
  let index = -1
  const run = () => monitorPullRequestChecks({
    candidateCommitOid: HEAD,
    clock: { now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms } },
    config,
    heartbeat: () => {},
    log: (line) => log.push(line),
    observeChecks: async () => ticks[Math.min(index, ticks.length - 1)]!.checks ?? checks([]),
    observePullRequest: async () => ticks[Math.min(++index, ticks.length - 1)]!.pr,
    settleMerged: async () => { settled += 1; return { number: 7 } }
  })
  return { log, run, sleeps, settled: () => settled }
}

test('ci monitor reports failing checks as ask-user findings and resumes to merge on the next run', async () => {
  const h = harness([
    { pr: pullRequest('OPEN'), checks: checks([check('unit', 'pending'), check('lint', 'fail')], { mergeable: 'CONFLICTING' }) },
    { pr: pullRequest('OPEN'), checks: checks([check('unit', 'pass'), check('lint', 'fail')]) },
    { pr: pullRequest('MERGED') }
  ])
  const report = await h.run()
  assert.deepEqual(h.sleeps, [30_000], 'a failure beside a pending check is not a verdict yet')
  assert.equal(h.log[0], CHECKS_RUNNING_MSG)
  assert.equal(report.summary, 'CI failures detected on pull request #7')
  assert.deepEqual(report.findings.map((f) => [f.id, f.action, f.severity]), [['ci-lint', 'ask-user', 'error']])
  assert.equal(h.settled(), 0)
  const resumed = await h.run()
  assert.deepEqual(resumed.findings, [])
  assert.equal(resumed.summary, 'Pull request #7 merged after CI monitoring')
  assert.equal(h.settled(), 1)
})

test('ci monitor waits through pending checks, logs passed once, and settles when merged', async () => {
  const h = harness([
    { pr: pullRequest('OPEN'), checks: checks([check('unit', 'pending')]) },
    { pr: pullRequest('OPEN'), checks: checks([check('unit', 'pass')]) },
    { pr: pullRequest('OPEN'), checks: checks([check('unit', 'pass')]) },
    { pr: pullRequest('MERGED') }
  ])
  await h.run()
  assert.deepEqual(h.log, ['CI checks running, waiting for results...', CHECKS_PASSED_MSG, 'PR #7 has been merged'])
  assert.deepEqual(h.sleeps, [30_000, 30_000, 30_000])
  assert.equal(h.settled(), 1)
})

test('ci monitor throws when the pull request closes unmerged or its head drifts', async () => {
  await assert.rejects(harness([{ pr: pullRequest('CLOSED') }]).run(), new CiMonitorError('the exact pull request was closed without merging'))
  await assert.rejects(harness([{ pr: pullRequest('OPEN', 'c'.repeat(40)) }]).run(), new CiMonitorError('pull-request facts changed while monitoring CI'))
})

test('ci monitor gates on idle timeout and re-arms when the base branch advances', async () => {
  const green = checks([check('unit', 'pass')])
  const h = harness([
    { pr: pullRequest('OPEN'), checks: green },
    { pr: pullRequest('OPEN'), checks: green },
    { pr: pullRequest('OPEN'), checks: { ...green, baseRefOid: 'd'.repeat(40) } },
    { pr: pullRequest('OPEN'), checks: { ...green, baseRefOid: 'd'.repeat(40) } },
    { pr: pullRequest('OPEN'), checks: { ...green, baseRefOid: 'd'.repeat(40) } }
  ], { no_ci: false, timeout_ms: 70_000 })
  const report = await h.run()
  assert.equal(report.summary, CI_TIMEOUT_SUMMARY)
  assert.deepEqual(report.findings.map((f) => [f.id, f.action]), [['ci-timeout', 'ask-user']])
  assert.ok(h.log.some((line) => line.startsWith('base branch advanced')), h.log.join('\n'))
  // Without the re-arm the 70s timeout would fire after three sleeps; re-arming at 60s pushes it to five.
  assert.deepEqual(h.sleeps, [30_000, 30_000, 30_000, 30_000, 30_000])
})

test('ci monitor treats an empty check set as passing only when no_ci is trusted', async () => {
  const ticks = [{ pr: pullRequest('OPEN'), checks: checks([]) }, { pr: pullRequest('MERGED') }]
  const declared = harness(ticks, { no_ci: true, timeout_ms: 0 })
  await declared.run()
  assert.equal(declared.log[0], NO_CHECKS_PASSED_MSG)
  const undeclared = harness(ticks, { no_ci: false, timeout_ms: 0 })
  await undeclared.run()
  assert.equal(undeclared.log[0], NO_CHECKS_YET_MSG)
})

test('ci monitor reports merge conflicts and cancelled checks as findings', async () => {
  const h = harness([{ pr: pullRequest('OPEN'), checks: checks([check('e2e', 'cancel')], { mergeable: 'CONFLICTING' }) }])
  const report = await h.run()
  assert.deepEqual(report.findings.map((f) => f.id), ['ci-e2e', 'merge-conflict'])
})

test('ci poll interval backs off with elapsed time', () => {
  assert.deepEqual([0, 4 * 60_000, 5 * 60_000, 14 * 60_000, 15 * 60_000].map(ciPollIntervalMs), [30_000, 30_000, 60_000, 60_000, 120_000])
})
