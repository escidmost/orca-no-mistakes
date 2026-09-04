import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  GithubAuthorityError,
  type GithubPullRequestObservation
} from './github.ts'
import {
  DomainLedger,
  canonicalJson,
  evidenceSha256,
  redactKnownSecrets,
  sha256
} from './ledger.ts'

const PULL_REQUEST_BODY_BUDGET = 63_488
const PIPELINE_SIGNATURE = 'Updates from [git push orca-no-mistakes](https://github.com/Filamess/orca-no-mistakes)'
const ATTESTATION_PREFIX = '<!-- orca-no-mistakes-pipeline-attestation:v1 '
const ARTIFACT_BUDGET = 16 * 1024
const TOTAL_ARTIFACT_BUDGET = 24 * 1024
const PIPELINE_DETAILS_BUDGET = 16 * 1024

export type PullRequestArtifact = { content: string; name: string }
export type PullRequestPipelineFinding = {
  description: string
  file?: string
  line?: number
  severity: 'error' | 'info' | 'warning'
}
export type PullRequestPipelineRound = {
  findings: PullRequestPipelineFinding[]
  fixSummary?: string
  summary: string
  tested?: string[]
}
export type PullRequestPipelineStep = {
  approvedFindings?: number
  details?: string
  fixedFindings?: number
  name: string
  openFindings?: number
  rounds?: PullRequestPipelineRound[]
  status: string
}
export type PullRequestReport = {
  candidateCommitOid: string
  pipelineSteps: PullRequestPipelineStep[]
  risk: { level: 'high' | 'low' | 'medium'; rationale: string }
  testing: {
    artifacts: PullRequestArtifact[]
    summary: string
    tested: string[]
  }
  title?: string
  whatChanged: string
}

type PullRequestAuthority = {
  createPullRequest(input: {
    baseBranch: string
    baseRepositoryNodeId: string
    body: string
    draft: boolean
    headRefName: string
    title: string
  }): Promise<unknown>
  observePullRequests(input: {
    baseBranch: string
    baseRepositoryId: string
    baseRepositoryName: string
    baseRepositoryNodeId: string
    candidateHeadOid: string
    headBranch: string
    headRepositoryId: string
    headRepositoryNodeId: string
  }): Promise<{
    exact: GithubPullRequestObservation | null
    nearMatches: GithubPullRequestObservation[]
  }>
  updatePullRequest(input: {
    body: string
    pullRequestId: string
    title: string
  }): Promise<unknown>
}

export class PullRequestBindingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PullRequestBindingError'
  }
}

function after(earlier: string, candidate: string): string {
  return candidate > earlier ? candidate : new Date(Date.parse(earlier) + 1).toISOString()
}

export function escapeUntrustedMarkdown(content: string): string {
  return redactKnownSecrets(content)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function capText(content: string, budget: number): string {
  return capEscapedText(escapeUntrustedMarkdown(content), budget)
}

function capEscapedText(content: string, budget: number): string {
  if (Buffer.byteLength(content) <= budget) return content
  const marker = '\n\n_[truncated to fit GitHub PR body limits]_'
  const markerBytes = Buffer.byteLength(marker)
  const available = Math.max(0, budget - (budget >= markerBytes ? markerBytes : 0))
  let capped = Buffer.from(content).subarray(0, available).toString('utf8').replace(/\uFFFD$/u, '')
  if (budget < markerBytes) return capped
  while (Buffer.byteLength(capped + marker) > budget) capped = capped.slice(0, -1)
  return capped + marker
}

export function capTitle(content: string, budget = 256): string {
  const singleLine = redactKnownSecrets(content)
    .replaceAll(/[\r\n]+/gu, ' ')
    .trim()
  if (Buffer.byteLength(singleLine) <= budget) return singleLine
  let capped = Buffer.from(singleLine).subarray(0, budget).toString('utf8').replace(/\uFFFD$/u, '')
  while (Buffer.byteLength(capped) > budget) capped = capped.slice(0, -1)
  return capped
}

function testingSection(testing: PullRequestReport['testing']): string {
  const commands = testing.tested.length > 0
    ? `\n\nCommands and checks:\n${capText(testing.tested.map((command) => `- ${command}`).join('\n'), 4096)}`
    : ''
  let remaining = TOTAL_ARTIFACT_BUDGET
  const artifacts: string[] = []
  for (const artifact of testing.artifacts) {
    const separatorBytes = artifacts.length > 0 ? Buffer.byteLength('\n\n') : 0
    const name = capText(artifact.name, 512)
    const framingBytes = Buffer.byteLength(`<details>\n<summary>${name}</summary>\n\n<pre></pre>\n\n</details>`) + separatorBytes
    if (remaining <= framingBytes) break
    const contentBudget = Math.min(ARTIFACT_BUDGET, remaining - framingBytes)
    const content = capText(artifact.content, contentBudget)
    const entry = `<details>\n<summary>${name}</summary>\n\n<pre>${content}</pre>\n\n</details>`
    const entryBytes = Buffer.byteLength(entry) + separatorBytes
    if (entryBytes > remaining) break
    remaining -= entryBytes
    artifacts.push(entry)
  }
  return `## Testing\n\n${capText(testing.summary, 4096)}${commands}${artifacts.length > 0 ? `\n\n${artifacts.join('\n\n')}` : ''}`
}

function displayStepName(name: string): string {
  const normalized = name.toLowerCase()
  if (normalized === 'ci' || normalized === 'pr') return normalized.toUpperCase()
  return normalized.length > 0 ? normalized[0].toUpperCase() + normalized.slice(1) : 'Stage'
}

function issueLabel(count: number): string {
  return `${count} ${count === 1 ? 'issue' : 'issues'}`
}

function pipelineStepSummary(step: PullRequestPipelineStep): string {
  const name = `**${displayStepName(step.name)}**`
  switch (step.status) {
    case 'pending':
      return `⏳ ${name} - pending`
    case 'running':
      return `⏳ ${name} - running`
    case 'skipped':
      return `⏭️ ${name} - skipped`
    case 'approved':
      return `⚠️ ${name} - ${step.approvedFindings ? `${issueLabel(step.approvedFindings)} approved` : 'approved'}`
    case 'failed':
      return `❌ ${name} - failed`
  }
  const fixed = step.fixedFindings ?? 0
  const approved = step.approvedFindings ?? 0
  const open = step.openFindings ?? 0
  const total = fixed + approved + open
  if (fixed > 0) {
    const outcome = [`${fixed} auto-fixed`, ...(approved > 0 ? [`${approved} approved`] : [])].join(' · ')
    return `🔧 ${name} - ${issueLabel(total)} found → ${outcome} ✅`
  }
  if (approved > 0) return `⚠️ ${name} - ${issueLabel(approved)} approved`
  if (open > 0) return `⚠️ ${name} - ${issueLabel(open)} remain`
  return `✅ ${name} - passed`
}

function pipelineFinding(finding: PullRequestPipelineFinding): string {
  const emoji = finding.severity === 'error' ? '🚨' : finding.severity === 'warning' ? '⚠️' : 'ℹ️'
  const location = finding.file
    ? `\`${finding.file}${finding.line ? `:${finding.line}` : ''}\` - `
    : ''
  return `- ${emoji} ${location}${finding.description}`
}

function pipelineStepDetails(step: PullRequestPipelineStep): string | undefined {
  if (!step.rounds || step.rounds.length === 0) return step.details
  const sections: string[] = []
  for (const [index, round] of step.rounds.entries()) {
    if (round.fixSummary) sections.push(`🔧 Fix: ${round.fixSummary}`)
    if (round.findings.length > 0) {
      if (index > 0) sections.push(`${issueLabel(round.findings.length)} still open:`)
      sections.push(round.findings.map(pipelineFinding).join('\n'))
    } else if (round.fixSummary) {
      sections.push('✅ Re-checked - no issues remain.')
    } else if (round.summary.trim()) {
      sections.push(round.summary)
    }
    if (round.tested?.length) {
      sections.push(round.tested.map((command) => `- ${command}`).join('\n'))
    }
  }
  if ((step.approvedFindings ?? 0) > 0) {
    sections.push(`⚠️ ${issueLabel(step.approvedFindings ?? 0)} approved as-is.`)
  }
  return sections.join('\n\n')
}

function pipelineSection(candidateCommitOid: string, steps: PullRequestPipelineStep[]): string {
  const attestation = JSON.stringify({
    head_sha: candidateCommitOid,
    steps: steps.map((step) => ({ step: capText(step.name, 128), status: capText(step.status, 128) }))
  })
  let remaining = PIPELINE_DETAILS_BUDGET
  const details: string[] = []
  for (const step of steps) {
    const stepDetails = pipelineStepDetails(step)
    if (!stepDetails || remaining <= 0) continue
    const summary = capText(pipelineStepSummary(step), 512)
    const separatorBytes = details.length > 0 ? Buffer.byteLength('\n\n') : 0
    const framingBytes = Buffer.byteLength(`<details>\n<summary>${summary}</summary>\n\n\n\n</details>`) + separatorBytes
    if (remaining <= framingBytes) break
    const content = capText(stepDetails, Math.min(4096, remaining - framingBytes))
    const entry = `<details>\n<summary>${summary}</summary>\n\n${content}\n\n</details>`
    const entryBytes = Buffer.byteLength(entry) + separatorBytes
    if (entryBytes > remaining) break
    remaining -= entryBytes
    details.push(entry)
  }
  return `## Pipeline\n\n${PIPELINE_SIGNATURE}\n\n${ATTESTATION_PREFIX}${attestation} -->${details.length > 0 ? `\n\n${details.join('\n\n')}` : ''}`
}

export function pullRequestContent(intent: string, report: PullRequestReport): { body: string; title: string } {
  const redactedIntent = redactKnownSecrets(intent).trim() || 'Complete the validated pipeline changes.'
  const firstLine = redactedIntent.split('\n', 1)[0].trim()
  const fallbackTitle = /^(?:[a-z]+(?:\([^)]+\))?!?:\s|[A-Z][A-Z0-9]+-\d+:\s)/.test(firstLine)
    ? firstLine
    : `chore: ${firstLine}`
  const riskEmoji = report.risk.level === 'high' ? '🚨' : report.risk.level === 'medium' ? '⚠️' : '✅'
  const otherSections = [
    `## Risk Assessment\n\n${riskEmoji} ${report.risk.level[0].toUpperCase()}${report.risk.level.slice(1)}: ${capText(report.risk.rationale, 2048)}`,
    testingSection(report.testing),
    pipelineSection(report.candidateCommitOid, report.pipelineSteps)
  ].join('\n\n')

  const intentPrefix = '## Intent\n\n'
  const whatChangedPrefix = '## What Changed\n\n'
  const framingBytes = Buffer.byteLength(`${intentPrefix}\n\n${whatChangedPrefix}\n\n${otherSections}\n`)
  const totalAvailable = Math.max(0, PULL_REQUEST_BODY_BUDGET - framingBytes)

  const sanitizedWhatChanged = escapeUntrustedMarkdown(report.whatChanged)
  const sanitizedIntent = escapeUntrustedMarkdown(redactedIntent)

  const whatChangedBytes = Buffer.byteLength(sanitizedWhatChanged)
  const intentBytes = Buffer.byteLength(sanitizedIntent)

  let finalIntent: string
  let finalWhatChanged: string

  if (whatChangedBytes + intentBytes <= totalAvailable) {
    finalWhatChanged = sanitizedWhatChanged
    finalIntent = sanitizedIntent
  } else if (whatChangedBytes + 256 <= totalAvailable) {
    finalWhatChanged = sanitizedWhatChanged
    finalIntent = capEscapedText(sanitizedIntent, totalAvailable - whatChangedBytes)
  } else {
    finalIntent = capEscapedText(sanitizedIntent, Math.min(256, totalAvailable))
    const availableForWhatChanged = Math.max(0, totalAvailable - Buffer.byteLength(finalIntent))
    finalWhatChanged = capEscapedText(sanitizedWhatChanged, availableForWhatChanged)
  }

  const body = `${intentPrefix}${finalIntent}\n\n${whatChangedPrefix}${finalWhatChanged}\n\n${otherSections}\n`
  if (Buffer.byteLength(body) > PULL_REQUEST_BODY_BUDGET) {
    throw new PullRequestBindingError('generated pull-request body exceeds GitHub limit')
  }
  return {
    body,
    title: capTitle(report.title?.trim() || fallbackTitle, 256)
  }
}

async function observeExact(
  authority: PullRequestAuthority,
  route: NonNullable<ReturnType<DomainLedger['publicationRoute']>>,
  repositoryRoute: NonNullable<ReturnType<DomainLedger['repositoryPublicationRoute']>>,
  candidateCommitOid: string
): Promise<GithubPullRequestObservation | null> {
  const observed = await authority.observePullRequests({
    baseBranch: route.base_branch,
    baseRepositoryId: route.base_repository_id,
    baseRepositoryName: repositoryRoute.base_repository_name,
    baseRepositoryNodeId: repositoryRoute.base_repository_node_id,
    candidateHeadOid: candidateCommitOid,
    headBranch: route.head_branch,
    headRepositoryId: route.head_repository_id,
    headRepositoryNodeId: repositoryRoute.head_repository_node_id
  })
  if (!observed.exact && observed.nearMatches.length > 0) {
    throw new PullRequestBindingError('pull-request route has conflicting near matches')
  }
  return observed.exact
}

export async function bindPullRequest(input: {
  artifactPath: string
  attemptId: string
  authority: PullRequestAuthority
  candidateCommitOid: string
  content: { body: string; title: string }
  generationToken: number
  ledger: DomainLedger
  now?: () => string
  onReady?: (pullRequest: {
    number: number
    outcome: 'created' | 'unchanged' | 'updated'
    title: string
    url: string
  }) => Promise<void>
  pipelineEvidenceRoot: string
  pollIntervalMs?: number
  roundIndex?: number
  runId: string
  sleep?: (milliseconds: number) => Promise<void>
  workerIdentity: string
}): Promise<{ number: number; outcome: 'created' | 'unchanged' | 'updated'; receiptSha256: string; url: string }> {
  const now = input.now ?? (() => new Date().toISOString())
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const content = input.content
  const run = input.ledger.run(input.runId)
  const route = input.ledger.publicationRoute(input.runId)
  const repositoryRoute = run ? input.ledger.repositoryPublicationRoute(run.repo_root) : undefined
  if (!run || !route || !repositoryRoute || repositoryRoute.route_fingerprint !== route.route_fingerprint) {
    throw new PullRequestBindingError('run publication route is not durable')
  }
  const publicationReceipt = input.ledger.remoteReceipt(input.runId, 'candidate-publication')
  if (!publicationReceipt || publicationReceipt.candidate_commit_oid !== input.candidateCommitOid) {
    throw new PullRequestBindingError('candidate publication must settle before PR binding')
  }
  const ownership = { branch: run.branch, generationToken: input.generationToken, repoRoot: run.repo_root }
  const requireLease = (): void => {
    if (!input.ledger.ownsLease(input.runId, ownership)) {
      throw new PullRequestBindingError('pull-request binding lease is no longer owned by this run generation')
    }
  }
  requireLease()

  const routeFacts = {
    baseBranch: route.base_branch,
    baseRepositoryId: route.base_repository_id,
    candidateCommitOid: input.candidateCommitOid,
    forgeHost: route.forge_host,
    headBranch: route.head_branch,
    headOwner: route.head_owner,
    headRepositoryId: route.head_repository_id
  }
  const mutationCreatedAt = now()
  const mutationIntent = input.ledger.recordMutationIntent({
    attemptId: input.attemptId,
    createdAt: mutationCreatedAt,
    kind: 'pull-request',
    payload: { action: 'ensure-body-and-await-merge', ...routeFacts, body: content.body, title: content.title },
    runId: input.runId,
    targetFingerprint: route.route_fingerprint
  })

  let pullRequest = await observeExact(input.authority, route, repositoryRoute, input.candidateCommitOid)
  let created = false
  let updated = false
  if (!pullRequest) {
    requireLease()
    try {
      await input.authority.createPullRequest({
        baseBranch: route.base_branch,
        baseRepositoryNodeId: repositoryRoute.base_repository_node_id,
        body: content.body,
        draft: false,
        headRefName: `${route.head_owner}:${route.head_branch}`,
        title: content.title
      })
    } catch (error) {
      if (!(error instanceof GithubAuthorityError) || error.kind !== 'mutation-indeterminate') throw error
    }
    pullRequest = await observeExact(input.authority, route, repositoryRoute, input.candidateCommitOid)
    if (!pullRequest) {
      throw new PullRequestBindingError('pull-request creation was not proven by the authoritative post-read')
    }
    created = true
  }
  if (pullRequest.state === 'CLOSED') throw new PullRequestBindingError('the exact pull request was closed without merging')
  if (pullRequest.draft) throw new PullRequestBindingError('the exact pull request is still a draft')
  const selectedPullRequest = { id: pullRequest.id, number: pullRequest.number }

  if (pullRequest.state === 'MERGED') {
    if (pullRequest.body !== content.body || pullRequest.title !== content.title) {
      throw new PullRequestBindingError('pull-request facts changed before merge')
    }
  } else if (pullRequest.body !== content.body || pullRequest.title !== content.title) {
    requireLease()
    try {
      await input.authority.updatePullRequest({
        body: content.body,
        pullRequestId: pullRequest.id,
        title: content.title
      })
    } catch (error) {
      if (!(error instanceof GithubAuthorityError) || error.kind !== 'mutation-indeterminate') throw error
    }
    pullRequest = await observeExact(input.authority, route, repositoryRoute, input.candidateCommitOid)
    if (
      !pullRequest ||
      pullRequest.id !== selectedPullRequest.id ||
      pullRequest.number !== selectedPullRequest.number ||
      pullRequest.body !== content.body ||
      pullRequest.title !== content.title
    ) {
      throw new PullRequestBindingError('pull-request body update was not proven by the authoritative post-read')
    }
    if (pullRequest.state === 'CLOSED') throw new PullRequestBindingError('the exact pull request was closed without merging')
    if (pullRequest.draft) throw new PullRequestBindingError('the exact pull request is still a draft')
    updated = true
  }

  const outcome = created ? 'created' : updated ? 'updated' : 'unchanged'
  if (pullRequest.state === 'OPEN') {
    await input.onReady?.({
      number: pullRequest.number,
      outcome,
      title: content.title,
      url: pullRequest.url
    })
    if (input.onReady) {
      const observed = await observeExact(input.authority, route, repositoryRoute, input.candidateCommitOid)
      if (
        !observed ||
        observed.id !== selectedPullRequest.id ||
        observed.number !== selectedPullRequest.number ||
        observed.headOid !== input.candidateCommitOid ||
        observed.draft ||
        observed.title !== content.title ||
        observed.body !== content.body
      ) {
        throw new PullRequestBindingError('pull-request facts changed after readiness notification')
      }
      pullRequest = observed
    }
  }
  while (pullRequest.state === 'OPEN') {
    await sleep(input.pollIntervalMs ?? 15_000)
    input.ledger.heartbeatLease(run.repo_root, run.branch, input.runId)
    requireLease()
    const observed = await observeExact(input.authority, route, repositoryRoute, input.candidateCommitOid)
    if (
      !observed ||
      observed.id !== selectedPullRequest.id ||
      observed.number !== selectedPullRequest.number ||
      observed.headOid !== input.candidateCommitOid ||
      observed.draft ||
      observed.title !== content.title ||
      observed.body !== content.body
    ) {
      throw new PullRequestBindingError('pull-request facts changed while awaiting merge')
    }
    pullRequest = observed
  }
  if (pullRequest.state !== 'MERGED') {
    throw new PullRequestBindingError('the exact pull request was closed without merging')
  }
  if (
    pullRequest.draft ||
    pullRequest.title !== content.title ||
    pullRequest.body !== content.body
  ) {
    throw new PullRequestBindingError('pull-request facts changed before merge')
  }

  const observedAt = after(mutationCreatedAt, now())
  const postRead = input.ledger.recordRemoteObservation({
    attemptId: input.attemptId,
    kind: 'pull-request',
    observedAt,
    payload: {
      ...routeFacts,
      bodySha256: sha256(pullRequest.body),
      number: pullRequest.number,
      pullRequestNodeId: pullRequest.id,
      state: 'merged',
      titleSha256: sha256(pullRequest.title)
    },
    runId: input.runId,
    subject: `${route.forge_host}/${route.base_repository_id}#${pullRequest.number}`
  })
  const roundIndex = input.roundIndex ?? 0
  const artifactBytes = `${canonicalJson({ findings: [], mutationIntent, number: pullRequest.number, outcome, postRead })}\n`
  await mkdir(dirname(input.artifactPath), { recursive: true })
  await writeFile(input.artifactPath, artifactBytes)
  const artifactSha256 = sha256(artifactBytes)
  const evidenceSummary = `Pull request #${pullRequest.number} merged after publishing the complete pipeline report (${outcome})`
  const evidenceDigest = evidenceSha256({
    artifactSha256,
    baseCommitOid: input.candidateCommitOid,
    candidateCommitOid: input.candidateCommitOid,
    exitCode: 0,
    round: roundIndex,
    runId: input.runId,
    stage: 'pr',
    summary: evidenceSummary,
    workerIdentity: input.workerIdentity
  })
  const settlement = input.ledger.settleRemoteStage({
    checkpoint: { inputCommitOid: input.candidateCommitOid, outputCommitOid: input.candidateCommitOid, roundIndex },
    evidence: {
      artifactPath: input.artifactPath,
      artifactSha256,
      baseCommitOid: input.candidateCommitOid,
      candidateCommitOid: input.candidateCommitOid,
      evidenceSha256: evidenceDigest,
      exitCode: 0,
      findingsJson: '[]',
      roundIndex,
      runId: input.runId,
      stageId: 'pr',
      summary: evidenceSummary,
      workerIdentity: input.workerIdentity
    },
    ownership,
    receipt: {
      authoritativePostObservationSha256: postRead,
      candidateCommitOid: input.candidateCommitOid,
      kind: 'pull-request-binding',
      payload: {
        bodySha256: sha256(pullRequest.body),
        mutationIntent,
        number: pullRequest.number,
        outcome,
        pipelineEvidenceRoot: input.pipelineEvidenceRoot,
        postRead,
        routeFingerprint: route.route_fingerprint,
        state: 'merged',
        titleSha256: sha256(pullRequest.title)
      }
    },
    runId: input.runId,
    stageId: 'pr'
  })
  return {
    number: pullRequest.number,
    outcome,
    receiptSha256: settlement.receiptSha256,
    url: pullRequest.url
  }
}
