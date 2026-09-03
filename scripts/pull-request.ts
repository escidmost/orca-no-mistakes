import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  GithubAuthorityError,
  type GithubIssueCommentObservation,
  type GithubPullRequestObservation
} from './github.ts'
import {
  DomainLedger,
  canonicalJson,
  evidenceSha256,
  redactKnownSecrets,
  sha256
} from './ledger.ts'

const MANAGED_SUMMARY_MARKER = '<!-- orca-no-mistakes:managed-summary:v1 -->'
const SUMMARY_BUDGET = 32 * 1024
const PULL_REQUEST_BODY_BUDGET = 65536

type PullRequestAuthority = {
  createIssueComment(input: { body: string; subjectId: string }): Promise<unknown>
  createPullRequest(input: {
    baseBranch: string
    baseRepositoryNodeId: string
    body: string
    draft: boolean
    headRefName: string
    title: string
  }): Promise<unknown>
  observeIssueComments(pullRequestNodeId: string): Promise<GithubIssueCommentObservation[]>
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
  updateIssueComment(input: { body: string; commentId: string }): Promise<unknown>
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

function capSummary(content: string, budget: number): string {
  if (Buffer.byteLength(content) <= budget) return content
  let capped = Buffer.from(content).subarray(0, budget).toString('utf8').replace(/\uFFFD$/u, '')
  while (Buffer.byteLength(capped) > budget) capped = capped.slice(0, -1)
  return capped
}

export function pullRequestContent(intent: string): { body: string; title: string } {
  const redacted = redactKnownSecrets(intent).trim() || 'Complete the validated pipeline changes.'
  const firstLine = redacted.split('\n', 1)[0].trim()
  const title = /^(?:[a-z]+(?:\([^)]+\))?!?:\s|[A-Z][A-Z0-9]+-\d+:\s)/.test(firstLine)
    ? firstLine
    : `chore: ${firstLine}`
  const prefix = '## Intent\n\n'
  const suffix = '\n\n## What Changed\n\nCompleted the validated pipeline changes for this run.\n'
  const cappedIntent = capSummary(
    redacted,
    PULL_REQUEST_BODY_BUDGET - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
  )
  return {
    title: title.slice(0, 256),
    body: `${prefix}${cappedIntent}${suffix}`
  }
}

export function managedSummary(input: {
  candidateCommitOid: string
  pipelineEvidenceRoot: string
  runId: string
  stageSummaries: string[]
}): string {
  const details = input.stageSummaries.length > 0
    ? input.stageSummaries.map((summary) => `- ${redactKnownSecrets(summary)}`).join('\n')
    : '- Pipeline stages completed without publishable details.'
  const prefix = `${MANAGED_SUMMARY_MARKER}\n## Pipeline Summary\n\n`
  const suffix = `\n\n` +
    `- Candidate: \`${input.candidateCommitOid}\`\n` +
    `- Pipeline Evidence Root: \`${input.pipelineEvidenceRoot}\`\n` +
    `- Run: \`${input.runId}\`\n`
  return `${prefix}${capSummary(details, SUMMARY_BUDGET - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`
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

function ownedComment(
  comments: GithubIssueCommentObservation[],
  actor: { login?: string; nodeId?: string | null },
  receiptNodeId?: string
): GithubIssueCommentObservation | undefined {
  const exactReceipt = receiptNodeId
    ? comments.find((comment) => comment.id === receiptNodeId)
    : undefined
  if (exactReceipt) return exactReceipt
  const owned = (comment: GithubIssueCommentObservation): boolean =>
    actor.nodeId != null
      ? comment.author?.id === actor.nodeId
      : actor.login != null && comment.author?.login === actor.login
  const marked = comments.filter((comment) =>
    owned(comment) && comment.body.startsWith(MANAGED_SUMMARY_MARKER)
  )
  if (marked.length > 1) {
    throw new PullRequestBindingError('multiple managed summary markers are ambiguous')
  }
  return marked[0]
}

export async function bindPullRequest(input: {
  artifactPath: string
  attemptId: string
  authority: PullRequestAuthority
  candidateCommitOid: string
  generationToken: number
  intent: string
  ledger: DomainLedger
  now?: () => string
  pipelineEvidenceRoot: string
  roundIndex?: number
  runId: string
  stageSummaries: string[]
  workerIdentity: string
}): Promise<{ commentNodeId: string; number: number; outcome: 'created' | 'unchanged' | 'updated'; receiptSha256: string; url: string }> {
  const now = input.now ?? (() => new Date().toISOString())
  const run = input.ledger.run(input.runId)
  const route = input.ledger.publicationRoute(input.runId)
  const repositoryRoute = run ? input.ledger.repositoryPublicationRoute(run.repo_root) : undefined
  if (!run || !route || !repositoryRoute ||
      repositoryRoute.route_fingerprint !== route.route_fingerprint) {
    throw new PullRequestBindingError('run publication route is not durable')
  }
  const publicationReceipt = input.ledger.remoteReceipt(input.runId, 'candidate-publication')
  if (!publicationReceipt || publicationReceipt.candidate_commit_oid !== input.candidateCommitOid) {
    throw new PullRequestBindingError('candidate publication must settle before PR binding')
  }
  const ownership = {
    branch: run.branch,
    generationToken: input.generationToken,
    repoRoot: run.repo_root
  }
  const requireLease = (): void => {
    if (!input.ledger.ownsLease(input.runId, ownership)) {
      throw new PullRequestBindingError('pull-request binding lease is no longer owned by this run generation')
    }
  }
  requireLease()

  const content = pullRequestContent(input.intent)
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
  const pullRequestIntent = input.ledger.recordMutationIntent({
    attemptId: input.attemptId,
    createdAt: mutationCreatedAt,
    kind: 'pull-request',
    payload: { action: 'ensure-open', ...routeFacts, body: content.body, title: content.title },
    runId: input.runId,
    targetFingerprint: route.route_fingerprint
  })

  let pullRequest = await observeExact(
    input.authority,
    route,
    repositoryRoute,
    input.candidateCommitOid
  )
  let created = false
  if (pullRequest?.state !== 'OPEN') {
    if (pullRequest) throw new PullRequestBindingError('the exact pull request is not open')
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
    pullRequest = await observeExact(
      input.authority,
      route,
      repositoryRoute,
      input.candidateCommitOid
    )
    if (!pullRequest || pullRequest.state !== 'OPEN') {
      throw new PullRequestBindingError('pull-request creation was not proven by the authoritative post-read')
    }
    created = true
  }
  if (pullRequest.draft) throw new PullRequestBindingError('the exact pull request is still a draft')
  const selectedPullRequest = { id: pullRequest.id, number: pullRequest.number }

  const summary = managedSummary(input)
  const previousReceipt = input.ledger.remoteReceipt(input.runId, 'pull-request-binding')
  const previousObservation = previousReceipt
    ? input.ledger.remoteObservation(
        input.runId,
        previousReceipt.authoritative_post_observation_sha256
      )
    : undefined
  const receiptNodeId = typeof previousObservation?.payload.managedCommentNodeId === 'string'
    ? previousObservation.payload.managedCommentNodeId
    : undefined
  let comments = await input.authority.observeIssueComments(pullRequest.id)
  let comment = ownedComment(comments, {
    login: repositoryRoute.actor_login,
    nodeId: repositoryRoute.actor_node_id
  }, receiptNodeId)
  const unresolvedCreate = input.ledger.unresolvedManagedCommentCreateIntent(input.runId)
  if (!comment && unresolvedCreate) {
    throw new PullRequestBindingError(
      `unresolved managed comment create intent (${unresolvedCreate.intentSha256}) requires manual resolution: managed comment is absent on pull request #${pullRequest.number}`
    )
  }
  let commentMutated = false
  const managedCommentCreatedAt = after(mutationCreatedAt, now())
  const managedCommentIntent = input.ledger.recordMutationIntent({
    attemptId: input.attemptId,
    createdAt: managedCommentCreatedAt,
    kind: 'managed-comment',
    payload: {
      action: 'ensure-managed-summary',
      bodySha256: sha256(summary),
      managedCommentNodeId: comment?.id ?? null,
      number: pullRequest.number
    },
    runId: input.runId,
    targetFingerprint: route.route_fingerprint
  })
  if (comment?.body !== summary) {
    try {
      requireLease()
    } catch (error) {
      input.ledger.resolveMutationIntent({
        attemptId: input.attemptId,
        intentSha256: managedCommentIntent,
        reason: 'lease-lost',
        runId: input.runId
      })
      throw error
    }
    commentMutated = true
    try {
      if (comment) {
        await input.authority.updateIssueComment({ body: summary, commentId: comment.id })
      } else {
        await input.authority.createIssueComment({ body: summary, subjectId: pullRequest.id })
      }
    } catch (error) {
      if (!(error instanceof GithubAuthorityError) || error.kind !== 'mutation-indeterminate') {
        input.ledger.resolveMutationIntent({
          attemptId: input.attemptId,
          intentSha256: managedCommentIntent,
          reason: 'definite-failure',
          runId: input.runId
        })
        throw error
      }
    }
    comments = await input.authority.observeIssueComments(pullRequest.id)
    comment = ownedComment(comments, {
      login: repositoryRoute.actor_login,
      nodeId: repositoryRoute.actor_node_id
    }, comment?.id)
  }
  if (!comment || comment.body !== summary) {
    throw new PullRequestBindingError('managed summary mutation was not proven by the authoritative post-read')
  }

  const finalPullRequest = await observeExact(
    input.authority,
    route,
    repositoryRoute,
    input.candidateCommitOid
  )
  if (
    !finalPullRequest ||
    finalPullRequest.state !== 'OPEN' ||
    finalPullRequest.draft ||
    finalPullRequest.headOid !== input.candidateCommitOid ||
    finalPullRequest.id !== selectedPullRequest.id ||
    finalPullRequest.number !== selectedPullRequest.number
  ) {
    throw new PullRequestBindingError('pull-request facts changed before settlement')
  }
  pullRequest = finalPullRequest
  const observedAt = after(managedCommentCreatedAt, now())
  const postRead = input.ledger.recordRemoteObservation({
    attemptId: input.attemptId,
    kind: 'pull-request',
    observedAt,
    payload: {
      ...routeFacts,
      managedCommentBodySha256: sha256(summary),
      managedCommentNodeId: comment.id,
      number: pullRequest.number,
      pullRequestNodeId: pullRequest.id,
      state: 'open'
    },
    runId: input.runId,
    subject: `${route.forge_host}/${route.base_repository_id}#${pullRequest.number}`
  })
  const outcome = created ? 'created' : commentMutated ? 'updated' : 'unchanged'
  const roundIndex = input.roundIndex ?? 0
  const artifactBytes = `${canonicalJson({
    findings: [],
    managedCommentIntent,
    mutationIntent: pullRequestIntent,
    number: pullRequest.number,
    outcome,
    postRead
  })}\n`
  await mkdir(dirname(input.artifactPath), { recursive: true })
  await writeFile(input.artifactPath, artifactBytes)
  const artifactSha256 = sha256(artifactBytes)
  const evidenceSummary = `Bound pull request #${pullRequest.number} and managed summary (${outcome})`
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
    checkpoint: {
      inputCommitOid: input.candidateCommitOid,
      outputCommitOid: input.candidateCommitOid,
      roundIndex
    },
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
        managedCommentIntent,
        mutationIntent: pullRequestIntent,
        number: pullRequest.number,
        outcome,
        pipelineEvidenceRoot: input.pipelineEvidenceRoot,
        postRead,
        routeFingerprint: route.route_fingerprint
      }
    },
    runId: input.runId,
    stageId: 'pr'
  })
  if (comment && unresolvedCreate) {
    input.ledger.resolveMutationIntent({
      attemptId: input.attemptId,
      intentSha256: unresolvedCreate.intentSha256,
      reason: 'reconciled',
      runId: input.runId
    })
  }
  return {
    commentNodeId: comment.id,
    number: pullRequest.number,
    outcome,
    receiptSha256: settlement.receiptSha256,
    url: pullRequest.url
  }
}
