import { dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

import type { CommandResult, CommandRunner } from './github.ts'
import { parseGithubRepositoryReference, runCommand } from './github.ts'
import {
  canonicalJson,
  evidenceSha256,
  finalContiguousCheckpointByStage,
  gateAuditMatchesEvidence,
  isAuthoritativeStageEvidence,
  isCandidateReachable,
  sha256,
  type DomainLedger
} from './ledger.ts'

const OID_PATTERN = /^[0-9a-f]{40,64}$/

export class CandidatePublicationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CandidatePublicationError'
  }
}

export type RepositoryIdentity = { id: string; nodeId?: string | null }
export type RepositoryIdentityResolver = (reference: string) => Promise<RepositoryIdentity>

type AdmissionInput = {
  ledger: DomainLedger
  runId: string
  destination: string
  resolveRepositoryIdentity: RepositoryIdentityResolver
  runner?: CommandRunner
  env?: NodeJS.ProcessEnv
  observedAt?: string
}

type PublicationInput = {
  ledger: DomainLedger
  runId: string
  attemptId: string
  generationToken: number
  destination: string
  resolveRepositoryIdentity: RepositoryIdentityResolver
  artifactPath: string
  workerIdentity: string
  reconcileExactCandidate?: boolean
  runner?: CommandRunner
  env?: NodeJS.ProcessEnv
  now?: () => string
}

type HeadState = { oid: string | null }

function after(previous: string, current: string): string {
  const previousTime = Date.parse(previous)
  const currentTime = Date.parse(current)
  return Number.isFinite(previousTime) && Number.isFinite(currentTime) && currentTime <= previousTime
    ? new Date(previousTime + 1).toISOString()
    : current
}

function headRef(branch: string): string {
  if (!branch || branch.startsWith('-')) {
    throw new CandidatePublicationError(`invalid publication branch: ${branch}`)
  }
  return `refs/heads/${branch}`
}

async function readHead(
  runner: CommandRunner,
  destination: string,
  ref: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<HeadState> {
  if (!destination || destination.startsWith('-')) {
    throw new CandidatePublicationError('publication destination is invalid')
  }
  await rejectUrlRewrite(runner, destination, cwd, env)
  const result = await runner(
    'git',
    ['ls-remote', '--exit-code', '--refs', destination, ref],
    { cwd, env }
  )
  const output = result.stdout.trim()
  if (result.code === 2 && output === '') return { oid: null }
  if (result.code !== 0) {
    throw new CandidatePublicationError(
      `cannot read publication head ${ref}: ${result.stderr.trim() || `git exited ${result.code}`}`
    )
  }
  const lines = output.split('\n')
  const match = lines.length === 1 ? /^([0-9a-f]{40,64})\t(.+)$/.exec(lines[0]!) : null
  if (!match || match[2] !== ref) {
    throw new CandidatePublicationError(`malformed publication head response for ${ref}`)
  }
  return { oid: match[1]! }
}

async function rejectUrlRewrite(
  runner: CommandRunner,
  destination: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const result = await runner(
    'git',
    ['config', '--get-regexp', '^url\\..*\\..*insteadof$'],
    { cwd, env }
  )
  if (result.code === 1 && result.stdout.trim() === '') return
  if (result.code !== 0) {
    throw new CandidatePublicationError('cannot verify publication transport URL rewrites')
  }
  const rewritten = result.stdout
    .trim()
    .split('\n')
    .some((line) => destination.startsWith(line.replace(/^\S+\s+/, '')))
  if (rewritten) {
    throw new CandidatePublicationError('publication destination is redirected by Git url.* rewrite configuration')
  }
}

function transportIdentity(destination: string, forgeHost: string): string {
  const explicit = destination.trim()
  if (
    !/^git@github\.com:/i.test(explicit) &&
    !/^https:\/\/github\.com\//i.test(explicit) &&
    !/^ssh:\/\/git@github\.com\//i.test(explicit)
  ) {
    throw new CandidatePublicationError(
      'publication destination must identify a credential-free github.com repository'
    )
  }
  let reference: { name: string; owner: string }
  try {
    reference = parseGithubRepositoryReference(destination)
  } catch {
    throw new CandidatePublicationError(
      'publication destination must identify a credential-free github.com repository'
    )
  }
  return `${forgeHost}/${reference.owner}/${reference.name}`
}

async function requireStoredRepositoryIdentity(
  resolveRepositoryIdentity: RepositoryIdentityResolver,
  reference: string,
  storedRoute: { head_repository_id: string; head_repository_node_id: string | null }
): Promise<void> {
  const identity = await resolveRepositoryIdentity(reference)
  if (identity.id !== storedRoute.head_repository_id) {
    throw new CandidatePublicationError(
      `publication destination ${reference} resolves to repository ${identity.id}, not the stored route repository ${storedRoute.head_repository_id}`
    )
  }
  if (
    storedRoute.head_repository_node_id !== null &&
    identity.nodeId !== storedRoute.head_repository_node_id
  ) {
    throw new CandidatePublicationError(
      `publication destination ${reference} resolves to repository node ${identity.nodeId}, not the stored route repository node ${storedRoute.head_repository_node_id}`
    )
  }
}

export function terminalCandidate(
  ledger: DomainLedger,
  runId: string,
  verifyRetainedArtifacts = true
): string {
  const run = ledger.run(runId)
  if (!run) throw new CandidatePublicationError(`run ${runId} does not exist`)
  const plan = ledger.stagePlan(runId)
  const pushIndex = plan.findIndex((stage) => stage.stage_id === 'push')
  const validTail = pushIndex === plan.length - 1 ||
    (pushIndex === plan.length - 2 && plan.at(-1)?.stage_id === 'pr')
  if (pushIndex < 1 || !validTail) {
    throw new CandidatePublicationError('publication requires push immediately before optional PR binding')
  }

  const dispositions = new Map(ledger.stageDispositions(runId).map((row) => [row.stage_id, row]))
  const evidenceByDigest = new Map(
    ledger.listEvidence(runId).map((row) => [row.evidence_sha256, row])
  )
  const checkpoints = ledger.listCheckpoints(runId)
  const finalCheckpoint = finalContiguousCheckpointByStage(
    plan.slice(0, pushIndex).map((stage) => stage.stage_id),
    checkpoints,
    run.submission_commit_oid,
    Array.from(dispositions.entries()).map(([stageId, disp]) => {
      const ev = disp.evidence_sha256 ? evidenceByDigest.get(disp.evidence_sha256) : undefined
      return ev ? { stage_id: stageId, candidate_commit_oid: ev.candidate_commit_oid, round_index: ev.round_index } : undefined
    }).filter(Boolean) as any
  )
  const gateAudits = ledger.listGateAudit(runId)

  let candidate = run.submission_commit_oid
  let currentCandidate: string | undefined = run.submission_commit_oid
  for (const stage of plan.slice(0, pushIndex)) {
    const disposition = dispositions.get(stage.stage_id)
    if (!disposition) throw new CandidatePublicationError(`stage ${stage.stage_id} has no terminal disposition`)
    const accepted = stage.requirement === 'disabled'
      ? disposition.disposition === 'disabled'
      : disposition.disposition === 'satisfied' ||
        (stage.requirement === 'optional' &&
          (disposition.disposition === 'skipped' || disposition.disposition === 'waived'))
    if (!accepted) throw new CandidatePublicationError(`stage ${stage.stage_id} is not publication-ready`)

    const final = finalCheckpoint.get(stage.stage_id)
    if (disposition.disposition !== 'satisfied') {
      if (final) throw new CandidatePublicationError(`non-executed stage ${stage.stage_id} has a checkpoint`)
      continue
    }
    if (!final) {
      throw new CandidatePublicationError(
        `stage ${stage.stage_id} does not extend the contiguous candidate chain`
      )
    }
    if (
      currentCandidate !== undefined &&
      !isCandidateReachable(currentCandidate, final.input_commit_oid, checkpoints)
    ) {
      throw new CandidatePublicationError(
        `stage ${stage.stage_id} does not extend the contiguous candidate chain`
      )
    }
    const evidence = disposition.evidence_sha256
      ? evidenceByDigest.get(disposition.evidence_sha256)
      : undefined
    const approved = evidence !== undefined && gateAudits.some(
      (audit) =>
        audit.resolved_at !== null &&
        (audit.decision === 'approve' || audit.decision === 'skip') &&
        gateAuditMatchesEvidence(
          audit,
          evidence.stage_id,
          evidence.round_index,
          evidence.evidence_sha256
        )
    )
    if (
      evidence?.stage_id !== stage.stage_id ||
      evidence.candidate_commit_oid !== final.output_commit_oid ||
      evidence.round_index !== final.round_index ||
      (evidence.exit_code !== 0 && !approved) ||
      !isAuthoritativeStageEvidence(evidence.worker_identity)
    ) {
      throw new CandidatePublicationError(
        `satisfied stage ${stage.stage_id} does not bind successful authoritative evidence`
      )
    }
    const evidenceProblems = verifyRetainedArtifacts
      ? inputEvidenceProblems(ledger, runId, evidence)
      : []
    if (evidenceProblems.length > 0) {
      throw new CandidatePublicationError(
        `satisfied stage ${stage.stage_id} retained evidence is invalid: ${evidenceProblems.join('; ')}`
      )
    }
    candidate = final.output_commit_oid
    currentCandidate = final.output_commit_oid
  }

  for (const stage of plan.slice(0, pushIndex)) {
    const disposition = dispositions.get(stage.stage_id)
    if (disposition?.disposition !== 'satisfied' || !disposition.evidence_sha256) continue
    const evidence = evidenceByDigest.get(disposition.evidence_sha256)
    if (!evidence) continue
    const approved = gateAudits.some(
      (audit) =>
        audit.resolved_at !== null &&
        (audit.decision === 'approve' || audit.decision === 'skip') &&
        gateAuditMatchesEvidence(
          audit,
          evidence.stage_id,
          evidence.round_index,
          evidence.evidence_sha256
        )
    )
    if (approved && evidence.candidate_commit_oid !== candidate) {
      throw new CandidatePublicationError(
        `satisfied stage ${stage.stage_id} does not bind successful authoritative evidence`
      )
    }
  }

  if (!OID_PATTERN.test(candidate)) {
    throw new CandidatePublicationError(`invalid terminal candidate OID: ${candidate}`)
  }
  return candidate
}

function inputEvidenceProblems(
  ledger: DomainLedger,
  runId: string,
  evidence: NonNullable<ReturnType<DomainLedger['listEvidence']>[number]>
): string[] {
  if (evidence.artifact_sha256 === null) return ['artifact digest is missing']
  const stageEvidence = ledger.listEvidence(runId).flatMap((row) =>
    row.artifact_sha256 === null ? [] : [{
      artifactSha256: row.artifact_sha256,
      baseCommitOid: row.base_commit_oid,
      candidateCommitOid: row.candidate_commit_oid,
      evidenceSha256: row.evidence_sha256,
      exitCode: row.exit_code,
      round: row.round_index,
      stage: row.stage_id,
      summary: row.summary,
      workerIdentity: row.worker_identity
    }]
  )
  const prefix = `${evidence.stage_id} round ${evidence.round_index}:`
  return ledger.verifyEvidence({
    runId,
    stageEvidence
  }).filter((problem) => problem.startsWith(prefix))
}

function observationPayload(
  route: NonNullable<ReturnType<DomainLedger['publicationRoute']>>,
  oid: string | null
): Record<string, unknown> {
  const routeFacts = {
    forgeHost: route.forge_host,
    headBranch: route.head_branch,
    headOwner: route.head_owner,
    repositoryId: route.head_repository_id
  }
  return oid === null ? { ...routeFacts, state: 'absent' } : { ...routeFacts, oid }
}

export async function admitCandidatePublication(input: AdmissionInput): Promise<{
  headCommitOid: string | null
  routeFingerprint: string
}> {
  const run = input.ledger.run(input.runId)
  const route = input.ledger.publicationRoute(input.runId)
  if (!run || !route) throw new CandidatePublicationError(`run ${input.runId} has no publication route`)
  const storedRoute = input.ledger.repositoryPublicationRoute(run.repo_root)
  if (!storedRoute) {
    throw new CandidatePublicationError(
      `run ${input.runId} has no stored repository publication route to bind the transport`
    )
  }
  if (route.route_fingerprint !== storedRoute.route_fingerprint) {
    throw new CandidatePublicationError('publication route does not match the stored repository route')
  }
  const transportUrl = transportIdentity(input.destination, storedRoute.forge_host)
  if (transportUrl !== `${storedRoute.forge_host}/${storedRoute.head_repository_name}`) {
    throw new CandidatePublicationError('publication destination does not name the stored head repository')
  }
  await requireStoredRepositoryIdentity(
    input.resolveRepositoryIdentity,
    transportUrl.split('/').slice(1).join('/'),
    storedRoute
  )
  const ref = headRef(route.head_branch)
  const head = await readHead(
    input.runner ?? runCommand,
    input.destination,
    ref,
    run.repo_root,
    input.env ?? process.env
  )
  input.ledger.recordPublicationBaseline({
    runId: input.runId,
    routeFingerprint: route.route_fingerprint,
    transportUrl,
    headCommitOid: head.oid,
    observedAt: input.observedAt ?? new Date().toISOString()
  })
  return { headCommitOid: head.oid, routeFingerprint: route.route_fingerprint }
}

export async function publishCandidate(input: PublicationInput): Promise<{
  candidateCommitOid: string
  outcome: 'created' | 'updated' | 'unchanged'
  receiptSha256: string
}> {
  const runner = input.runner ?? runCommand
  const env = input.env ?? process.env
  const now = input.now ?? (() => new Date().toISOString())
  if (!isAuthoritativeStageEvidence(input.workerIdentity)) {
    throw new CandidatePublicationError('publication worker identity is not authoritative')
  }
  const route = input.ledger.publicationRoute(input.runId)
  const baseline = input.ledger.publicationBaseline(input.runId)
  const run = input.ledger.run(input.runId)
  if (!route || !baseline || !run) {
    throw new CandidatePublicationError(`run ${input.runId} has no admitted publication`)
  }
  const transportUrl = transportIdentity(input.destination, route.forge_host)
  if (baseline.route_fingerprint !== route.route_fingerprint || baseline.transport_url !== transportUrl) {
    throw new CandidatePublicationError('publication destination differs from the immutable admission route')
  }
  const storedRoute = input.ledger.repositoryPublicationRoute(run.repo_root)
  if (!storedRoute) {
    throw new CandidatePublicationError(
      `run ${input.runId} has no stored repository publication route to bind the transport`
    )
  }
  const repositoryReference = transportUrl.split('/').slice(1).join('/')
  await requireStoredRepositoryIdentity(
    input.resolveRepositoryIdentity,
    repositoryReference,
    storedRoute
  )
  if (!input.ledger.ownsLease(input.runId, {
    repoRoot: run.repo_root,
    branch: run.branch,
    generationToken: input.generationToken
  })) {
    throw new CandidatePublicationError('publication lease is no longer owned by this run generation')
  }

  const candidate = terminalCandidate(input.ledger, input.runId, false)
  const settled = input.ledger.listEvidence(input.runId).find(
    (row) => row.stage_id === 'push' && row.round_index === 0
  )
  if (settled) {
    terminalCandidate(input.ledger, input.runId)
    const receipt = input.ledger.remoteReceipt(input.runId, 'candidate-publication')
    let outcome: 'created' | 'updated' | 'unchanged' | undefined
    try {
      const parsed = JSON.parse(receipt?.receipt_json ?? '') as { outcome?: unknown }
      if (parsed.outcome === 'created' || parsed.outcome === 'updated' || parsed.outcome === 'unchanged') {
        outcome = parsed.outcome
      }
    } catch {}
    if (!receipt || outcome === undefined ||
        settled.candidate_commit_oid !== candidate ||
        receipt.candidate_commit_oid !== candidate ||
        settled.exit_code !== 0 ||
        !isAuthoritativeStageEvidence(settled.worker_identity)) {
      throw new CandidatePublicationError('push round 0 is already settled with different facts')
    }
    const settledProblems = inputEvidenceProblems(input.ledger, input.runId, settled)
    if (settledProblems.length > 0) {
      throw new CandidatePublicationError(
        `settled push round 0 retained evidence is invalid: ${settledProblems.join('; ')}`
      )
    }
    return { candidateCommitOid: candidate, outcome, receiptSha256: receipt.receipt_sha256 }
  }
  terminalCandidate(input.ledger, input.runId)
  const ref = headRef(route.head_branch)
  const subject = `${route.forge_host}/${route.head_repository_id}:${ref}`
  const pre = await readHead(runner, input.destination, ref, run.repo_root, env)
  const preObservedAt = now()
  const preRead = input.ledger.recordRemoteObservation({
    runId: input.runId,
    attemptId: input.attemptId,
    kind: 'publication-head',
    subject,
    payload: observationPayload(route, pre.oid),
    observedAt: preObservedAt
  })

  const baselineExpected = baseline.authoritative_absence === 1 ? null : baseline.head_commit_oid
  const reconciled = pre.oid === candidate && pre.oid !== baselineExpected && input.reconcileExactCandidate === true
  if (pre.oid !== baselineExpected && !reconciled) {
    throw new CandidatePublicationError('publication head changed after admission; no mutation attempted')
  }

  const outcome = reconciled || baselineExpected === candidate
    ? 'unchanged'
    : baselineExpected === null
      ? 'created'
      : 'updated'
  const mutationCreatedAt = after(preObservedAt, now())
  const mutation = input.ledger.recordMutationIntent({
    runId: input.runId,
    attemptId: input.attemptId,
    kind: 'candidate-publication',
    targetFingerprint: route.route_fingerprint,
    payload: {
      expected: baselineExpected ?? 'absent',
      update: candidate,
      ...(reconciled ? { reconciled: true } : {})
    },
    createdAt: mutationCreatedAt
  })

  let pushResult: CommandResult | null = null
  let pushError: unknown
  if (pre.oid !== candidate) {
    if (terminalCandidate(input.ledger, input.runId) !== candidate) {
      throw new CandidatePublicationError('terminal candidate changed before mutation')
    }
    if (!input.ledger.ownsLease(input.runId, {
      repoRoot: run.repo_root,
      branch: run.branch,
      generationToken: input.generationToken
    })) {
      throw new CandidatePublicationError('publication lease was lost before mutation')
    }
    await requireStoredRepositoryIdentity(
      input.resolveRepositoryIdentity,
      repositoryReference,
      storedRoute
    )
    await rejectUrlRewrite(runner, input.destination, run.repo_root, env)
    try {
      pushResult = await runner('git', [
        'push',
        '--porcelain',
        `--force-with-lease=${ref}:${baselineExpected ?? ''}`,
        input.destination,
        `${candidate}:${ref}`
      ], { cwd: run.repo_root, env })
    } catch (error) {
      pushError = error
    }
  }

  let post: HeadState
  try {
    post = await readHead(runner, input.destination, ref, run.repo_root, env)
  } catch (error) {
    throw new CandidatePublicationError(
      `publication result is uncertain because the authoritative post-read failed: ${String(error)}`
    )
  }
  try {
    await requireStoredRepositoryIdentity(
      input.resolveRepositoryIdentity,
      repositoryReference,
      storedRoute
    )
  } catch (error) {
    throw new CandidatePublicationError(
      `publication result is uncertain because the destination repository identity could not be re-verified: ${String(error)}`
    )
  }
  const postObservedAt = after(mutationCreatedAt, now())
  const postRead = input.ledger.recordRemoteObservation({
    runId: input.runId,
    attemptId: input.attemptId,
    kind: 'publication-head',
    subject,
    payload: observationPayload(route, post.oid),
    observedAt: postObservedAt
  })
  if (post.oid !== candidate) {
    const transportFailure = pushError
      ? `; push threw ${String(pushError)}`
      : pushResult && pushResult.code !== 0
        ? `; push exited ${pushResult.code}`
        : ''
    throw new CandidatePublicationError(
      `publication post-read did not prove the exact candidate${transportFailure}`
    )
  }
  const artifactBytes = `${canonicalJson({
    candidateCommitOid: candidate,
    findings: [],
    mutationIntent: mutation,
    outcome,
    postRead,
    preRead,
    pushExitCode: pushResult?.code ?? null
  })}\n`
  await mkdir(dirname(input.artifactPath), { recursive: true })
  await writeFile(input.artifactPath, artifactBytes)
  const artifactSha256 = sha256(artifactBytes)
  const summary = `Published exact candidate ${candidate} to ${ref} (${outcome})`
  const evidenceDigest = evidenceSha256({
    artifactSha256,
    baseCommitOid: candidate,
    candidateCommitOid: candidate,
    exitCode: 0,
    round: 0,
    runId: input.runId,
    stage: 'push',
    summary,
    workerIdentity: input.workerIdentity
  })
  const settlement = input.ledger.settleRemoteStage({
    runId: input.runId,
    stageId: 'push',
    ownership: {
      repoRoot: run.repo_root,
      branch: run.branch,
      generationToken: input.generationToken
    },
    checkpoint: {
      inputCommitOid: candidate,
      outputCommitOid: candidate,
      roundIndex: 0
    },
    evidence: {
      runId: input.runId,
      stageId: 'push',
      roundIndex: 0,
      candidateCommitOid: candidate,
      baseCommitOid: candidate,
      workerIdentity: input.workerIdentity,
      exitCode: 0,
      evidenceSha256: evidenceDigest,
      findingsJson: '[]',
      artifactPath: input.artifactPath,
      artifactSha256,
      summary
    },
    receipt: {
      authoritativePostObservationSha256: postRead,
      candidateCommitOid: candidate,
      kind: 'candidate-publication',
      payload: {
        mutationIntent: mutation,
        outcome,
        postRead,
        preRead,
        routeFingerprint: route.route_fingerprint
      }
    }
  })
  return { candidateCommitOid: candidate, outcome, receiptSha256: settlement.receiptSha256 }
}
