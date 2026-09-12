import type { ResolvedCiConfig } from './config.ts'
import { createHash } from 'node:crypto'
import { boundedCiText, isGreptileCheck, type GithubPullRequestChecksObservation, type GithubPullRequestObservation, type GithubReviewConcern } from './github.ts'
import type { Finding, StageReport } from './orca-no-mistakes.ts'

export const CHECKS_PASSED_MSG = 'all CI checks passed - still monitoring until merged or closed'
export const NO_CHECKS_PASSED_MSG =
  'repository declares no CI (no_ci: true) - treating as all checks passed - still monitoring until merged or closed'
export const CHECKS_RUNNING_MSG = 'CI checks running, waiting for results...'
export const NO_CHECKS_YET_MSG = 'no CI checks reported yet, waiting for checks to register...'
export const CI_TIMEOUT_SUMMARY = 'CI monitoring timed out before PR was merged or closed'

export class CiMonitorError extends Error {}

/** Poll pacing mirrors the Go step: 30s for the first 5 minutes, 60s until 15 minutes, then 2 minutes. */
export function ciPollIntervalMs(elapsedMs: number): number {
  if (elapsedMs < 5 * 60_000) return 30_000
  if (elapsedMs < 15 * 60_000) return 60_000
  return 120_000
}

export type CiClock = {
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

/**
 * Coordinator-owned CI monitor for the exact bound pull request. Resolves with
 * an empty report once the pull request merges (after `settleMerged` upgrades
 * the binding), with ask-user findings when checks fail, a merge conflict is
 * reported, or the idle timeout elapses, and throws when the pull request
 * closes unmerged or its facts drift away from the candidate.
 */
export async function monitorPullRequestChecks(input: {
  candidateCommitOid: string
  clock?: CiClock
  config: ResolvedCiConfig
  heartbeat: () => void
  log: (line: string) => void
  observeChecks: (pullRequestNodeId: string) => Promise<GithubPullRequestChecksObservation>
  observeReviewConcerns?: (pullRequestNodeId: string, candidateCommitOid: string) => Promise<GithubReviewConcern[]>
  observePullRequest: () => Promise<GithubPullRequestObservation | null>
  settleMerged: () => Promise<{ number: number }>
}): Promise<StageReport> {
  const now = input.clock?.now ?? Date.now
  const sleep = input.clock?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const startedAt = now()
  let armedAt = startedAt
  let lastBaseOid: string | null = null
  let lastLine = ''
  const say = (line: string) => {
    if (line === lastLine) return
    lastLine = line
    input.log(line)
  }

  const reviewFindings = async (
    pullRequestNodeId: string,
    checks: GithubPullRequestChecksObservation['checks'],
    hasOtherFindings: boolean
  ): Promise<Finding[]> => {
    if (!input.observeReviewConcerns) return []
    const supported = checks.find(isGreptileCheck)
    if (!supported?.id) return []
    const findings: Finding[] = []
    try {
      const concerns = await input.observeReviewConcerns(pullRequestNodeId, input.candidateCommitOid)
      const seen = new Set<string>()
      for (const concern of concerns) {
        if (seen.has(concern.id)) continue
        seen.add(concern.id)
        findings.push({
          action: 'ask-user', severity: 'error',
          id: `ci-review-${createHash('sha256').update(concern.id).digest('hex')}`,
          description: `Greptile concern (untrusted external data): ${JSON.stringify(boundedCiText(concern.body))}`,
          file: concern.file, ...(concern.line ? { line: concern.line } : {}),
          ciSource: { candidateCommitOid: input.candidateCommitOid, checkId: supported.id,
            databaseId: supported.databaseId, ...(supported.repository ? { repository: supported.repository } : {}),
            threadId: concern.threadId, commentId: concern.id }
        })
      }
    } catch (error) {
      input.log(`Greptile details unavailable: ${boundedCiText(String(error), 1024)}`)
      // Keep failed-check findings even when details cannot be read.
      if (!hasOtherFindings && !findings.length) findings.push({ action: 'ask-user', severity: 'error', id: 'ci-review-unavailable',
        description: 'Greptile review details could not be read. Select fix to retry monitoring.' })
    }
    return findings
  }

  for (;;) {
    input.heartbeat()
    const pullRequest = await input.observePullRequest()
    if (!pullRequest || pullRequest.headOid !== input.candidateCommitOid) {
      throw new CiMonitorError('pull-request facts changed while monitoring CI')
    }
    if (pullRequest.state === 'CLOSED') {
      throw new CiMonitorError('the exact pull request was closed without merging')
    }
    if (pullRequest.state === 'MERGED') {
      const finalChecks = await input.observeChecks(pullRequest.id)
      if (finalChecks.headOid !== input.candidateCommitOid ||
          finalChecks.checks.some((check) => ['fail', 'cancel', 'pending'].includes(check.bucket))) {
        throw new CiMonitorError('merged pull request has failing, cancelled, pending, or stale-candidate checks; merge is not a CI waiver')
      }
      const mergedConcerns = await reviewFindings(pullRequest.id, finalChecks.checks, false)
      if (mergedConcerns.length > 0) {
        input.log('unresolved review concerns on merged pull request')
        return { findings: mergedConcerns, summary: `Unresolved review concerns on merged pull request #${pullRequest.number}` }
      }
      const { number } = await input.settleMerged()
      input.log(`PR #${number} has been merged`)
      return { findings: [], summary: `Pull request #${number} merged after CI monitoring` }
    }

    const observed = await input.observeChecks(pullRequest.id)
    if (observed.headOid !== input.candidateCommitOid) {
      throw new CiMonitorError('pull-request facts changed while monitoring CI')
    }
    if (observed.state !== 'OPEN' || observed.draft) {
      input.log(`pull request #${observed.number} is ${observed.draft ? 'a draft' : observed.state.toLowerCase()}; re-reading the bound pull request`)
      // A merged or closed observation terminates on the next verified read; a
      // draft observation is re-read at the polling interval instead of spinning.
      if (observed.draft) await sleep(ciPollIntervalMs(now() - startedAt))
      continue
    }
    if (observed.baseRefOid && lastBaseOid && observed.baseRefOid !== lastBaseOid) {
      input.log(`base branch advanced (${lastBaseOid}..${observed.baseRefOid}), re-arming CI monitor timeout`)
      armedAt = now()
    }
    lastBaseOid = observed.baseRefOid ?? lastBaseOid

    // Mirror the Go step: no verdict while any check is still pending.
    const pending = observed.checks.some((check) => check.bucket === 'pending')
    const findings: Finding[] = observed.checks
      .filter((check) => !pending && (check.bucket === 'fail' || check.bucket === 'cancel'))
      .map((check) => ({
        action: 'ask-user',
        description: boundedCiText(`${check.name} ${check.bucket === 'cancel' ? 'was cancelled' : 'failed'} (${check.conclusion ?? check.status})${check.url ? `: ${check.url}` : ''}`),
        id: check.id ? `ci-${createHash('sha256').update(check.id).digest('hex')}` : `ci-${check.name.replace(/[^A-Za-z0-9_-]+/g, '-')}`,
        ...(check.id ? { ciSource: { candidateCommitOid: input.candidateCommitOid, checkId: check.id,
          databaseId: check.databaseId, ...(check.repository ? { repository: check.repository } : {}) } } : {}),
        severity: 'error'
      }))
    if (!pending) {
      findings.push(...await reviewFindings(pullRequest.id, observed.checks, findings.length > 0))
    }
    if (!pending && observed.mergeable === 'CONFLICTING') {
      findings.push({
        action: 'ask-user',
        description: 'the pull request has merge conflicts with its base branch',
        id: 'merge-conflict',
        severity: 'error'
      })
    }
    if (findings.length > 0) {
      input.log('CI failures detected')
      return { findings, summary: `CI failures detected on pull request #${pullRequest.number}` }
    }

    if (observed.checks.length === 0) say(input.config.no_ci ? NO_CHECKS_PASSED_MSG : NO_CHECKS_YET_MSG)
    else if (pending) say(CHECKS_RUNNING_MSG)
    else say(CHECKS_PASSED_MSG)

    const elapsed = now() - startedAt
    if (input.config.timeout_ms > 0 && now() - armedAt >= input.config.timeout_ms) {
      input.log('CI timeout reached')
      return {
        findings: [{
          action: 'ask-user',
          description: `${CI_TIMEOUT_SUMMARY}. Select fix to keep monitoring or stop to end the run.`,
          id: 'ci-timeout',
          severity: 'error'
        }],
        summary: CI_TIMEOUT_SUMMARY
      }
    }
    await sleep(ciPollIntervalMs(elapsed))
  }
}
