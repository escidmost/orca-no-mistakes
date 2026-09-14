import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { PIPELINE_STEPS, CommandGatesSchema, commandGateStage, withCommandGates, type CoreStageName, type CommandGate, type GuardrailMode } from './config.ts'
import type { PresentationSnapshot } from './presentation.ts'

const { O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_RDWR, O_WRONLY } = constants

export type RunStatus = 'in-progress' | 'passed' | 'failed' | 'cancelled'

export class DestinationActiveMigrationError extends Error {}

export class LegacyActiveMigrationError extends Error {}

export class RepositoryMigrationConflictError extends Error {}

export type RepositoryPublicationRouteInput = {
  actorId: string
  actorLogin: string
  actorNodeId: string
  backend: 'gh' | 'gh-axi'
  backendVersion: string
  baseBranch: string
  baseRepositoryId: string
  baseRepositoryName: string
  baseRepositoryNodeId: string
  credentialSource: 'GH_TOKEN' | 'GITHUB_TOKEN' | 'stored-account'
  forgeHost: 'github.com'
  headBranch: string
  headOwner: string
  headRepositoryId: string
  headRepositoryName: string
  headRepositoryNodeId: string
  networkRootRepositoryId: string
  observedAt: string
  repoRoot: string
}

export type RepositoryPublicationRouteRow = {
  actor_id: string
  actor_login: string
  actor_node_id: string | null
  backend: 'gh' | 'gh-axi'
  backend_version: string
  base_branch: string
  base_repository_id: string
  base_repository_name: string
  base_repository_node_id: string
  credential_source: 'GH_TOKEN' | 'GITHUB_TOKEN' | 'stored-account'
  forge_host: 'github.com'
  head_branch: string
  head_owner: string
  head_repository_id: string
  head_repository_name: string
  head_repository_node_id: string
  network_root_repository_id: string
  observed_at: string
  repo_root: string
  route_fingerprint: string
  updated_at: string
}

export type StageRequirement = 'disabled' | 'optional' | 'required'

export type StagePlanEntryRow = {
  position: number
  requirement: StageRequirement
  stage_id: string
}

export type StageDisposition = 'disabled' | 'failed' | 'satisfied' | 'skipped' | 'waived'

export type StageDispositionRow = {
  disposition: StageDisposition
  evidence_sha256: string | null
  stage_id: string
}

export type RemoteReceiptKind = 'candidate-publication' | 'pull-request-binding'

export type RemoteReceiptRow = {
  authoritative_post_observation_sha256: string
  candidate_commit_oid: string
  created_at: string
  kind: RemoteReceiptKind
  receipt_json: string
  receipt_sha256: string
}

export type RecordEvidenceInput = {
  artifactPath: string
  artifactSha256: string
  baseCommitOid: string
  candidateCommitOid: string
  evidenceSha256: string
  exitCode: number
  findingsJson?: string
  roundIndex: number
  runId: string
  stageId: string
  summary: string
  workerIdentity: string
  effectivePolicyHash?: string
  baseRefSha?: string
}

export const LEGACY_STAGE_PLAN = [
  'intent',
  'rebase',
  'review',
  'test',
  'document',
  'lint'
] as const

export const RELEASE_2_STAGE_PLAN = PIPELINE_STEPS

export type GateKind = 'exhaustion' | 'finding' | 'guardrail'

export type GateAuditRow = {
  decision: string
  evidence_sha256: string | null
  gate_id: string
  gate_kind: GateKind
  guidance: string | null
  options_json?: string
  question: string
  resolution: string
  resolved_at: string | null
  round_index: number
  selected_finding_ids: string | null
  stage_id: string
}

export type AutoFixModeEvent = {
  changedAt: string
  enabled: boolean
  source: 'initial' | 'operator'
}

export function gateAuditMatchesEvidence(
  audit: GateAuditRow,
  stage: string,
  round: number,
  evidenceSha256: string
): boolean {
  return (
    audit.stage_id === stage &&
    audit.round_index === round &&
    audit.evidence_sha256 === evidenceSha256
  )
}

export type FindingDecisionRow = {
  decision: string
  findings_json: string
  round_index: number
  run_id: string
  selected_finding_ids: string
  stage_id: string
}

export type StageEvidenceRow = {
  artifact_path: string
  artifact_sha256: string | null
  base_commit_oid: string
  base_ref_sha: string | null
  candidate_commit_oid: string
  effective_policy_hash: string | null
  evidence_id: string
  evidence_sha256: string
  exit_code: number
  findings_json: string | null
  round_index: number
  run_id: string
  stage_id: string
  summary: string
  worker_identity: string
}

export type RunRecord = {
  base_branch: string
  branch: string
  intent: string
  policy_sha256: string
  repo_root: string
  run_id: string
  status: RunStatus
  submission_commit_oid: string
}

export type SubmissionAdmissionStatus =
  | 'accepted'
  | 'failed'
  | 'launched'
  | 'pending'
  | 'superseded'

export type SubmissionAdmissionInput = {
  admissionId: string
  gateIdentity: string
  intent: string
  newOid: string
  oldOid: string
  refName: string
  repoRoot: string
  source: 'direct' | 'gate'
}

export type SubmissionAdmissionRow = {
  accepted_at: string | null
  accepted_oid: string | null
  admission_id: string
  created_at: string
  gate_identity: string
  intent: string
  intent_hash: string
  launched_at: string | null
  launcher_pid: number | null
  lease_token: string
  new_oid: string
  old_oid: string
  ref_name: string
  repo_root: string
  run_id: string | null
  source: 'direct' | 'gate'
  status: SubmissionAdmissionStatus
}

export type StageCheckpointRow = {
  input_commit_oid: string
  output_commit_oid: string
  round_index: number
  stage_id: string
}

export function isCandidateReachable(
  fromCommitOid: string,
  toCommitOid: string,
  checkpoints: readonly StageCheckpointRow[]
): boolean {
  if (fromCommitOid === toCommitOid) return true
  const reachable = new Set<string>([fromCommitOid])
  for (const cp of checkpoints) {
    if (reachable.has(cp.input_commit_oid)) {
      reachable.add(cp.output_commit_oid)
      if (cp.output_commit_oid === toCommitOid) return true
    }
  }
  return false
}

export function finalContiguousCheckpointByStage(
  stageIds: readonly string[],
  checkpoints: readonly StageCheckpointRow[],
  initialCandidate: string,
  evidenceByStage?:
    | ReadonlyMap<string, { candidate_commit_oid?: string; candidateCommitOid?: string; round_index?: number; roundIndex?: number }>
    | readonly { stage_id?: string; stage?: string; candidate_commit_oid?: string; candidateCommitOid?: string; round_index?: number; roundIndex?: number }[]
): Map<string, StageCheckpointRow> {
  const result = new Map<string, StageCheckpointRow>()
  const stagePosition = new Map(stageIds.map((stageId, index) => [stageId, index]))

  const expectedByStage = new Map<string, { candidateCommitOid: string; roundIndex: number }>()
  if (evidenceByStage) {
    if (evidenceByStage instanceof Map || (typeof (evidenceByStage as any).get === 'function' && typeof (evidenceByStage as any).entries === 'function')) {
      for (const [key, val] of (evidenceByStage as Map<string, any>).entries()) {
        if (!val) continue
        const candidateCommitOid = val.candidate_commit_oid ?? val.candidateCommitOid
        const roundIndex = val.round_index ?? val.roundIndex
        if (candidateCommitOid !== undefined && roundIndex !== undefined) {
          expectedByStage.set(key, { candidateCommitOid, roundIndex })
        }
      }
    } else if (Array.isArray(evidenceByStage)) {
      for (const item of evidenceByStage) {
        if (!item) continue
        const stageId = item.stage_id ?? item.stage
        const candidateCommitOid = item.candidate_commit_oid ?? item.candidateCommitOid
        const roundIndex = item.round_index ?? item.roundIndex
        if (stageId && candidateCommitOid !== undefined && roundIndex !== undefined) {
          expectedByStage.set(stageId, { candidateCommitOid, roundIndex })
        }
      }
    }
  }

  const reachable = new Set<string>([initialCandidate])
  const validCheckpoints: StageCheckpointRow[] = []
  const brokenStages = new Set<string>()

  for (const checkpoint of checkpoints) {
    if (!stagePosition.has(checkpoint.stage_id)) continue

    if (reachable.has(checkpoint.input_commit_oid)) {
      reachable.add(checkpoint.output_commit_oid)
      validCheckpoints.push(checkpoint)
    } else {
      brokenStages.add(checkpoint.stage_id)
    }
  }

  let currentCandidate = initialCandidate
  let lastCheckpointIndex = -1
  for (const stageId of stageIds) {
    if (brokenStages.has(stageId)) break

    const expected = expectedByStage.get(stageId)
    let match: StageCheckpointRow | undefined
    let matchIndex = -1
    for (let i = validCheckpoints.length - 1; i >= 0; i--) {
      const cp = validCheckpoints[i]
      if (cp.stage_id !== stageId) continue
      if (i <= lastCheckpointIndex) continue
      if (
        expected &&
        (cp.round_index !== expected.roundIndex ||
          cp.output_commit_oid !== expected.candidateCommitOid)
      ) {
        continue
      }
      const connecting = validCheckpoints.slice(lastCheckpointIndex + 1, i)
      if (!isCandidateReachable(currentCandidate, cp.input_commit_oid, connecting)) {
        continue
      }
      match = cp
      matchIndex = i
      break
    }

    if (match) {
      currentCandidate = match.output_commit_oid
      lastCheckpointIndex = matchIndex
      result.set(stageId, match)
    } else if (expected || validCheckpoints.some((cp) => cp.stage_id === stageId)) {
      break
    }
  }

  return result
}


export type GateDecisionRecord = {
  decision: 'approve' | 'skip'
  gateId: string
  resolvedAt: string
}

export type StageEvidenceManifestEntry = {
  stage: string
  round: number
  candidateCommitOid: string
  baseCommitOid: string
  workerIdentity: string
  exitCode: number
  artifactSha256: string
  evidenceSha256: string
  summary: string
  waiverOrApproval?: GateDecisionRecord
}

const NON_AUTHORITATIVE_STAGE_EVIDENCE_IDENTITIES = new Set([
  'coordinator:fixer-guardrail-advisory',
  'coordinator:fixer-no-change',
  'coordinator:fixer-policy'
])

export function isAuthoritativeStageEvidence(workerIdentity: string): boolean {
  return !NON_AUTHORITATIVE_STAGE_EVIDENCE_IDENTITIES.has(workerIdentity)
}

export type PassedAttestationManifest = {
  version: '1.3.0'
  runId: string
  candidateCommitOid: string
  baseCommitOid: string
  policySha256: string
  guardrailMode: GuardrailMode
  intent: string
  intentHash: string
  stageEvidence: StageEvidenceManifestEntry[]
  merkleRoot: string
  coordinatorVersion: string
  createdAt: string
}

export type AssuranceClaim =
  | 'configured-pipeline-completed'
  | 'candidate-publication-verified'
  | 'pull-request-bound'

export type PipelineCompletionAttestationManifest = {
  version: '2.0.0'
  runId: string
  candidateCommitOid: string
  baseCommitOid: string
  policySha256: string
  intent: string
  intentHash: string
  stagePlan: { requirement: StageRequirement; stage: string }[]
  stageDispositions: {
    disposition: StageDisposition
    evidenceSha256?: string
    stage: string
  }[]
  stageEvidence: StageEvidenceManifestEntry[]
  publicationRoute: {
    baseBranch: string
    baseRepositoryId: string
    forgeHost: string
    headBranch: string
    headOwner: string
    headRepositoryId: string
    routeFingerprint: string
  }
  attemptOutcomeDigests: string[]
  candidatePublicationReceiptSha256: string
  pullRequestBindingReceiptSha256: string
  custody: Record<string, unknown>
  assuranceClaims: AssuranceClaim[]
  pipelineEvidenceRoot: string
  merkleRoot: string
  coordinatorVersion: string
  createdAt: string
}

export type CompletionAttestationManifest =
  | PassedAttestationManifest
  | PipelineCompletionAttestationManifest

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, normalize(child)])
      )
    }
    return item
  }
  return JSON.stringify(normalize(value))
}

export function intentHash(intent: string): string {
  return sha256(intent)
}

export function normalizeIntent(value: unknown): string {
  const intent = typeof value === 'string' ? value.trim() : ''
  if (!intent) throw new Error('--intent is required')
  if (
    intent.includes('<untrusted_instruction>') ||
    intent.includes('</untrusted_instruction>')
  ) {
    throw new Error('--intent must not contain untrusted_instruction delimiters')
  }
  if (intent.includes('\n') || intent.includes('\0')) {
    throw new Error('--intent must be a single line')
  }
  return intent
}

const HEX_64 = /^[0-9a-f]{64}$/
export const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const MANIFEST_PROPERTIES = new Set([
  'baseCommitOid',
  'candidateCommitOid',
  'coordinatorVersion',
  'createdAt',
  'guardrailMode',
  'intent',
  'intentHash',
  'merkleRoot',
  'policySha256',
  'runId',
  'stageEvidence',
  'version'
])
const V2_MANIFEST_PROPERTIES = new Set([
  'assuranceClaims',
  'attemptOutcomeDigests',
  'baseCommitOid',
  'candidateCommitOid',
  'candidatePublicationReceiptSha256',
  'coordinatorVersion',
  'createdAt',
  'custody',
  'intent',
  'intentHash',
  'merkleRoot',
  'pipelineEvidenceRoot',
  'policySha256',
  'publicationRoute',
  'pullRequestBindingReceiptSha256',
  'runId',
  'stageDispositions',
  'stageEvidence',
  'stagePlan',
  'version'
])
const STAGE_EVIDENCE_PROPERTIES = new Set([
  'artifactSha256',
  'baseCommitOid',
  'candidateCommitOid',
  'evidenceSha256',
  'exitCode',
  'round',
  'stage',
  'summary',
  'waiverOrApproval',
  'workerIdentity'
])
const PUBLICATION_ROUTE_PROPERTIES = new Set([
  'baseBranch',
  'baseRepositoryId',
  'forgeHost',
  'headBranch',
  'headOwner',
  'headRepositoryId',
  'routeFingerprint'
])
const WAIVER_PROPERTIES = new Set(['decision', 'gateId', 'resolvedAt'])

function hasOnlyOwnProperties(value: object, allowed: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every(
    (property) => typeof property === 'string' && allowed.has(property)
  )
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

/**
 * Binds an evidence digest to the exact execution that produced it:
 * (run_id, stage_id, round_index, candidate_commit_oid, base_commit_oid,
 * worker_identity) plus the exit code, summary and artifact digest. The run ID
 * is part of the tuple so an entry cannot be lifted out of one run's ledger and
 * replayed as another run's evidence.
 */
export function evidenceSha256(input: {
  artifactSha256: string
  baseCommitOid: string
  candidateCommitOid: string
  exitCode: number
  round: number
  runId: string
  stage: string
  summary: string
  workerIdentity: string
}): string {
  return sha256(
    JSON.stringify({
      artifactSha256: input.artifactSha256,
      baseCommitOid: input.baseCommitOid,
      candidateCommitOid: input.candidateCommitOid,
      exitCode: input.exitCode,
      round: input.round,
      runId: input.runId,
      stage: input.stage,
      summary: input.summary,
      workerIdentity: input.workerIdentity
    })
  )
}

export function canonicalEntry(entry: StageEvidenceManifestEntry): string {
  return JSON.stringify({
    artifactSha256: entry.artifactSha256,
    baseCommitOid: entry.baseCommitOid,
    candidateCommitOid: entry.candidateCommitOid,
    evidenceSha256: entry.evidenceSha256,
    exitCode: entry.exitCode,
    round: entry.round,
    stage: entry.stage,
    summary: entry.summary,
    ...(entry.waiverOrApproval ? { waiverOrApproval: entry.waiverOrApproval } : {}),
    workerIdentity: entry.workerIdentity
  })
}

/**
 * Serializes manifest header fields in a stable order for hashing.
 *
 * @param manifest - The attestation manifest whose header fields are serialized
 * @returns A canonical JSON representation of the manifest header
 */
export function canonicalHeader(manifest: PassedAttestationManifest): string {
  return JSON.stringify({
    baseCommitOid: manifest.baseCommitOid,
    candidateCommitOid: manifest.candidateCommitOid,
    coordinatorVersion: manifest.coordinatorVersion,
    createdAt: manifest.createdAt,
    guardrailMode: manifest.guardrailMode,
    intentHash: manifest.intentHash,
    policySha256: manifest.policySha256,
    runId: manifest.runId,
    version: manifest.version
  })
}

export function manifestLeaves(manifest: PassedAttestationManifest): string[] {
  return [
    sha256(canonicalHeader(manifest)),
    ...manifest.stageEvidence.map((entry) => sha256(canonicalEntry(entry)))
  ]
}

export function merkleRoot(hashes: string[]): string {
  let level = [...hashes]
  if (level.length === 0) level = [sha256('')]
  while (level.length > 1) {
    const next: string[] = []
    for (let index = 0; index < level.length; index += 2) {
      next.push(level[index + 1] ? sha256(level[index] + level[index + 1]) : level[index])
    }
    level = next
  }
  return level[0]
}

const COORDINATOR_VERSION: string = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string
    }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * Builds and validates a version 1.3.0 attestation manifest.
 *
 * @param entries - Stage evidence entries to include in the manifest
 * @param meta - Run metadata, commit identifiers, intent, policy digest, and guardrail mode
 * @returns The completed attestation manifest with its intent hash and Merkle root
 */
export function buildAttestation(
  entries: StageEvidenceManifestEntry[],
  meta: {
    baseCommitOid: string
    candidateCommitOid: string
    guardrailMode: GuardrailMode
    intent: string
    policySha256: string
    runId: string
  }
): PassedAttestationManifest {
  const manifest: PassedAttestationManifest = {
    version: '1.3.0',
    runId: meta.runId,
    candidateCommitOid: meta.candidateCommitOid,
    baseCommitOid: meta.baseCommitOid,
    policySha256: meta.policySha256,
    guardrailMode: meta.guardrailMode,
    intent: meta.intent,
    intentHash: intentHash(meta.intent),
    stageEvidence: entries,
    merkleRoot: '',
    coordinatorVersion: COORDINATOR_VERSION,
    createdAt: new Date().toISOString()
  }
  manifest.merkleRoot = merkleRoot(manifestLeaves(manifest))
  verifyManifest(manifest)
  return manifest
}

const V2_ASSURANCE_CLAIMS: AssuranceClaim[] = [
  'configured-pipeline-completed',
  'candidate-publication-verified',
  'pull-request-bound'
]

function pipelineEvidencePayload(
  entries: StageEvidenceManifestEntry[],
  meta: Pick<
    PipelineCompletionAttestationManifest,
    | 'attemptOutcomeDigests'
    | 'baseCommitOid'
    | 'candidateCommitOid'
    | 'candidatePublicationReceiptSha256'
    | 'intentHash'
    | 'policySha256'
    | 'publicationRoute'
    | 'runId'
    | 'stageDispositions'
    | 'stagePlan'
  >
): unknown {
  const pushIndex = meta.stagePlan.findIndex((entry) => entry.stage === 'push')
  if (pushIndex < 0) throw new Error('pipeline evidence requires a push stage')
  const prePrStages = new Set(meta.stagePlan.slice(0, pushIndex + 1).map((entry) => entry.stage))
  return {
    attemptOutcomeDigests: meta.attemptOutcomeDigests,
    baseCommitOid: meta.baseCommitOid,
    candidateCommitOid: meta.candidateCommitOid,
    candidatePublicationReceiptSha256: meta.candidatePublicationReceiptSha256,
    intentHash: meta.intentHash,
    policySha256: meta.policySha256,
    publicationRoute: meta.publicationRoute,
    runId: meta.runId,
    stageDispositions: meta.stageDispositions.filter((entry) => prePrStages.has(entry.stage)),
    stageEvidence: entries.filter((entry) => prePrStages.has(entry.stage)),
    stagePlan: meta.stagePlan.slice(0, pushIndex + 1)
  }
}

export function buildPipelineEvidenceRoot(
  entries: StageEvidenceManifestEntry[],
  meta: Pick<
    PipelineCompletionAttestationManifest,
    | 'attemptOutcomeDigests'
    | 'baseCommitOid'
    | 'candidateCommitOid'
    | 'candidatePublicationReceiptSha256'
    | 'intent'
    | 'policySha256'
    | 'publicationRoute'
    | 'runId'
    | 'stageDispositions'
    | 'stagePlan'
  >
): string {
  return merkleRoot([sha256(canonicalJson(pipelineEvidencePayload(entries, {
    ...meta,
    intentHash: intentHash(meta.intent)
  })))])
}

function v2MerkleRoot(manifest: PipelineCompletionAttestationManifest): string {
  const { merkleRoot: _merkleRoot, ...payload } = manifest
  return merkleRoot([sha256(canonicalJson(payload))])
}

export function buildPipelineCompletionAttestation(
  entries: StageEvidenceManifestEntry[],
  meta: Omit<
    PipelineCompletionAttestationManifest,
    | 'assuranceClaims'
    | 'coordinatorVersion'
    | 'createdAt'
    | 'intentHash'
    | 'merkleRoot'
    | 'pipelineEvidenceRoot'
    | 'stageEvidence'
    | 'version'
  >
): PipelineCompletionAttestationManifest {
  const manifest: PipelineCompletionAttestationManifest = {
    version: '2.0.0',
    ...meta,
    intentHash: intentHash(meta.intent),
    stageEvidence: entries,
    assuranceClaims: [...V2_ASSURANCE_CLAIMS],
    pipelineEvidenceRoot: '',
    merkleRoot: '',
    coordinatorVersion: COORDINATOR_VERSION,
    createdAt: new Date().toISOString()
  }
  manifest.pipelineEvidenceRoot = buildPipelineEvidenceRoot(entries, {
    ...manifest,
    attemptOutcomeDigests: manifest.attemptOutcomeDigests.slice(0, -1)
  })
  manifest.merkleRoot = v2MerkleRoot(manifest)
  verifyCompletionAttestation(manifest)
  return manifest
}

export function assuranceClaimsFor(manifest: CompletionAttestationManifest): string[] {
  if (manifest.version === '1.3.0') {
    verifyManifest(manifest, LEGACY_STAGE_PLAN)
    return ['legacy-local-pipeline-passed']
  }
  verifyCompletionAttestation(manifest)
  return [...manifest.assuranceClaims]
}

export function verifyCompletionAttestation(manifest: CompletionAttestationManifest): void {
  if (manifest?.version === '1.3.0') {
    verifyManifest(manifest)
    return
  }
  if (!manifest || manifest.version !== '2.0.0') {
    throw new Error('attestation version is not supported')
  }
  if (!hasOnlyOwnProperties(manifest, V2_MANIFEST_PROPERTIES)) {
    throw new Error('attestation manifest has unknown properties')
  }
  if (typeof manifest.runId !== 'string' || !RUN_ID_PATTERN.test(manifest.runId)) {
    throw new Error('attestation run ID is invalid')
  }
  if (
    typeof manifest.coordinatorVersion !== 'string' ||
    manifest.coordinatorVersion.trim() === '' ||
    !isCanonicalTimestamp(manifest.createdAt)
  ) {
    throw new Error('attestation metadata is invalid')
  }
  if (
    !COMMIT_OID.test(manifest.candidateCommitOid) ||
    !COMMIT_OID.test(manifest.baseCommitOid)
  ) {
    throw new Error('attestation commit OIDs are not 40- or 64-character hex values')
  }
  if (!HEX_64.test(manifest.policySha256)) {
    throw new Error('attestation policy hash is not a SHA-256')
  }
  if (
    normalizeIntent(manifest.intent) !== manifest.intent ||
    manifest.intentHash !== intentHash(manifest.intent)
  ) {
    throw new Error('attestation intent is invalid')
  }

  const legacyEvidenceView: PassedAttestationManifest = {
    baseCommitOid: manifest.baseCommitOid,
    candidateCommitOid: manifest.candidateCommitOid,
    coordinatorVersion: manifest.coordinatorVersion,
    createdAt: manifest.createdAt,
    guardrailMode: 'strict',
    intent: manifest.intent,
    intentHash: manifest.intentHash,
    merkleRoot: '',
    policySha256: manifest.policySha256,
    runId: manifest.runId,
    stageEvidence: manifest.stageEvidence,
    version: '1.3.0'
  }
  legacyEvidenceView.merkleRoot = merkleRoot(manifestLeaves(legacyEvidenceView))
  verifyManifest(legacyEvidenceView)

  if (!Array.isArray(manifest.stagePlan) || manifest.stagePlan.length === 0) {
    throw new Error('attestation stage plan is invalid')
  }
  const planStages = new Set<string>()
  for (const entry of manifest.stagePlan) {
    if (
      !entry ||
      !hasOnlyOwnProperties(entry, new Set(['requirement', 'stage'])) ||
      typeof entry.stage !== 'string' ||
      entry.stage.trim() === '' ||
      !['required', 'optional', 'disabled'].includes(entry.requirement) ||
      planStages.has(entry.stage)
    ) {
      throw new Error('attestation stage plan is invalid')
    }
    planStages.add(entry.stage)
  }
  const pushIndex = manifest.stagePlan.findIndex((entry) => entry.stage === 'push')
  const tail = manifest.stagePlan.slice(pushIndex).map((entry) => entry.stage).join(',')
  if (pushIndex < 0 || !['push,pr', 'push,pr,ci'].includes(tail)) {
    throw new Error('attestation stage plan must end with push then pr, optionally followed by ci')
  }
  if (
    !Array.isArray(manifest.stageDispositions) ||
    manifest.stageDispositions.length !== manifest.stagePlan.length
  ) {
    throw new Error('attestation stage dispositions do not match the stage plan')
  }
  const evidenceByDigest = new Map(
    manifest.stageEvidence.map((entry) => [entry.evidenceSha256, entry])
  )
  if (evidenceByDigest.size !== manifest.stageEvidence.length) {
    throw new Error('attestation stage evidence contains duplicate entries')
  }
  for (const [index, disposition] of manifest.stageDispositions.entries()) {
    const plan = manifest.stagePlan[index]
    if (
      !disposition ||
      !hasOnlyOwnProperties(disposition, new Set(['disposition', 'evidenceSha256', 'stage'])) ||
      disposition.stage !== plan.stage ||
      !['satisfied', 'failed', 'skipped', 'waived', 'disabled'].includes(
        disposition.disposition
      )
    ) {
      throw new Error('attestation stage dispositions do not match the stage plan')
    }
    if (plan.stage.startsWith('command-') && plan.requirement !== 'required') {
      throw new Error(`attestation command stage ${plan.stage} must be required`)
    }
    const completed =
      (plan.requirement === 'required' && disposition.disposition === 'satisfied') ||
      (plan.requirement === 'optional' &&
        ['satisfied', 'skipped', 'waived'].includes(disposition.disposition)) ||
      (plan.requirement === 'disabled' && disposition.disposition === 'disabled')
    if (!completed) {
      throw new Error(`attestation stage ${plan.stage} is not conclusively disposed`)
    }
    const evidence = evidenceByDigest.get(disposition.evidenceSha256 ?? '')
    if (
      disposition.disposition === 'satisfied' &&
      (evidence?.stage !== plan.stage ||
        (evidence.exitCode !== 0 && (plan.stage.startsWith('command-') || evidence.waiverOrApproval === undefined)) ||
        !isAuthoritativeStageEvidence(evidence.workerIdentity))
    ) {
      throw new Error(
        `attestation stage ${plan.stage} disposition does not bind successful authoritative evidence`
      )
    }
    if (disposition.disposition !== 'satisfied' && disposition.evidenceSha256 !== undefined) {
      throw new Error(`attestation stage ${plan.stage} has unexpected evidence`)
    }
  }
  if (manifest.stageEvidence.some((entry) => !planStages.has(entry.stage))) {
    throw new Error('attestation stage evidence is outside the frozen plan')
  }

  const route = manifest.publicationRoute
  if (
    !route ||
    Reflect.ownKeys(route).length !== PUBLICATION_ROUTE_PROPERTIES.size ||
    !hasOnlyOwnProperties(route, PUBLICATION_ROUTE_PROPERTIES) ||
    Object.entries(route).some(([key, value]) => key !== 'routeFingerprint' &&
      (typeof value !== 'string' || value.trim() === ''))
  ) {
    throw new Error('attestation publication route is invalid')
  }
  const { routeFingerprint, ...routeIdentity } = route
  if (!HEX_64.test(routeFingerprint) || sha256(canonicalJson(routeIdentity)) !== routeFingerprint) {
    throw new Error('attestation publication route fingerprint is invalid')
  }
  if (
    !Array.isArray(manifest.attemptOutcomeDigests) ||
    manifest.attemptOutcomeDigests.length === 0 ||
    manifest.attemptOutcomeDigests.some((digest) => !HEX_64.test(digest)) ||
    !HEX_64.test(manifest.candidatePublicationReceiptSha256) ||
    !HEX_64.test(manifest.pullRequestBindingReceiptSha256)
  ) {
    throw new Error('attestation attempt or remote receipt digest is invalid')
  }
  if (
    !manifest.custody ||
    typeof manifest.custody !== 'object' ||
    Array.isArray(manifest.custody) ||
    Object.keys(manifest.custody).length === 0
  ) {
    throw new Error('attestation custody facts are invalid')
  }
  if (
    !Array.isArray(manifest.assuranceClaims) ||
    canonicalJson(manifest.assuranceClaims) !== canonicalJson(V2_ASSURANCE_CLAIMS)
  ) {
    throw new Error('attestation assurance claims are invalid')
  }
  const expectedPipelineRoot = merkleRoot([
    sha256(canonicalJson(pipelineEvidencePayload(
      manifest.stageEvidence,
      { ...manifest, attemptOutcomeDigests: manifest.attemptOutcomeDigests.slice(0, -1) }
    )))
  ])
  if (manifest.pipelineEvidenceRoot !== expectedPipelineRoot) {
    throw new Error('attestation pipeline evidence root is invalid')
  }
  if (manifest.merkleRoot !== v2MerkleRoot(manifest)) {
    throw new Error('attestation Merkle root does not match its completion evidence')
  }
}

/**
 * Validates an attestation manifest and its stage evidence.
 *
 * @param manifest - The attestation manifest to validate
 * @param requiredStages - Stage names that must have corresponding evidence
 */
export function verifyManifest(
  manifest: PassedAttestationManifest,
  requiredStages: readonly string[] = []
): void {
  // Bumped whenever the digest preimages change: 1.0.0 predates the run ID in
  // the evidence preimage, 1.1.0 predates the header leaf in the Merkle tree,
  // and 1.2.0 predates the guardrail mode in the header, so all of them
  // compute over a different tuple and have to be rejected as unsupported
  // versions rather than misreported as tampering.
  if (!manifest || manifest.version !== '1.3.0') {
    throw new Error('attestation version is not 1.3.0')
  }
  if (!hasOnlyOwnProperties(manifest, MANIFEST_PROPERTIES)) {
    throw new Error('attestation manifest has unknown properties')
  }
  if (manifest.guardrailMode !== 'strict' && manifest.guardrailMode !== 'advisory') {
    throw new Error('attestation guardrail mode is invalid')
  }
  if (typeof manifest.runId !== 'string' || !RUN_ID_PATTERN.test(manifest.runId)) {
    throw new Error('attestation run ID is invalid')
  }
  if (
    typeof manifest.coordinatorVersion !== 'string' ||
    manifest.coordinatorVersion.trim() === ''
  ) {
    throw new Error('attestation coordinator version is invalid')
  }
  if (!isCanonicalTimestamp(manifest.createdAt)) {
    throw new Error('attestation creation timestamp is invalid')
  }
  if (
    typeof manifest.candidateCommitOid !== 'string' ||
    typeof manifest.baseCommitOid !== 'string' ||
    !COMMIT_OID.test(manifest.candidateCommitOid) ||
    !COMMIT_OID.test(manifest.baseCommitOid)
  ) {
    throw new Error('attestation commit OIDs are not 40- or 64-character hex values')
  }
  if (typeof manifest.policySha256 !== 'string' || !HEX_64.test(manifest.policySha256)) {
    throw new Error('attestation policy hash is not a SHA-256')
  }
  let normalizedIntent: string
  try {
    normalizedIntent = normalizeIntent(manifest.intent)
  } catch {
    throw new Error('attestation intent is invalid')
  }
  if (normalizedIntent !== manifest.intent) {
    throw new Error('attestation intent is invalid')
  }
  if (
    typeof manifest.intentHash !== 'string' ||
    !HEX_64.test(manifest.intentHash) ||
    manifest.intentHash !== intentHash(manifest.intent)
  ) {
    throw new Error('attestation intent hash does not match the recorded intent')
  }
  if (!Array.isArray(manifest.stageEvidence)) {
    throw new Error('attestation stage evidence is not an array')
  }
  const presentStages = new Set<string>()
  for (const [index, entry] of manifest.stageEvidence.entries()) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.stage !== 'string' ||
      entry.stage.trim() === '' ||
      !Number.isInteger(entry.round) ||
      entry.round < 0 ||
      typeof entry.candidateCommitOid !== 'string' ||
      typeof entry.baseCommitOid !== 'string' ||
      !COMMIT_OID.test(entry.candidateCommitOid) ||
      !COMMIT_OID.test(entry.baseCommitOid) ||
      typeof entry.workerIdentity !== 'string' ||
      entry.workerIdentity.trim() === '' ||
      !Number.isInteger(entry.exitCode) ||
      typeof entry.artifactSha256 !== 'string' ||
      typeof entry.evidenceSha256 !== 'string' ||
      typeof entry.summary !== 'string' ||
      entry.summary.trim() === ''
    ) {
      throw new Error(`attestation stage evidence entry ${index} has invalid required fields`)
    }
    if (!hasOnlyOwnProperties(entry, STAGE_EVIDENCE_PROPERTIES)) {
      throw new Error(`attestation stage evidence entry ${index} has unknown properties`)
    }
    presentStages.add(entry.stage)
    if (entry.waiverOrApproval !== undefined) {
      const waiver = entry.waiverOrApproval
      if (
        !waiver ||
        typeof waiver !== 'object' ||
        (waiver.decision !== 'approve' && waiver.decision !== 'skip') ||
        typeof waiver.gateId !== 'string' ||
        waiver.gateId.trim() === '' ||
        !isCanonicalTimestamp(waiver.resolvedAt) ||
        !hasOnlyOwnProperties(waiver, WAIVER_PROPERTIES)
      ) {
        throw new Error(`attestation stage evidence entry ${index} has an invalid waiver`)
      }
    }
    if (!HEX_64.test(entry.evidenceSha256)) {
      throw new Error(`stage ${entry.stage} evidence hash is not a SHA-256`)
    }
    if (!HEX_64.test(entry.artifactSha256)) {
      throw new Error(`stage ${entry.stage} artifact hash is not a SHA-256`)
    }
    if (evidenceSha256({ ...entry, runId: manifest.runId }) !== entry.evidenceSha256) {
      throw new Error(`stage ${entry.stage} evidence hash does not match its recorded fields`)
    }
  }
  const missingStages = requiredStages.filter((stage) => !presentStages.has(stage))
  if (missingStages.length > 0) {
    throw new Error(`attestation is missing required stage evidence: ${missingStages.join(', ')}`)
  }
  if (merkleRoot(manifestLeaves(manifest)) !== manifest.merkleRoot) {
    throw new Error(
      'attestation Merkle root does not match its header ' +
        '(run ID, commit OIDs, policy hash, intent hash) or its stage evidence'
    )
  }
}

export const MAX_LOG_BYTES = 50 * 1024 * 1024
export const STAGE_LOG_TAIL_BYTES = 64 * 1024
const LOG_MARKER_RESERVE_BYTES = 512

/**
 * Values of environment variables whose names look like credentials, longest
 * first so a token containing a shorter one is masked as a whole.
 */
function knownSecrets(): string[] {
  return Object.entries(process.env)
    .flatMap(([name, value]) =>
      value &&
      value.length >= 4 &&
      /(?:access[_-]?key|api[_-]?key|auth|credential|passphrase|password|private[_-]?key|secret|session|token)/i.test(
        name,
      )
        ? [value]
        : [],
    )
    .sort((left, right) => right.length - left.length)
}

function applyRedaction(content: string, secrets: string[]): string {
  let redacted = content
  for (const secret of secrets) redacted = redacted.split(secret).join('[REDACTED]')
  return redacted
}

export function redactKnownSecrets(content: string): string {
  return applyRedaction(content, knownSecrets())
}

export function knownSecretPrefixBytes(): number {
  return Math.max(
    0,
    ...knownSecrets().map((secret) => Buffer.byteLength(secret) - 1),
  )
}

/**
 * Length of the trailing text that could still turn into a secret once more
 * arrives. Holding back a fixed window instead would stall ordinary output --
 * and a transcript that only lands at close is exactly what this log exists to
 * avoid -- so only a genuine partial match is withheld.
 */
function pendingSecretPrefix(text: string, secrets: string[]): number {
  const longest = secrets[0]?.length ?? 1
  for (let length = Math.min(text.length, longest - 1); length > 0; length -= 1) {
    const suffix = text.slice(text.length - length)
    if (secrets.some((secret) => secret.length > length && secret.startsWith(suffix))) {
      return length
    }
  }
  return 0
}

/**
 * O_NOFOLLOW rejects a symlink but happily opens a hard link to a tracked file,
 * so an inode reached that way would be appended to, chmod'd, or truncated.
 * A stage artifact is always a fresh, singly linked regular file.
 */
async function assertPrivateRegularFile(
  file: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  const info = await file.stat()
  if (!info.isFile() || info.nlink !== 1) {
    throw new Error('stage log path must be a private regular file')
  }
}

/**
 * Rejects a symlink anywhere from the artifact root down to `target`, including
 * the root itself. Checking only the final parent leaves a symlinked component
 * free to land the log inside the repository once `mkdir -p` follows it; the
 * walk stops at the first component that does not exist yet, so callers run it
 * again after creating the directory when the whole chain is present. The log
 * file itself is left to `O_NOFOLLOW` on open.
 */
async function assertNoSymlinkChain(rootPath: string, targetPath: string): Promise<void> {
  const root = path.resolve(rootPath)
  const target = path.resolve(targetPath)
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('stage log path escapes artifact root')
  }
  let current = root
  for (const component of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component)
    let entry: Awaited<ReturnType<typeof lstat>>
    try {
      entry = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return
    }
    if (entry.isSymbolicLink()) {
      throw new Error('stage log path must not contain symlinks')
    }
  }
}

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function capLog(content: string, maxBytes = MAX_LOG_BYTES): string {
  const source = Buffer.from(content, 'utf8')
  if (source.length <= maxBytes) return content
  const keep = Math.max(0, Math.floor((maxBytes - 512) / 2))
  const marker = `\n[no-mistakes: log truncated; retained first and last ${keep} of ${source.length} bytes]\n`
  return `${source.subarray(0, keep).toString('utf8')}${marker}${source.subarray(source.length - keep).toString('utf8')}`
}

/**
 * Appends streamed stage output to one capped log file outside the repository.
 *
 * Every chunk is written as it arrives, so a coordinator that dies mid-run
 * leaves the transcript up to that point on disk. Only once the file exceeds
 * its cap is it rewritten as head, truncation marker and tail -- through a
 * staging file and a rename, so an interrupted compaction leaves either the
 * whole old log or the whole capped one. The middle is what a runaway worker
 * loses.
 *
 * The budget belongs to the file, not the instance: coordinator commands and
 * workers in one stage round share a single bounded artifact, and a round
 * whose combined output still fits keeps every byte of it.
 */
export class StageLog {
  readonly #path: string
  readonly #keep: number
  readonly #maxBytes: number
  readonly #defaultSource = Symbol()
  readonly #carries = new Map<symbol, string>()
  #fileBytes = 0
  #fileIdentity = ''
  #originalBytes = 0
  #originalBytesKnown = true
  #started = false
  #file?: Awaited<ReturnType<typeof open>>
  #hasNewOutput = false
  #compacted = false
  #handoffCarry = ''
  #tail = Buffer.alloc(0)
  #pending = Promise.resolve()

  constructor(filePath: string, maxBytes = MAX_LOG_BYTES) {
    this.#path = filePath
    this.#maxBytes = maxBytes
    // A quarter each for the head and the tail, so a compacted log sits at
    // roughly half the cap. Splitting it in half instead would leave a
    // compacted file already at the cap, and every later chunk would rewrite
    // the whole artifact; this way one rewrite buys half a cap of new output.
    this.#keep = Math.max(0, Math.floor((maxBytes - LOG_MARKER_RESERVE_BYTES) / 4))
  }

  append(chunk: string, source = this.#defaultSource): Promise<void> {
    const pending = this.#pending.then(() => this.#append(chunk, source))
    this.#pending = pending.catch(() => {})
    return pending
  }

  tail(maxBytes: number): Buffer {
    return this.#tail.subarray(-maxBytes)
  }

  inheritTail(previous: StageLog): void {
    const keep = STAGE_LOG_TAIL_BYTES + knownSecretPrefixBytes()
    this.#tail = Buffer.from(previous.tail(keep))
    this.#handoffCarry = previous.#handoffCarry
    previous.#handoffCarry = ''
  }

  async #append(chunk: string, source: symbol): Promise<void> {
    if (chunk.length === 0) return
    await this.#start()
    const secrets = knownSecrets()
    const handoffCarry = this.#handoffCarry
    this.#handoffCarry = ''
    const redacted = applyRedaction(
      `${handoffCarry}${this.#carries.get(source) ?? ''}${chunk}`,
      secrets,
    )
    // Hold back only a trailing partial secret, so a credential split across two
    // drain pages is whole the next time redaction runs while ordinary output
    // still reaches disk immediately. `[REDACTED]` contains no secret, so
    // re-scanning what is carried stays idempotent.
    const hold = pendingSecretPrefix(redacted, secrets)
    if (hold > 0) {
      this.#carries.set(source, redacted.slice(redacted.length - hold))
    }
    else this.#carries.delete(source)
    await this.#absorb(redacted.slice(0, redacted.length - hold))
  }

  async close(options: { handoff?: boolean } = {}): Promise<void> {
    try {
      await this.#pending
      if (this.#carries.size > 0) {
        const carried = [...this.#carries.values()]
        this.#carries.clear()
        if (options.handoff) this.#handoffCarry = carried.join('')
        else {
          await this.#start()
          for (const chunk of carried) await this.#absorb(redactKnownSecrets(chunk))
        }
      }
      // A silent instance never opens the log, so it cannot disturb what the
      // round already recorded.
      if (!this.#hasNewOutput) return
      if (this.#compacted) await this.#compact()
      else if (!this.#originalBytesKnown) {
        await this.#absorb(
          '\n[no-mistakes: log accounting unavailable; original bytes unknown; retained ranges unknown]\n',
        )
      }
      await this.#recordOriginalBytes()
    } finally {
      const file = this.#file
      this.#file = undefined
      if (file) await file.close()
    }
  }

  async #absorb(text: string): Promise<void> {
    let pending = Buffer.from(text, 'utf8')
    if (pending.length === 0) return
    this.#hasNewOutput = true
    // Everything reaches disk as it arrives -- keeping the tail in memory
    // until close would mean a coordinator that dies mid-run leaves only the
    // head -- but never more than the cap at a time. One terminal page can
    // carry a single enormous line, and writing it whole would put an
    // oversized artifact on disk that a crash then leaves behind.
    while (pending.length > 0) {
      const room = Math.max(0, this.#maxBytes - this.#fileBytes)
      if (room === 0) {
        await this.#recordOriginalBytes()
        const before = this.#fileBytes
        await this.#compact()
        if (this.#fileBytes >= before) return
        continue
      }
      const slice = pending.subarray(0, room)
      await this.#write(slice)
      this.#fileBytes += slice.length
      this.#originalBytes += slice.length
      pending = pending.subarray(slice.length)
    }
  }

  /**
   * Replaces a file with fresh content through a staging file and a rename.
   *
   * The staging path is unlinked and created exclusively rather than
   * truncated: a worker that pre-creates it as a hard link to a tracked file
   * would otherwise have that inode truncated by the open itself, before any
   * check could reject it. Unlinking only drops the planted name.
   */
  async #replaceFile(targetPath: string, parts: Buffer[]): Promise<void> {
    // The chain is checked again on every replacement, not just at open: a
    // directory validated once can be renamed away and replaced with a link
    // into the repository before the log is compacted or its sidecar written.
    const directory = path.dirname(targetPath)
    await assertNoSymlinkChain(path.dirname(directory), directory)
    const stagingPath = `${targetPath}.staging`
    await rm(stagingPath, { force: true })
    const staging = await open(
      stagingPath,
      O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW,
      0o600,
    )
    try {
      await assertPrivateRegularFile(staging)
      for (const part of parts) await staging.writeFile(part)
      await staging.sync()
    } finally {
      await staging.close()
    }
    await rename(stagingPath, targetPath)
  }

  /**
   * Rewrites an over-cap log as head + marker + tail. Runs only once the file
   * actually exceeds the cap, so a round whose combined output still fits keeps
   * every byte, and the bytes are sliced positionally -- nothing in the file is
   * parsed, so worker output cannot influence the result.
   */
  async #compact(): Promise<void> {
    const file = this.#file
    if (!file) return
    // Read from position 0 explicitly: the handle is opened O_APPEND and sits
    // at EOF, so a position-relative read returns nothing.
    const size = (await file.stat()).size
    // read() may return fewer bytes than asked for, and the buffer is
    // uninitialized, so what makes this safe is that only the bytes actually
    // read are ever used: the slice below bounds the artifact, whether or not
    // the loop managed to fill the buffer.
    const buffer = Buffer.allocUnsafe(size)
    let filled = 0
    while (filled < size) {
      const { bytesRead } = await file.read(buffer, filled, size - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    const existing = buffer.subarray(0, filled)
    const head = existing.subarray(0, this.#keep)
    const tail = existing.subarray(Math.max(head.length, existing.length - this.#keep))
    const marker = Buffer.from(this.#truncationMarker(head.length, tail.length), 'utf8')
    const parts = [head, marker, tail].filter((part) => part.length > 0)

    // Build the capped form beside the log and rename it into place. Truncating
    // the live artifact first would mean a crash mid-rewrite destroys the head
    // and tail that were already durable; a rename leaves either the whole old
    // file or the whole new one.
    await this.#replaceFile(path.resolve(this.#path), parts)

    // The handle still refers to the replaced inode, so reopen on the new one.
    await file.close()
    const reopened = await open(
      path.resolve(this.#path),
      O_APPEND | O_CREAT | O_RDWR | O_NOFOLLOW,
      0o600,
    )
    await assertPrivateRegularFile(reopened)
    this.#file = reopened
    const reopenedStat = await reopened.stat({ bigint: true })
    this.#fileIdentity = `${reopenedStat.dev}:${reopenedStat.ino}:${reopenedStat.birthtimeNs}`
    this.#fileBytes = parts.reduce((total, part) => total + part.length, 0)
    this.#compacted = true
    await this.#recordOriginalBytes()
  }

  async #start(): Promise<void> {
    if (this.#started) return
    const logPath = path.resolve(this.#path)
    const directory = path.dirname(logPath)
    const artifactRoot = path.dirname(directory)
    await assertNoSymlinkChain(artifactRoot, directory)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await assertNoSymlinkChain(artifactRoot, directory)
    const [canonicalRoot, canonicalDirectory] = await Promise.all([
      realpath(artifactRoot),
      realpath(directory),
    ])
    const canonicalLog = path.join(canonicalDirectory, path.basename(logPath))
    if (!isWithin(canonicalRoot, canonicalLog)) {
      throw new Error('stage log path escapes artifact root')
    }
    await chmod(directory, 0o700)
    const file = await open(logPath, O_APPEND | O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
    try {
      await assertPrivateRegularFile(file)
      const fileStat = await file.stat({ bigint: true })
      let existingBytes = Number(fileStat.size)
      const fileIdentity = `${fileStat.dev}:${fileStat.ino}:${fileStat.birthtimeNs}`
      const canTrustFileIdentity =
        fileStat.birthtimeNs > 0n && fileStat.birthtimeNs !== fileStat.ctimeNs
      await file.chmod(0o600)
      // The first `keep` bytes are the round's head and never change; whatever
      // follows is the previous worker's marker and tail, which this worker's
      // output replaces so the file ends with the round's final tail. Nothing
      // already on disk is parsed back, so worker text cannot forge accounting.
      const recorded = await this.#priorAccounting()
      const prior =
        canTrustFileIdentity && recorded?.fileIdentity === fileIdentity
          ? recorded
          : undefined
      this.#originalBytesKnown =
        existingBytes === 0 ||
        (prior !== undefined && prior.originalBytesKnown !== false)
      this.#originalBytes =
        prior === undefined
          ? existingBytes
          : prior.originalBytes +
            (existingBytes > prior.fileBytes
              ? existingBytes - prior.fileBytes
              : 0)
      // A prior total larger than the file means the round already compacted:
      // its marker describes the old tail, so close() has to rewrite it even
      // though the physical file is back under the cap.
      this.#compacted =
        prior !== undefined &&
        (this.#originalBytes > existingBytes ||
          existingBytes < prior.fileBytes)
      this.#fileBytes = existingBytes
      this.#fileIdentity = fileIdentity
      this.#file = file
      this.#started = true
      if (prior === undefined) {
        await this.#recordOriginalBytes()
      }
      // A crash during compaction can leave the artifact over its cap. Repair
      // it here rather than refusing to open, so an interrupted run neither
      // loses its transcript nor keeps growing past the bound.
      if (existingBytes > this.#maxBytes) {
        await this.#compact()
        existingBytes = this.#fileBytes
      }
    } catch (error) {
      await file.close()
      throw error
    }
  }

  #metaPath(): string {
    return `${path.resolve(this.#path)}.meta`
  }

  /**
   * The round's identity-bound byte accounting carried across writers and
   * reopens. Legacy numeric and identity-less records are treated as absent so
   * #start writes a fresh baseline before new output. The sidecar lives beside
   * the log because a count parsed from worker-writable output is forgeable.
   */
  async #priorAccounting(): Promise<
    {
      fileBytes: number
      fileIdentity: string
      originalBytes: number
      originalBytesKnown?: boolean
    } | undefined
  > {
    let file: Awaited<ReturnType<typeof open>>
    try {
      file = await open(this.#metaPath(), O_RDONLY | O_NOFOLLOW)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // ELOOP means something replaced the sidecar with a symlink. Treat a
      // tampered count as absent rather than trusting it.
      if (code === 'ENOENT' || code === 'ELOOP') return undefined
      throw error
    }
    try {
      if (!(await file.stat()).isFile()) return undefined
      const raw = (await file.readFile('utf8')).trim()
      try {
        const parsed = JSON.parse(raw) as {
          fileBytes?: unknown
          fileIdentity?: unknown
          originalBytes?: unknown
          originalBytesKnown?: unknown
        }
        if (
          Number.isSafeInteger(parsed.originalBytes) &&
          (parsed.originalBytes as number) >= 0 &&
          Number.isSafeInteger(parsed.fileBytes) &&
          (parsed.fileBytes as number) >= 0 &&
          typeof parsed.fileIdentity === 'string' &&
          (parsed.originalBytesKnown === undefined ||
            typeof parsed.originalBytesKnown === 'boolean')
        ) {
          return {
            fileBytes: parsed.fileBytes as number,
            fileIdentity: parsed.fileIdentity,
            originalBytes: parsed.originalBytes as number,
            originalBytesKnown: parsed.originalBytesKnown as boolean | undefined,
          }
        }
      } catch {}
      return undefined
    } finally {
      await file.close()
    }
  }

  async #recordOriginalBytes(): Promise<void> {
    // O_NOFOLLOW so a symlink planted at the sidecar path cannot redirect this
    // write onto an arbitrary file, matching how the log itself is opened.
    try {
      await this.#replaceFile(this.#metaPath(), [
        Buffer.from(
          JSON.stringify({
            fileBytes: this.#fileBytes,
            fileIdentity: this.#fileIdentity,
            originalBytes: this.#originalBytes,
            originalBytesKnown: this.#originalBytesKnown,
          }),
          'utf8',
        ),
      ])
    } catch {
      // The sidecar is an optimisation: losing it costs the round its byte
      // total, which the marker then reports as unknown. A planted symlink, a
      // foreign inode, a read-only directory -- none of them are worth failing
      // the transcript over, so every failure here is swallowed.
    }
  }

  #truncationMarker(headBytes: number, tailBytes: number): string {
    const dropped = this.#originalBytesKnown
      ? String(Math.max(0, this.#originalBytes - headBytes - tailBytes))
      : 'unknown'
    const ranges: string[] = []
    if (headBytes > 0) ranges.push(`0-${headBytes - 1}`)
    if (tailBytes > 0 && this.#originalBytesKnown) {
      ranges.push(`${this.#originalBytes - tailBytes}-${this.#originalBytes - 1}`)
    }
    const originalBytes = this.#originalBytesKnown ? String(this.#originalBytes) : 'unknown'
    return `\n[no-mistakes: log truncated; dropped ${dropped} bytes; original bytes ${originalBytes}; retained ranges ${ranges.join(', ') || 'none'}]\n`
  }

  async #write(data: Buffer): Promise<void> {
    if (!this.#file) throw new Error('stage log is not open')
    await this.#file.writeFile(data)
    const keep = STAGE_LOG_TAIL_BYTES + knownSecretPrefixBytes()
    this.#tail = data.length >= keep
      ? Buffer.from(data.subarray(-keep))
      : Buffer.concat([
          this.#tail.subarray(Math.max(0, this.#tail.length + data.length - keep)),
          data,
        ])
  }
}

export function noMistakesHome(): string {
  return process.env.ORCA_NO_MISTAKES_HOME ?? path.join(homedir(), '.orca-no-mistakes')
}

export function legacyLedgerPath(): string {
  return path.join(noMistakesHome(), 'ledger.db')
}

function repositoryLocation(repositoryPath: string): { ledgerPath: string; repoRoot: string } {
  const repoRoot = execFileSync(
    'git',
    ['-C', repositoryPath, 'rev-parse', '--path-format=absolute', '--show-toplevel'],
    { encoding: 'utf8', env: cleanGitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
  const commonDir = execFileSync(
    'git',
    ['-C', repositoryPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', env: cleanGitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
  return {
    ledgerPath: path.join(commonDir, 'orca-no-mistakes', 'ledger.sqlite'),
    repoRoot
  }
}

export function cleanGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  const exactKeys = new Set([
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_CONFIG',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PREFIX',
    'GIT_QUARANTINE_PATH',
    'GIT_WORK_TREE'
  ])
  for (const key of Object.keys(environment)) {
    if (exactKeys.has(key) || key.startsWith('GIT_CONFIG_') || key.startsWith('GIT_PUSH_OPTION_')) {
      delete environment[key]
    }
  }
  return environment
}

/** Stable forge/repository/owner identity shared by a repository route and every per-run route it seeds. */
export function repositoryIdentityFingerprint(route: {
  base_repository_id: string
  forge_host: string
  head_owner: string
  head_repository_id: string
}): string {
  return sha256(canonicalJson({
    baseRepositoryId: route.base_repository_id,
    forgeHost: route.forge_host,
    headOwner: route.head_owner,
    headRepositoryId: route.head_repository_id
  }))
}

export function allowsLegacyLedgerFallback(error: unknown): boolean {
  if (!(error instanceof Error) || !('status' in error) || error.status !== 128) return false
  const stderr = 'stderr' in error ? String(error.stderr ?? '') : ''
  return /not a git repository/i.test(stderr) ||
    (/cannot change to/i.test(stderr) && /No such file or directory/i.test(stderr))
}

export function repositoryLedgerPath(repositoryPath = process.cwd()): string {
  return repositoryLocation(repositoryPath).ledgerPath
}

function defaultLedgerLocation(): { dbPath: string; legacyPath?: string; repoRoot?: string } {
  try {
    const repository = repositoryLocation(process.cwd())
    return {
      dbPath: repository.ledgerPath,
      legacyPath: legacyLedgerPath(),
      repoRoot: repository.repoRoot
    }
  } catch (error) {
    if (!allowsLegacyLedgerFallback(error)) throw error
    return { dbPath: legacyLedgerPath() }
  }
}

export function defaultLedgerPath(): string {
  return defaultLedgerLocation().dbPath
}

export function artifactsRoot(): string {
  return path.join(noMistakesHome(), 'artifacts')
}

type LeaseRow = { generation_token: number | bigint; run_id: string }

export type PrunableRun = {
  base_branch: string
  branch: string
  repo_root: string
  run_id: string
}

const RELEASE_2_FACT_TABLES = [
  'stage_plan_entries',
  'stage_dispositions',
  'stage_disposition_supersessions',
  'publication_routes',
  'publication_baselines',
  'run_attempts',
  'attempt_outcomes',
  'remote_observations',
  'mutation_intents',
  'resolved_mutation_intents',
  'remote_receipts',
  'auto_fix_mode_events'
] as const

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  initial_coordinator_identity TEXT NOT NULL,
  submission_commit_oid TEXT NOT NULL,
  terminal_commit_oid TEXT,
  intent TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  policy_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('in-progress', 'passed', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS submission_admissions (
  admission_id TEXT PRIMARY KEY,
  gate_identity TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  old_oid TEXT NOT NULL,
  new_oid TEXT NOT NULL,
  intent TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('direct', 'gate')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'launched', 'accepted', 'failed', 'superseded')),
  lease_token TEXT NOT NULL,
  run_id TEXT REFERENCES runs(run_id),
  created_at TEXT NOT NULL,
  launched_at TEXT,
  accepted_oid TEXT,
  accepted_at TEXT,
  UNIQUE (gate_identity, repo_root, ref_name, new_oid, intent_hash)
);

CREATE TABLE IF NOT EXISTS run_abandonments (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  prior_status TEXT NOT NULL CHECK(prior_status IN ('in-progress', 'failed')),
  coordinator_identity TEXT NOT NULL,
  generation_token INTEGER NOT NULL,
  actor_identity TEXT NOT NULL,
  reason TEXT NOT NULL,
  abandoned_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS immutable_run_abandonments
BEFORE UPDATE ON run_abandonments
BEGIN SELECT RAISE(ABORT, 'run abandonment is immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_run_abandonments_delete
BEFORE DELETE ON run_abandonments
WHEN EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'run abandonment is immutable'); END;

CREATE TABLE IF NOT EXISTS pending_admission_leases (
  repo_root TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  admission_id TEXT NOT NULL UNIQUE REFERENCES submission_admissions(admission_id) ON DELETE CASCADE,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, ref_name)
);

CREATE INDEX IF NOT EXISTS idx_submission_admissions_run
  ON submission_admissions(run_id);
CREATE INDEX IF NOT EXISTS idx_submission_admissions_ref
  ON submission_admissions(repo_root, ref_name, created_at);

CREATE TABLE IF NOT EXISTS repository_migrations (
  source_path TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  source_present INTEGER NOT NULL CHECK(source_present IN (0, 1)),
  completed_at TEXT NOT NULL,
  PRIMARY KEY (source_path, repo_root)
);

CREATE TABLE IF NOT EXISTS repository_migration_imports (
  repo_root TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS repository_publication_routes (
  repo_root TEXT PRIMARY KEY,
  route_fingerprint TEXT NOT NULL,
  forge_host TEXT NOT NULL CHECK(forge_host = 'github.com'),
  base_repository_id TEXT NOT NULL,
  base_repository_node_id TEXT NOT NULL,
  base_repository_name TEXT NOT NULL,
  head_repository_id TEXT NOT NULL,
  head_repository_node_id TEXT NOT NULL,
  head_repository_name TEXT NOT NULL,
  network_root_repository_id TEXT NOT NULL,
  head_owner TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_login TEXT NOT NULL,
  actor_node_id TEXT,
  credential_source TEXT NOT NULL CHECK(credential_source IN ('GH_TOKEN', 'GITHUB_TOKEN', 'stored-account')),
  backend TEXT NOT NULL CHECK(backend IN ('gh', 'gh-axi')),
  backend_version TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stage_plan_entries (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0),
  stage_id TEXT NOT NULL,
  requirement TEXT NOT NULL CHECK(requirement IN ('required', 'optional', 'disabled')),
  PRIMARY KEY (run_id, position),
  UNIQUE (run_id, stage_id)
);

CREATE TABLE IF NOT EXISTS stage_dispositions (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('satisfied', 'failed', 'skipped', 'waived', 'disabled')),
  evidence_sha256 TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (run_id, stage_id),
  FOREIGN KEY (run_id, stage_id) REFERENCES stage_plan_entries(run_id, stage_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stage_disposition_supersessions (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('satisfied', 'failed', 'skipped', 'waived', 'disabled')),
  prior_evidence_sha256 TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (run_id, stage_id, evidence_sha256),
  FOREIGN KEY (run_id, stage_id) REFERENCES stage_plan_entries(run_id, stage_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS publication_routes (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  route_fingerprint TEXT NOT NULL,
  forge_host TEXT NOT NULL,
  base_repository_id TEXT NOT NULL,
  head_repository_id TEXT NOT NULL,
  head_owner TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publication_baselines (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  route_fingerprint TEXT NOT NULL,
  transport_url TEXT,
  head_commit_oid TEXT,
  authoritative_absence INTEGER NOT NULL CHECK(authoritative_absence IN (0, 1)),
  observed_at TEXT NOT NULL,
  CHECK((head_commit_oid IS NULL) = authoritative_absence)
);

CREATE TABLE IF NOT EXISTS run_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  generation_token INTEGER NOT NULL,
  coordinator_identity TEXT NOT NULL,
  actor_identity TEXT NOT NULL,
  started_at TEXT NOT NULL,
  UNIQUE (run_id, generation_token)
);

CREATE TABLE IF NOT EXISTS attempt_outcomes (
  outcome_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES run_attempts(attempt_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK(verdict IN ('passed', 'failed', 'cancelled')),
  stopping_fact TEXT NOT NULL,
  reason TEXT NOT NULL,
  candidate_commit_oid TEXT NOT NULL,
  coordinator_identity TEXT NOT NULL,
  actor_identity TEXT NOT NULL,
  custody_json TEXT NOT NULL,
  receipt_digests_json TEXT NOT NULL,
  resume_eligible INTEGER NOT NULL CHECK(resume_eligible IN (0, 1)),
  completed_at TEXT NOT NULL,
  outcome_sha256 TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS remote_observations (
  observation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES run_attempts(attempt_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  observation_sha256 TEXT NOT NULL UNIQUE,
  UNIQUE (run_id, observation_sha256)
);

CREATE TABLE IF NOT EXISTS mutation_intents (
  mutation_intent_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES run_attempts(attempt_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('candidate-publication', 'pull-request', 'managed-comment')),
  target_fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  intent_sha256 TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS resolved_mutation_intents (
  resolution_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES run_attempts(attempt_id) ON DELETE CASCADE,
  intent_sha256 TEXT NOT NULL REFERENCES mutation_intents(intent_sha256) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(reason IN ('definite-failure', 'lease-lost', 'reconciled')),
  resolved_at TEXT NOT NULL,
  UNIQUE (run_id, intent_sha256)
);

CREATE TABLE IF NOT EXISTS remote_receipts (
  receipt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('candidate-publication', 'pull-request-binding')),
  candidate_commit_oid TEXT NOT NULL,
  authoritative_post_observation_sha256 TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id, authoritative_post_observation_sha256)
    REFERENCES remote_observations(run_id, observation_sha256) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS branch_leases (
  repo_root TEXT NOT NULL,
  branch TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  generation_token INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, branch)
);

CREATE TABLE IF NOT EXISTS lease_generations (
  repo_root TEXT PRIMARY KEY,
  next_token INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resume_claims (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL UNIQUE,
  generation_token INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stage_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL,
  round_index INTEGER NOT NULL,
  input_commit_oid TEXT NOT NULL,
  output_commit_oid TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stage_evidence (
  evidence_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL,
  round_index INTEGER NOT NULL,
  candidate_commit_oid TEXT NOT NULL,
  base_commit_oid TEXT NOT NULL,
  worker_identity TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  artifact_sha256 TEXT,
  summary TEXT NOT NULL,
  findings_json TEXT,
  effective_policy_hash TEXT,
  base_ref_sha TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gate_audit (
  gate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL,
  round_index INTEGER NOT NULL,
  evidence_sha256 TEXT,
  gate_kind TEXT NOT NULL DEFAULT 'finding',
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  resolution TEXT NOT NULL,
  decision TEXT NOT NULL,
  guidance TEXT,
  selected_finding_ids TEXT,
  opened_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_stage_checkpoints_run ON stage_checkpoints(run_id);
CREATE INDEX IF NOT EXISTS idx_stage_plan_run ON stage_plan_entries(run_id, position);
CREATE INDEX IF NOT EXISTS idx_attempt_outcomes_run ON attempt_outcomes(run_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_remote_observations_run ON remote_observations(run_id, observed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_observations_run_digest
  ON remote_observations(run_id, observation_sha256);
CREATE INDEX IF NOT EXISTS idx_mutation_intents_run ON mutation_intents(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_resolved_mutation_intents_run ON resolved_mutation_intents(run_id);
CREATE INDEX IF NOT EXISTS idx_stage_evidence_run ON stage_evidence(run_id);
CREATE INDEX IF NOT EXISTS idx_stage_evidence_stage
  ON stage_evidence(run_id, stage_id, round_index);
CREATE INDEX IF NOT EXISTS idx_gate_audit_run ON gate_audit(run_id);

CREATE TABLE IF NOT EXISTS presentation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, event_key),
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_presentation_snapshots_run
  ON presentation_snapshots(run_id, sequence);

CREATE TABLE IF NOT EXISTS auto_fix_mode_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  source TEXT NOT NULL CHECK (source IN ('initial', 'operator')),
  changed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auto_fix_mode_events_run
  ON auto_fix_mode_events(run_id, id);

CREATE TABLE IF NOT EXISTS passed_attestations (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  candidate_commit_oid TEXT NOT NULL,
  base_commit_oid TEXT NOT NULL,
  policy_sha256 TEXT NOT NULL,
  intent TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  merkle_root TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  coordinator_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_passed_attestations_candidate
  ON passed_attestations(candidate_commit_oid, created_at);

CREATE TABLE IF NOT EXISTS media_publications (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  candidate_commit_oid TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  host TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'failed', 'uncertain')),
  url TEXT,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, candidate_commit_oid, artifact_sha256, repository_id, host)
);

CREATE TABLE IF NOT EXISTS media_publication_artifacts (
  run_id TEXT NOT NULL,
  candidate_commit_oid TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  host TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  PRIMARY KEY (run_id, candidate_commit_oid, artifact_sha256, repository_id, host, artifact_path),
  FOREIGN KEY (run_id, candidate_commit_oid, artifact_sha256, repository_id, host)
    REFERENCES media_publications(run_id, candidate_commit_oid, artifact_sha256, repository_id, host) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS immutable_stage_plan_entries
BEFORE UPDATE ON stage_plan_entries
BEGIN SELECT RAISE(ABORT, 'stage_plan_entries rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_stage_dispositions
BEFORE UPDATE ON stage_dispositions
BEGIN SELECT RAISE(ABORT, 'stage_dispositions rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_stage_disposition_supersessions
BEFORE UPDATE ON stage_disposition_supersessions
BEGIN SELECT RAISE(ABORT, 'stage_disposition_supersessions rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_publication_routes
BEFORE UPDATE ON publication_routes
BEGIN SELECT RAISE(ABORT, 'publication_routes rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_publication_baselines
BEFORE UPDATE ON publication_baselines
BEGIN SELECT RAISE(ABORT, 'publication_baselines rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_run_attempts
BEFORE UPDATE ON run_attempts
BEGIN SELECT RAISE(ABORT, 'run_attempts rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_attempt_outcomes
BEFORE UPDATE ON attempt_outcomes
BEGIN SELECT RAISE(ABORT, 'attempt_outcomes rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_remote_observations
BEFORE UPDATE ON remote_observations
BEGIN SELECT RAISE(ABORT, 'remote_observations rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_mutation_intents
BEFORE UPDATE ON mutation_intents
BEGIN SELECT RAISE(ABORT, 'mutation_intents rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_resolved_mutation_intents
BEFORE UPDATE ON resolved_mutation_intents
BEGIN SELECT RAISE(ABORT, 'resolved_mutation_intents rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_remote_receipts
BEFORE UPDATE ON remote_receipts
BEGIN SELECT RAISE(ABORT, 'remote_receipts rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_stage_plan_entries_delete
BEFORE DELETE ON stage_plan_entries
WHEN EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'stage_plan_entries rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_stage_dispositions_delete
BEFORE DELETE ON stage_dispositions
WHEN EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'stage_dispositions rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_stage_disposition_supersessions_delete
BEFORE DELETE ON stage_disposition_supersessions
WHEN EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'stage_disposition_supersessions rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_publication_routes_delete
BEFORE DELETE ON publication_routes
WHEN EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'publication_routes rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_publication_baselines_delete
BEFORE DELETE ON publication_baselines
WHEN EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'publication_baselines rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_run_attempts_delete
BEFORE DELETE ON run_attempts
WHEN EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'run_attempts rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_attempt_outcomes_delete
BEFORE DELETE ON attempt_outcomes
WHEN EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'attempt_outcomes rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_remote_observations_delete
BEFORE DELETE ON remote_observations
WHEN EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'remote_observations rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_mutation_intents_delete
BEFORE DELETE ON mutation_intents
WHEN EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'mutation_intents rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_resolved_mutation_intents_delete
BEFORE DELETE ON resolved_mutation_intents
WHEN EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'resolved_mutation_intents rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_remote_receipts_delete
BEFORE DELETE ON remote_receipts
WHEN EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'remote_receipts rows are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_auto_fix_mode_events
BEFORE UPDATE ON auto_fix_mode_events
BEGIN SELECT RAISE(ABORT, 'auto-fix mode events are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_auto_fix_mode_events_delete
BEFORE DELETE ON auto_fix_mode_events
WHEN EXISTS (SELECT 1 FROM runs WHERE run_id = OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'auto-fix mode events are immutable'); END;

CREATE TRIGGER IF NOT EXISTS enforce_remote_observation_attempt
BEFORE INSERT ON remote_observations
WHEN NOT EXISTS (
  SELECT 1 FROM run_attempts
  WHERE attempt_id = NEW.attempt_id AND run_id = NEW.run_id
)
BEGIN SELECT RAISE(ABORT, 'attempt does not belong to run'); END;

CREATE TRIGGER IF NOT EXISTS enforce_mutation_intent_attempt
BEFORE INSERT ON mutation_intents
WHEN NOT EXISTS (
  SELECT 1 FROM run_attempts
  WHERE attempt_id = NEW.attempt_id AND run_id = NEW.run_id
)
BEGIN SELECT RAISE(ABORT, 'attempt does not belong to run'); END;

CREATE TRIGGER IF NOT EXISTS enforce_remote_receipt_observation
BEFORE INSERT ON remote_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM remote_observations
  WHERE run_id = NEW.run_id
    AND observation_sha256 = NEW.authoritative_post_observation_sha256
)
BEGIN SELECT RAISE(ABORT, 'receipt observation does not belong to run'); END;
`

export type AttemptOutcomeInput = {
  actorIdentity: string
  attemptId: string
  candidateCommitOid: string
  completedAt: string
  coordinatorIdentity: string
  custody: Record<string, unknown>
  reason: string
  receiptDigests: string[]
  resumeEligible: boolean
  runId: string
  stoppingFact: string
  verdict: Exclude<RunStatus, 'in-progress'>
}

export function attemptOutcomeSha256(input: AttemptOutcomeInput): string {
  return sha256(canonicalJson({
    actorIdentity: input.actorIdentity,
    attemptId: input.attemptId,
    candidateCommitOid: input.candidateCommitOid,
    completedAt: input.completedAt,
    coordinatorIdentity: input.coordinatorIdentity,
    custody: input.custody,
    reason: input.reason,
    receiptDigests: input.receiptDigests,
    resumeEligible: input.resumeEligible,
    runId: input.runId,
    stoppingFact: input.stoppingFact,
    verdict: input.verdict
  }))
}

export class DomainLedger {
  readonly #db: DatabaseSync
  readonly #path: string

  constructor(
    location?: string | { legacyPath?: string; repositoryPath: string }
  ) {
    const resolved: { dbPath: string; legacyPath?: string; repoRoot?: string } =
      location === undefined
        ? defaultLedgerLocation()
        : typeof location === 'string'
        ? { dbPath: location }
        : (() => {
            const repository = repositoryLocation(location.repositoryPath)
            return {
              dbPath: repository.ledgerPath,
              legacyPath: location.legacyPath ?? legacyLedgerPath(),
              repoRoot: repository.repoRoot
            }
          })()
    const dbPath = resolved.dbPath
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(dbPath), { recursive: true })
    }
    this.#path = dbPath
    this.#db = new DatabaseSync(dbPath, { timeout: 5_000 })
    const walDeadline = Date.now() + 5_000
    const walWait = new Int32Array(new SharedArrayBuffer(4))
    for (;;) {
      try {
        this.#db.exec('PRAGMA journal_mode = WAL')
        break
      } catch (error) {
        if (
          !(error instanceof Error && 'errcode' in error && error.errcode === 5) ||
          Date.now() >= walDeadline
        ) {
          throw error
        }
        Atomics.wait(walWait, 0, 0, 10)
      }
    }
    this.#db.exec('PRAGMA foreign_keys = ON')
    // ponytail: pre-release rebuild — legacy ledgers keyed attestations by candidate OID,
    // which let a repeat attestation overwrite the original run's lookup.
    const legacyAttestations = this.#db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'passed_attestations'")
      .get() as { sql: string } | undefined
    if (legacyAttestations && !legacyAttestations.sql.includes('run_id TEXT PRIMARY KEY')) {
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        this.#db.exec('ALTER TABLE passed_attestations RENAME TO passed_attestations_legacy')
        this.#db.exec(SCHEMA)
        this.#db.exec(`INSERT INTO passed_attestations (
            run_id, candidate_commit_oid, base_commit_oid, policy_sha256, intent, intent_hash,
            merkle_root, manifest_json, coordinator_version, created_at
          )
          SELECT run_id, candidate_commit_oid, base_commit_oid, policy_sha256, intent, intent_hash,
                 merkle_root, manifest_json, coordinator_version, created_at
          FROM passed_attestations_legacy`)
        this.#db.exec('DROP TABLE passed_attestations_legacy')
        this.#db.exec('COMMIT')
        console.error('no-mistakes: rebuilt passed_attestations onto the per-run key; existing rows preserved')
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
    }
    // ponytail: pre-release rebuild — legacy ledgers recorded a gate only once it
    // resolved, so a run interrupted at a blocking gate left no durable event.
    const legacyGateAudit = this.#db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gate_audit'")
      .get() as { sql: string } | undefined
    if (legacyGateAudit && !legacyGateAudit.sql.includes('gate_kind')) {
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        this.#db.exec('ALTER TABLE gate_audit RENAME TO gate_audit_legacy')
        this.#db.exec(SCHEMA)
        this.#db.exec(`INSERT INTO gate_audit (
            gate_id, run_id, stage_id, round_index, question, options_json,
            resolution, decision, guidance, opened_at, resolved_at
          )
          SELECT gate_id, run_id, stage_id, round_index, question, options_json,
                 resolution, decision, guidance, resolved_at, resolved_at
          FROM gate_audit_legacy`)
        this.#db.exec('DROP TABLE gate_audit_legacy')
        this.#db.exec('COMMIT')
        console.error('no-mistakes: rebuilt gate_audit with durable gate events; existing rows preserved')
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
    }
    const singleRemoteReceipt = this.#db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'remote_receipts'")
      .get() as { sql: string } | undefined
    if (singleRemoteReceipt?.sql.includes('UNIQUE (run_id, kind)')) {
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        this.#db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_observations_run_digest
          ON remote_observations(run_id, observation_sha256)`)
        this.#db.exec(`DROP TRIGGER IF EXISTS immutable_remote_receipts;
          DROP TRIGGER IF EXISTS immutable_remote_receipts_delete;
          DROP TRIGGER IF EXISTS enforce_remote_receipt_observation;
          DROP TRIGGER IF EXISTS fence_terminal_remote_receipts;
          ALTER TABLE remote_receipts RENAME TO remote_receipts_legacy`)
        this.#db.exec(SCHEMA)
        this.#db.exec(`INSERT INTO remote_receipts (
            receipt_id, run_id, kind, candidate_commit_oid,
            authoritative_post_observation_sha256, receipt_json, receipt_sha256, created_at
          )
          SELECT receipt_id, run_id, kind, candidate_commit_oid,
                 authoritative_post_observation_sha256, receipt_json, receipt_sha256, created_at
          FROM remote_receipts_legacy`)
        this.#db.exec('DROP TABLE remote_receipts_legacy')
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
    }
    const singleUsePublicationRoute = this.#db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'publication_routes'")
      .get() as { sql: string } | undefined
    if (singleUsePublicationRoute && /route_fingerprint\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(singleUsePublicationRoute.sql)) {
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        this.#db.exec(`DROP TRIGGER IF EXISTS immutable_publication_routes;
          DROP TRIGGER IF EXISTS immutable_publication_routes_delete;
          DROP TRIGGER IF EXISTS fence_terminal_publication_routes;
          ALTER TABLE publication_routes RENAME TO publication_routes_legacy`)
        this.#db.exec(SCHEMA)
        this.#db.exec(`INSERT INTO publication_routes (
            run_id, route_fingerprint, forge_host, base_repository_id,
            head_repository_id, head_owner, head_branch, base_branch, created_at
          )
          SELECT run_id, route_fingerprint, forge_host, base_repository_id,
                 head_repository_id, head_owner, head_branch, base_branch, created_at
          FROM publication_routes_legacy`)
        this.#db.exec('DROP TABLE publication_routes_legacy')
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
    }
    const resolvedIntentSchema = this.#db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resolved_mutation_intents'")
      .get() as { sql: string } | undefined
    if (resolvedIntentSchema && !resolvedIntentSchema.sql.includes("'reconciled'")) {
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        this.#db.exec(`DROP INDEX IF EXISTS idx_resolved_mutation_intents_run;
          DROP TRIGGER IF EXISTS immutable_resolved_mutation_intents;
          DROP TRIGGER IF EXISTS immutable_resolved_mutation_intents_delete;
          DROP TRIGGER IF EXISTS fence_terminal_resolved_mutation_intents;
          ALTER TABLE resolved_mutation_intents RENAME TO resolved_mutation_intents_legacy`)
        this.#db.exec(SCHEMA)
        this.#db.exec(`INSERT INTO resolved_mutation_intents (
            resolution_id, run_id, attempt_id, intent_sha256, reason, resolved_at
          )
          SELECT resolution_id, run_id, attempt_id, intent_sha256, reason, resolved_at
          FROM resolved_mutation_intents_legacy`)
        this.#db.exec('DROP TABLE resolved_mutation_intents_legacy')
        this.#db.exec(`CREATE INDEX IF NOT EXISTS idx_resolved_mutation_intents_run
          ON resolved_mutation_intents(run_id)`)
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
    }
    this.#db.exec(SCHEMA)
    this.#db.exec('DROP TRIGGER IF EXISTS fence_run_attempt_generation')
    this.#db.exec(`CREATE TRIGGER IF NOT EXISTS fence_run_attempt_generation
      BEFORE INSERT ON run_attempts
      WHEN NOT EXISTS (
        SELECT 1 FROM runs r
        JOIN branch_leases l ON l.repo_root = r.repo_root AND l.branch = r.branch
        WHERE r.run_id = NEW.run_id AND l.run_id = NEW.run_id
          AND l.generation_token = NEW.generation_token
      ) AND NOT EXISTS (
        SELECT 1 FROM runs r
        JOIN repository_migration_imports m ON m.repo_root = r.repo_root
        WHERE r.run_id = NEW.run_id
      )
      BEGIN SELECT RAISE(ABORT, 'attempt is not from the current branch lease generation'); END;`)
    for (const table of ['attempt_outcomes', 'remote_observations', 'mutation_intents']) {
      this.#db.exec(`DROP TRIGGER IF EXISTS fence_current_${table}`)
      this.#db.exec(`CREATE TRIGGER IF NOT EXISTS fence_current_${table}
        BEFORE INSERT ON ${table}
        WHEN EXISTS (
          SELECT 1 FROM run_attempts
          WHERE attempt_id = NEW.attempt_id AND run_id = NEW.run_id
        ) AND NOT EXISTS (
          SELECT 1 FROM run_attempts a
          JOIN runs r ON r.run_id = a.run_id
          JOIN branch_leases l ON l.repo_root = r.repo_root AND l.branch = r.branch
          WHERE a.attempt_id = NEW.attempt_id AND a.run_id = NEW.run_id
            AND l.run_id = NEW.run_id AND l.generation_token = a.generation_token
        ) AND NOT EXISTS (
          SELECT 1 FROM runs r
          JOIN repository_migration_imports m ON m.repo_root = r.repo_root
          WHERE r.run_id = NEW.run_id
        )
        BEGIN SELECT RAISE(ABORT, 'attempt is not from the current branch lease generation'); END;`)
    }
    this.#db.exec('DROP TRIGGER IF EXISTS fence_current_remote_receipts')
    this.#db.exec(`CREATE TRIGGER IF NOT EXISTS fence_current_remote_receipts
      BEFORE INSERT ON remote_receipts
      WHEN NOT EXISTS (
        SELECT 1 FROM remote_observations o
        JOIN run_attempts a ON a.attempt_id = o.attempt_id AND a.run_id = o.run_id
        JOIN runs r ON r.run_id = o.run_id
        JOIN branch_leases l ON l.repo_root = r.repo_root AND l.branch = r.branch
        WHERE o.run_id = NEW.run_id
          AND o.observation_sha256 = NEW.authoritative_post_observation_sha256
          AND l.run_id = NEW.run_id AND l.generation_token = a.generation_token
      ) AND NOT EXISTS (
        SELECT 1 FROM runs r
        JOIN repository_migration_imports m ON m.repo_root = r.repo_root
        WHERE r.run_id = NEW.run_id
      )
      BEGIN SELECT RAISE(ABORT, 'receipt is not from the current branch lease generation'); END;`)
    for (const table of RELEASE_2_FACT_TABLES) {
      this.#db.exec(`DROP TRIGGER IF EXISTS fence_terminal_${table}`)
      this.#db.exec(`CREATE TRIGGER IF NOT EXISTS fence_terminal_${table}
        BEFORE INSERT ON ${table}
        WHEN EXISTS (
          SELECT 1 FROM runs WHERE run_id = NEW.run_id AND status != 'in-progress'
        )
        BEGIN SELECT RAISE(ABORT, 'cannot add Release 2 facts to a terminal run'); END;`)
    }
    // ponytail: nullable columns added post-release use the idempotent ALTER
    // path. Only the expected duplicate-column failure is tolerated.
    for (const [table, column] of [
      ['runs', "command_gates_json TEXT NOT NULL DEFAULT '[]'"],
      ['runs', 'initial_coordinator_identity TEXT'],
      ['stage_evidence', 'effective_policy_hash TEXT'],
      ['stage_evidence', 'base_ref_sha TEXT'],
      ['stage_evidence', 'artifact_sha256 TEXT'],
      ['stage_evidence', 'findings_json TEXT'],
      ['gate_audit', 'selected_finding_ids TEXT'],
      ['gate_audit', 'evidence_sha256 TEXT'],
      ['repository_publication_routes', 'actor_node_id TEXT'],
      ['publication_baselines', 'transport_url TEXT'],
      ['submission_admissions', 'launcher_pid INTEGER']
    ]) {
      try {
        this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`)
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/duplicate column name/i.test(error.message)
        ) {
          throw error
        }
      }
    }
    this.#db.exec(`CREATE TRIGGER IF NOT EXISTS freeze_command_gates
      BEFORE UPDATE OF command_gates_json ON runs
      BEGIN SELECT RAISE(ABORT, 'command gates are frozen at run creation'); END;`)
    this.#db.exec(`CREATE TRIGGER IF NOT EXISTS freeze_initial_coordinator_identity
      BEFORE UPDATE OF initial_coordinator_identity ON runs
      BEGIN SELECT RAISE(ABORT, 'initial coordinator identity is frozen at run creation'); END;`)
    const schemaVersion = this.#db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    if (schemaVersion.user_version < 1) {
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        this.#db.exec(`UPDATE gate_audit
          SET evidence_sha256 = (
            SELECT evidence_sha256 FROM stage_evidence
            WHERE run_id = gate_audit.run_id
              AND stage_id = gate_audit.stage_id
              AND round_index = gate_audit.round_index
            LIMIT 1
          )
          WHERE evidence_sha256 IS NULL
            AND gate_kind != 'guardrail'
            AND 1 = (
              SELECT COUNT(DISTINCT evidence_sha256) FROM stage_evidence
              WHERE run_id = gate_audit.run_id
                AND stage_id = gate_audit.stage_id
                AND round_index = gate_audit.round_index
            )`)
        this.#db.exec('PRAGMA user_version = 1')
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
    }
    if (resolved.repoRoot && resolved.legacyPath && path.resolve(resolved.legacyPath) !== path.resolve(dbPath)) {
      this.#migrateLegacyRepository(resolved.repoRoot, resolved.legacyPath)
    }
  }

  #migrateLegacyRepository(repoRoot: string, sourcePath: string): void {
    const sourcePresent = existsSync(sourcePath)
    if (sourcePresent) this.#db.prepare('ATTACH DATABASE ? AS legacy').run(sourcePath)
    const migratedSourceRunIds = (): string[] =>
      sourcePresent
        ? (this.#db.prepare(
            `SELECT source.run_id
             FROM legacy.runs AS source
             WHERE source.repo_root = ?
               AND EXISTS (
                 SELECT 1 FROM main.runs AS destination
                 WHERE destination.repo_root = ?
                   AND destination.run_id = source.run_id
               )`
          ).all(repoRoot, repoRoot) as { run_id: string }[]).map(({ run_id }) => run_id)
        : []
    const cleanupMigratedSourceRuns = (runIds: string[]): void => {
      if (runIds.length === 0) return
      const source = new DatabaseSync(sourcePath, { timeout: 5_000 })
      let cleanupTransaction = false
      try {
        source.exec('PRAGMA foreign_keys = ON')
        source.exec('BEGIN IMMEDIATE')
        cleanupTransaction = true
        const hasSubmissionAdmissions =
          source.prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'submission_admissions'"
          ).get() !== undefined
        const deleteAdmissions = hasSubmissionAdmissions
          ? source.prepare('DELETE FROM submission_admissions WHERE run_id = ?')
          : undefined
        const deleteRun = source.prepare('DELETE FROM runs WHERE repo_root = ? AND run_id = ?')
        for (const runId of runIds) {
          deleteAdmissions?.run(runId)
          deleteRun.run(repoRoot, runId)
        }
        source.exec('COMMIT')
        cleanupTransaction = false
      } catch (error) {
        if (cleanupTransaction) {
          try {
            source.exec('ROLLBACK')
          } catch {}
        }
        console.error(
          `no-mistakes: repository migration committed, but legacy archive cleanup remains pending: ${String(error)}`
        )
      } finally {
        source.close()
      }
    }
    const migrationMarker = this.#db.prepare(
      'SELECT source_present FROM repository_migrations WHERE source_path = ? AND repo_root = ?'
    )
    let transaction = false
    try {
      const marker = migrationMarker.get(sourcePath, repoRoot) as
        | { source_present: number }
        | undefined
      if (marker && (marker.source_present === 1 || !sourcePresent)) {
        if (
          marker.source_present !== 1 ||
          !sourcePresent ||
          !this.#db.prepare(
            'SELECT 1 FROM legacy.runs WHERE repo_root = ? LIMIT 1'
          ).get(repoRoot)
        ) return
        cleanupMigratedSourceRuns(migratedSourceRunIds())
        return
      }
      this.#db.exec('BEGIN IMMEDIATE')
      transaction = true
      const lockedMarker = migrationMarker.get(sourcePath, repoRoot) as
        | { source_present: number }
        | undefined
      if (lockedMarker && (lockedMarker.source_present === 1 || !sourcePresent)) {
        const runIds = lockedMarker.source_present === 1 ? migratedSourceRunIds() : []
        this.#db.exec('COMMIT')
        transaction = false
        cleanupMigratedSourceRuns(runIds)
        return
      }
      if (!sourcePresent) {
        this.#db.prepare(
          `INSERT INTO repository_migrations
             (source_path, repo_root, source_present, completed_at)
           VALUES (?, ?, 0, ?)`
        ).run(sourcePath, repoRoot, new Date().toISOString())
        this.#db.exec('COMMIT')
        transaction = false
        return
      }
      const destinationActive = this.#db.prepare(
        `SELECT r.run_id, r.status,
                EXISTS(SELECT 1 FROM main.branch_leases l WHERE l.run_id = r.run_id) AS has_lease
           FROM main.runs r
          WHERE r.repo_root = ?
            AND (r.status = 'in-progress' OR EXISTS(
              SELECT 1 FROM main.branch_leases l WHERE l.run_id = r.run_id
            ))
          ORDER BY r.created_at, r.rowid
          LIMIT 1`
      ).get(repoRoot) as
        | { has_lease: number; run_id: string; status: RunStatus }
        | undefined
      if (destinationActive) {
        const problem = destinationActive.has_lease
          ? `run ${destinationActive.run_id} still holds a live semantic lease`
          : `run ${destinationActive.run_id} is still in-progress`
        throw new DestinationActiveMigrationError(
          `cannot migrate repository state: ${problem}; finish, cancel, or recover it through the repository ledger before retrying migration`
        )
      }
      const active = this.#db.prepare(
        `SELECT r.run_id, r.status,
                EXISTS(SELECT 1 FROM legacy.branch_leases l WHERE l.run_id = r.run_id) AS has_lease
           FROM legacy.runs r
          WHERE r.repo_root = ?
            AND (r.status = 'in-progress' OR EXISTS(
              SELECT 1 FROM legacy.branch_leases l WHERE l.run_id = r.run_id
            ))
          ORDER BY r.created_at, r.rowid
          LIMIT 1`
      ).get(repoRoot) as
        | { has_lease: number; run_id: string; status: RunStatus }
        | undefined
      if (active) {
        const problem = active.has_lease
          ? `run ${active.run_id} still holds a live semantic lease`
          : `run ${active.run_id} is still in-progress`
        throw new LegacyActiveMigrationError(
          `cannot migrate repository state: ${problem}; recover it with "orca-no-mistakes prune --stranded --repo <repo>" before retrying migration`
        )
      }

      const sourceTables = new Set(
        (this.#db.prepare(
          "SELECT name FROM legacy.sqlite_master WHERE type = 'table'"
        ).all() as { name: string }[]).map(({ name }) => name)
      )
      const copy = (table: string, where: string): void => {
        if (!sourceTables.has(table)) return
        if (table === 'lease_generations') {
          this.#db.prepare(
            `INSERT INTO main.lease_generations (repo_root, next_token)
             SELECT repo_root, next_token FROM legacy.lease_generations WHERE repo_root = ?
             ON CONFLICT(repo_root) DO UPDATE SET
               next_token = MAX(main.lease_generations.next_token, excluded.next_token)`
          ).run(repoRoot)
          return
        }
        if (table === 'stage_checkpoints') {
          this.#db.prepare(
            `INSERT INTO main.stage_checkpoints (
               run_id, stage_id, round_index, input_commit_oid, output_commit_oid, created_at
             )
             SELECT source.run_id, source.stage_id, source.round_index,
                    source.input_commit_oid, source.output_commit_oid, source.created_at
             FROM legacy.stage_checkpoints AS source
             WHERE source.run_id IN (
               SELECT run_id FROM legacy.runs WHERE repo_root = ?
             ) AND NOT EXISTS (
               SELECT 1 FROM main.stage_checkpoints AS destination
               WHERE destination.run_id = source.run_id
                 AND destination.stage_id = source.stage_id
                 AND destination.round_index = source.round_index
                 AND destination.input_commit_oid = source.input_commit_oid
                 AND destination.output_commit_oid = source.output_commit_oid
                 AND destination.created_at = source.created_at
             )`
          ).run(repoRoot)
          return
        }
        if (table === 'auto_fix_mode_events') {
          this.#db.prepare(
            `INSERT INTO main.auto_fix_mode_events (run_id, enabled, source, changed_at)
             SELECT source.run_id, source.enabled, source.source, source.changed_at
             FROM legacy.auto_fix_mode_events AS source
             WHERE source.run_id IN (
               SELECT run_id FROM legacy.runs WHERE repo_root = ?
             ) AND NOT EXISTS (
               SELECT 1 FROM main.auto_fix_mode_events AS destination
               WHERE destination.run_id = source.run_id
                 AND destination.enabled = source.enabled
                 AND destination.source = source.source
                 AND destination.changed_at = source.changed_at
             )
             ORDER BY source.id`
          ).run(repoRoot)
          return
        }
        const destinationColumns = new Set(
          (this.#db.prepare(`PRAGMA main.table_info(${table})`).all() as { name: string }[])
            .map(({ name }) => name)
        )
        const columns = (this.#db.prepare(
          `PRAGMA legacy.table_info(${table})`
        ).all() as { name: string }[])
          .map(({ name }) => name)
          .filter((name) => destinationColumns.has(name) &&
            !(table === 'presentation_snapshots' && name === 'id'))
        if (columns.length === 0) return
        const names = columns.join(', ')
        const selections = columns.map((name) =>
          table === 'runs' && name === 'status'
            ? "'in-progress'"
            : table === 'runs' && name === 'completed_at'
            ? 'NULL'
            : `source.${name}`
        ).join(', ')
        const exactRow = columns.map(
          (name) => `destination.${name} IS source.${name}`
        ).join(' AND ')
        // ponytail: the destination ledger is authoritative; an older legacy
        // route for the same repository must not abort migration on the
        // repository_publication_routes primary key.
        const conflictClause = table === 'repository_publication_routes'
          ? ' ON CONFLICT(repo_root) DO NOTHING'
          : ''
        this.#db.prepare(
          `INSERT INTO main.${table} (${names})
           SELECT ${selections} FROM legacy.${table} AS source ${where}
           AND NOT EXISTS (
             SELECT 1 FROM main.${table} AS destination WHERE ${exactRow}
           )${conflictClause}`
        ).run(repoRoot)
      }

      this.#db.prepare(
        'INSERT INTO repository_migration_imports (repo_root) VALUES (?)'
      ).run(repoRoot)
      copy('repository_publication_routes', 'WHERE repo_root = ?')
      copy('runs', 'WHERE repo_root = ?')
      this.#db.prepare(
        `UPDATE main.runs SET status = 'in-progress', completed_at = NULL
         WHERE run_id IN (SELECT run_id FROM legacy.runs WHERE repo_root = ?)`
      ).run(repoRoot)
      copy('stage_plan_entries', 'WHERE run_id IN (SELECT run_id FROM legacy.runs WHERE repo_root = ?)')
      copy('branch_leases', 'WHERE repo_root = ?')
      copy('lease_generations', 'WHERE repo_root = ?')
      for (const table of [
        'resume_claims',
        'stage_dispositions',
        'stage_disposition_supersessions',
        'publication_routes',
        'publication_baselines',
        'run_attempts',
        'attempt_outcomes',
        'run_abandonments',
        'remote_observations',
        'mutation_intents',
        'resolved_mutation_intents',
        'remote_receipts',
        'stage_checkpoints',
        'stage_evidence',
        'gate_audit',
        'auto_fix_mode_events',
        'media_publications',
        'media_publication_artifacts',
        'presentation_snapshots',
        'passed_attestations'
      ]) {
        copy(table, 'WHERE run_id IN (SELECT run_id FROM legacy.runs WHERE repo_root = ?)')
      }
      const legacyStages = LEGACY_STAGE_PLAN.flatMap((stage, position) => [position, stage])
      this.#db.prepare(
        `WITH legacy_stages(position, stage_id) AS (
           VALUES ${LEGACY_STAGE_PLAN.map(() => '(?, ?)').join(', ')}
         )
         INSERT OR IGNORE INTO stage_plan_entries (run_id, position, stage_id, requirement)
         SELECT source.run_id, legacy_stages.position, legacy_stages.stage_id, 'required'
         FROM legacy.runs AS source CROSS JOIN legacy_stages
         WHERE source.repo_root = ?
           AND NOT EXISTS (
             SELECT 1 FROM main.stage_plan_entries AS retained
             WHERE retained.run_id = source.run_id
           )`
      ).run(...legacyStages, repoRoot)
      this.#db.prepare(
        `UPDATE main.runs AS destination
         SET status = (
               SELECT source.status FROM legacy.runs AS source
               WHERE source.run_id = destination.run_id
             ),
             completed_at = (
               SELECT source.completed_at FROM legacy.runs AS source
               WHERE source.run_id = destination.run_id
             )
         WHERE destination.repo_root = ?
           AND EXISTS (
             SELECT 1 FROM legacy.runs AS source
             WHERE source.run_id = destination.run_id
           )`
      ).run(repoRoot)
      const runIds = migratedSourceRunIds()
      this.#db.prepare(
        `INSERT INTO repository_migrations
           (source_path, repo_root, source_present, completed_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(source_path, repo_root) DO UPDATE SET
           source_present = excluded.source_present,
           completed_at = excluded.completed_at`
      ).run(sourcePath, repoRoot, new Date().toISOString())
      this.#db.prepare(
        'DELETE FROM repository_migration_imports WHERE repo_root = ?'
      ).run(repoRoot)
      this.#db.exec('COMMIT')
      transaction = false
      cleanupMigratedSourceRuns(runIds)
    } catch (error) {
      if (transaction) this.#db.exec('ROLLBACK')
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: (?:main\.)?runs\.run_id/i.test(error.message)
      ) {
        const conflict = this.#db.prepare(
          `SELECT source.run_id, destination.repo_root AS destination_repo_root
             FROM legacy.runs AS source
             JOIN main.runs AS destination ON destination.run_id = source.run_id
            WHERE source.repo_root = ?
            LIMIT 1`
        ).get(repoRoot) as { destination_repo_root: string; run_id: string } | undefined
        throw new RepositoryMigrationConflictError(
          `cannot migrate repository state: run ID ${conflict?.run_id ?? 'conflict'} already belongs to ${conflict?.destination_repo_root ?? 'the repository ledger'} with different history; reconcile the conflicting ledger rows before retrying migration`
        )
      }
      throw error
    } finally {
      if (sourcePresent) this.#db.exec('DETACH DATABASE legacy')
    }
  }

  tableDefinition(tableName: string): string | undefined {
    const row = this.#db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { sql: string } | undefined
    return row?.sql
  }

  get path(): string {
    return this.#path
  }

  startRun(input: {
    commandGates?: readonly CommandGate[]
    baseBranch: string
    branch: string
    coordinatorIdentity?: string
    intent: string
    policySha256: string
    repoRoot: string
    runId: string
    stagePlan?: readonly { requirement: StageRequirement; stageId: string }[]
    submissionCommitOid: string
  }): void {
    const coordinatorIdentity = input.coordinatorIdentity ?? `no-mistakes:${process.pid}`
    const coordinatorPid = Number(/^no-mistakes:([1-9]\d*)$/.exec(coordinatorIdentity)?.[1])
    if (!Number.isSafeInteger(coordinatorPid) || coordinatorPid > 2_147_483_647) {
      throw new Error('run coordinator identity must contain a verifiable local PID')
    }
    const plan = input.stagePlan ?? LEGACY_STAGE_PLAN.map((stageId) => ({
      requirement: 'required' as const,
      stageId
    }))
    const commandGates = CommandGatesSchema.parse(input.commandGates ?? [])
    const declared = commandGates.map((gate) => commandGateStage(gate.name))
    if (plan.filter((entry) => entry.stageId.startsWith('command-')).some((entry) =>
      !declared.includes(entry.stageId as `command-${string}`) || entry.requirement !== 'required') ||
      declared.some((id) => !plan.some((entry) => entry.stageId === id))) {
      throw new Error('command gates must match required frozen plan entries')
    }
    const expected = withCommandGates(plan.filter((entry) => !entry.stageId.startsWith('command-')).map((entry) => entry.stageId as CoreStageName), commandGates)
    if (expected.length !== plan.length || expected.some((stage, index) => stage !== plan[index].stageId)) {
      throw new Error('command gate order must match frozen anchors and declaration order')
    }
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db
        .prepare(
          `INSERT INTO runs (
             run_id, repo_root, branch, base_branch, initial_coordinator_identity,
             submission_commit_oid, terminal_commit_oid,
             intent, intent_hash, policy_sha256, status, created_at, completed_at, command_gates_json
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'in-progress', ?, NULL, ?)`
        )
        .run(
          input.runId,
          input.repoRoot,
          input.branch,
          input.baseBranch,
          coordinatorIdentity,
          input.submissionCommitOid,
          input.intent,
          intentHash(input.intent),
          input.policySha256,
          new Date().toISOString(),
          JSON.stringify(commandGates)
        )
      const insert = this.#db.prepare(
        `INSERT INTO stage_plan_entries (run_id, position, stage_id, requirement)
         VALUES (?, ?, ?, ?)`
      )
      for (const [position, entry] of plan.entries()) {
        insert.run(input.runId, position, entry.stageId, entry.requirement)
      }
      const route = this.repositoryPublicationRoute(input.repoRoot)
      if (route) {
        this.#recordStoredPublicationRoute(input.runId, route, input.branch, input.baseBranch)
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  commandGates(runId: string): CommandGate[] {
    const row = this.#db.prepare('SELECT command_gates_json FROM runs WHERE run_id = ?').get(runId) as { command_gates_json: string } | undefined
    if (!row) throw new Error(`run ${runId} does not exist`)
    return CommandGatesSchema.parse(JSON.parse(row.command_gates_json))
  }

  submissionAdmission(admissionId: string): SubmissionAdmissionRow | undefined {
    return this.#db
      .prepare(
        `SELECT admission_id, gate_identity, repo_root, ref_name, old_oid, new_oid,
                intent, intent_hash, source, status, lease_token, run_id,
                created_at, launched_at, launcher_pid, accepted_oid, accepted_at
         FROM submission_admissions WHERE admission_id = ?`
      )
      .get(admissionId) as SubmissionAdmissionRow | undefined
  }

  beginSubmissionAdmission(input: SubmissionAdmissionInput): SubmissionAdmissionRow {
    if (!/^admission-[0-9a-f]{64}$/.test(input.admissionId)) {
      throw new Error('submission admission ID is invalid')
    }
    const intent = normalizeIntent(input.intent)
    const hash = intentHash(intent)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#db
        .prepare(
          `SELECT admission_id, gate_identity, repo_root, ref_name, old_oid, new_oid,
                  intent, intent_hash, source, status, lease_token, run_id,
                  created_at, launched_at, launcher_pid, accepted_oid, accepted_at
           FROM submission_admissions
           WHERE admission_id = ?`
        )
        .get(input.admissionId) as SubmissionAdmissionRow | undefined
      if (existing) {
        if (
          existing.gate_identity !== input.gateIdentity ||
          existing.ref_name !== input.refName ||
          existing.new_oid !== input.newOid ||
          existing.intent_hash !== hash
        ) {
          throw new Error(`submission admission ${input.admissionId} does not match its identity`)
        }
        if (existing.status === 'failed' && existing.run_id === null) {
          const repoRoot = input.source === "gate" ? input.repoRoot : existing.repo_root
          const lease = this.#db
            .prepare(
              `SELECT admission_id FROM pending_admission_leases
               WHERE repo_root = ? AND ref_name = ?`
            )
            .get(repoRoot, input.refName) as { admission_id: string } | undefined
          if (lease && lease.admission_id !== input.admissionId) {
            throw new Error(`pending admission lease already exists for ${input.refName}`)
          }
          const now = new Date().toISOString()
          this.#db
            .prepare(
              `UPDATE submission_admissions
               SET status = 'pending', repo_root = ?, old_oid = ?, lease_token = ?,
                   launched_at = NULL, launcher_pid = NULL, accepted_oid = NULL,
                   accepted_at = NULL, source = ?
               WHERE admission_id = ?`
            )
            .run(
              repoRoot,
              input.oldOid,
              randomUUID(),
              input.source,
              input.admissionId
            )
          if (lease) {
            this.#db
              .prepare(
                 `UPDATE pending_admission_leases
                  SET acquired_at = ? WHERE repo_root = ? AND ref_name = ?`
              )
              .run(now, repoRoot, input.refName)
          } else {
            this.#db
              .prepare(
                `INSERT INTO pending_admission_leases
                 (repo_root, ref_name, admission_id, acquired_at)
                 VALUES (?, ?, ?, ?)`
              )
                .run(repoRoot, input.refName, input.admissionId, now)
          }
          this.#db.exec('COMMIT')
          return this.submissionAdmission(input.admissionId)!
        }
        this.#db.exec('COMMIT')
        return existing
      }

      const lease = this.#db
        .prepare(
          `SELECT admission_id FROM pending_admission_leases
           WHERE repo_root = ? AND ref_name = ?`
        )
        .get(input.repoRoot, input.refName) as { admission_id: string } | undefined
      if (lease && lease.admission_id !== input.admissionId) {
        throw new Error(`pending admission lease already exists for ${input.refName}`)
      }

      const now = new Date().toISOString()
      const leaseToken = randomUUID()
      this.#db
        .prepare(
          `INSERT INTO submission_admissions (
             admission_id, gate_identity, repo_root, ref_name, old_oid, new_oid,
             intent, intent_hash, source, status, lease_token, run_id,
             created_at, launched_at, accepted_oid, accepted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, NULL, NULL, NULL)`
        )
        .run(
          input.admissionId,
          input.gateIdentity,
          input.repoRoot,
          input.refName,
          input.oldOid,
          input.newOid,
          intent,
          hash,
          input.source,
          leaseToken,
          now
        )
      this.#db
        .prepare(
          `INSERT INTO pending_admission_leases
             (repo_root, ref_name, admission_id, acquired_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(input.repoRoot, input.refName, input.admissionId, now)
      this.#db.exec('COMMIT')
      return this.submissionAdmission(input.admissionId)!
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  bindSubmissionAdmission(admissionId: string, runId: string): SubmissionAdmissionRow {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.submissionAdmission(admissionId)
      if (!row) throw new Error(`unknown submission admission ${admissionId}`)
      if (row.run_id && row.run_id !== runId) {
        throw new Error(`submission admission ${admissionId} is bound to another run`)
      }
      if (row.status === 'failed' || row.status === 'superseded') {
        throw new Error(`submission admission ${admissionId} is ${row.status}`)
      }
      if (!row.run_id || row.status === 'pending') {
        this.#db
          .prepare(
            `UPDATE submission_admissions
             SET run_id = ?, status = 'launched', launched_at = COALESCE(launched_at, ?)
             WHERE admission_id = ?`
          )
          .run(runId, new Date().toISOString(), admissionId)
      }
      this.#db.exec('COMMIT')
      return this.submissionAdmission(admissionId)!
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  markSubmissionLaunched(admissionId: string, launcherPid?: number): SubmissionAdmissionRow {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.submissionAdmission(admissionId)
      if (!row) throw new Error(`unknown submission admission ${admissionId}`)
      if (row.status === 'pending') {
        this.#db
          .prepare(
            `UPDATE submission_admissions
             SET status = 'launched', launched_at = COALESCE(launched_at, ?),
                 launcher_pid = COALESCE(?, launcher_pid)
             WHERE admission_id = ?`
          )
          .run(new Date().toISOString(), launcherPid ?? null, admissionId)
      }
      this.#db.exec('COMMIT')
      return this.submissionAdmission(admissionId)!
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  reclaimSubmissionAdmission(admissionId: string): SubmissionAdmissionRow | undefined {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.submissionAdmission(admissionId)
      if (
        !row ||
        row.status === 'accepted' ||
        row.status === 'failed' ||
        row.status === 'superseded'
      ) {
        this.#db.exec('COMMIT')
        return row
      }
      this.#db
        .prepare(
          `UPDATE submission_admissions
           SET status = 'pending', run_id = NULL, launcher_pid = NULL, launched_at = NULL
           WHERE admission_id = ?`
        )
        .run(admissionId)
      const lease = this.#db
        .prepare(
          'SELECT admission_id FROM pending_admission_leases WHERE repo_root = ? AND ref_name = ?'
        )
        .get(row.repo_root, row.ref_name) as { admission_id: string } | undefined
      if (!lease) {
        this.#db
          .prepare(
            `INSERT INTO pending_admission_leases
               (repo_root, ref_name, admission_id, acquired_at)
             VALUES (?, ?, ?, ?)`
          )
          .run(row.repo_root, row.ref_name, admissionId, new Date().toISOString())
      } else if (lease.admission_id !== admissionId) {
        this.#db
          .prepare(`UPDATE submission_admissions SET status = 'superseded' WHERE admission_id = ?`)
          .run(admissionId)
      }
      this.#db.exec('COMMIT')
      return this.submissionAdmission(admissionId)!
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  markSubmissionAccepted(input: {
    acceptedOid: string
    admissionId: string
    runId: string
  }): SubmissionAdmissionRow {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.submissionAdmission(input.admissionId)
      if (!row) throw new Error(`unknown submission admission ${input.admissionId}`)
      if (row.run_id && row.run_id !== input.runId) {
        throw new Error(`submission admission ${input.admissionId} is bound to another run`)
      }
      if (row.new_oid !== input.acceptedOid) {
        throw new Error(`submission admission ${input.admissionId} accepted the wrong object`)
      }
      if (row.status === 'failed' || row.status === 'superseded') {
        throw new Error(`submission admission ${input.admissionId} is ${row.status}`)
      }
      if (row.status !== 'accepted') {
        this.#db
          .prepare(
            `UPDATE submission_admissions
             SET run_id = COALESCE(run_id, ?), status = 'accepted', accepted_oid = ?, accepted_at = ?
             WHERE admission_id = ?`
          )
          .run(input.runId, input.acceptedOid, new Date().toISOString(), input.admissionId)
        this.#db
          .prepare('DELETE FROM pending_admission_leases WHERE admission_id = ?')
          .run(input.admissionId)
      }
      this.#db.exec('COMMIT')
      return this.submissionAdmission(input.admissionId)!
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  failSubmissionAdmission(admissionId: string, status: 'failed' | 'superseded' = 'failed'): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.submissionAdmission(admissionId)
      if (!row || row.status === 'accepted') {
        this.#db.exec('COMMIT')
        return
      }
      this.#db
        .prepare(
          `UPDATE submission_admissions
           SET status = ?, launched_at = CASE WHEN run_id IS NULL THEN NULL ELSE launched_at END,
               launcher_pid = CASE WHEN run_id IS NULL THEN NULL ELSE launcher_pid END
           WHERE admission_id = ?`
        )
        .run(status, admissionId)
      this.#db
        .prepare('DELETE FROM pending_admission_leases WHERE admission_id = ?')
        .run(admissionId)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  stagePlan(runId: string): StagePlanEntryRow[] {
    return this.#db.prepare(
      `SELECT position, stage_id, requirement
       FROM stage_plan_entries WHERE run_id = ? ORDER BY position`
    ).all(runId) as StagePlanEntryRow[]
  }

  recordStageDisposition(input: {
    disposition: StageDisposition
    evidenceSha256?: string
    runId: string
    stageId: string
  }): void {
    this.#db.prepare(
      `INSERT INTO stage_dispositions
         (run_id, stage_id, disposition, evidence_sha256, recorded_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      input.runId,
      input.stageId,
      input.disposition,
      input.evidenceSha256 ?? null,
      new Date().toISOString()
    )
  }

  stageDispositions(runId: string): StageDispositionRow[] {
    return this.#db.prepare(
      `SELECT d.stage_id,
              COALESCE((SELECT s.disposition
                        FROM stage_disposition_supersessions s
                        WHERE s.run_id = d.run_id AND s.stage_id = d.stage_id
                        ORDER BY s.rowid DESC LIMIT 1), d.disposition) AS disposition,
              COALESCE((SELECT s.evidence_sha256
                        FROM stage_disposition_supersessions s
                        WHERE s.run_id = d.run_id AND s.stage_id = d.stage_id
                        ORDER BY s.rowid DESC LIMIT 1), d.evidence_sha256) AS evidence_sha256
       FROM stage_dispositions d
       JOIN stage_plan_entries p ON p.run_id = d.run_id AND p.stage_id = d.stage_id
       WHERE d.run_id = ? ORDER BY p.position`
    ).all(runId) as StageDispositionRow[]
  }

  setRepositoryPublicationRoute(input: RepositoryPublicationRouteInput): string {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const fingerprint = this.#setRepositoryPublicationRoute(input)
      this.#db.exec('COMMIT')
      return fingerprint
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #setRepositoryPublicationRoute(input: RepositoryPublicationRouteInput): string {
    // The repository route is one per repository: branches are per-run facts
    // snapshotted at startRun, so they are not part of this fingerprint.
    const fingerprint = repositoryIdentityFingerprint({
      base_repository_id: input.baseRepositoryId,
      forge_host: input.forgeHost,
      head_owner: input.headOwner,
      head_repository_id: input.headRepositoryId
    })
    const existing = this.repositoryPublicationRoute(input.repoRoot)
    if (existing && existing.route_fingerprint !== fingerprint) {
      const active = this.#db.prepare(
        `SELECT COUNT(DISTINCT r.run_id) AS count
         FROM runs r
         JOIN publication_routes p ON p.run_id = r.run_id
         WHERE p.forge_host = ? AND p.base_repository_id = ? AND p.head_repository_id = ? AND p.head_owner = ?
           AND (r.status = 'in-progress' OR (r.status = 'failed' AND EXISTS (
             SELECT 1
             FROM attempt_outcomes o
             JOIN run_attempts a ON a.run_id = o.run_id AND a.attempt_id = o.attempt_id
             WHERE o.run_id = r.run_id AND o.resume_eligible = 1
               AND a.generation_token = (
                 SELECT MAX(a2.generation_token) FROM run_attempts a2 WHERE a2.run_id = r.run_id
               )
           )))`
      ).get(
        existing.forge_host,
        existing.base_repository_id,
        existing.head_repository_id,
        existing.head_owner
      ) as { count: number }
      if (active.count > 0) {
        throw new Error(
          `cannot change publication route while ${active.count} active or resumable run(s) depend on it; this counts retained ledger state, not live processes. Use abandon --run-id <id> --reason <text> to close out a dead local run without deleting evidence`
        )
      }
    }

    const now = new Date().toISOString()
    this.#db.prepare(
      `INSERT INTO repository_publication_routes (
         repo_root, route_fingerprint, forge_host, base_repository_id,
         base_repository_node_id, base_repository_name, head_repository_id,
         head_repository_node_id, head_repository_name, network_root_repository_id,
         head_owner, head_branch, base_branch, actor_id, actor_login, actor_node_id,
         credential_source, backend, backend_version, observed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_root) DO UPDATE SET
         route_fingerprint = excluded.route_fingerprint,
         forge_host = excluded.forge_host,
         base_repository_id = excluded.base_repository_id,
         base_repository_node_id = excluded.base_repository_node_id,
         base_repository_name = excluded.base_repository_name,
         head_repository_id = excluded.head_repository_id,
         head_repository_node_id = excluded.head_repository_node_id,
         head_repository_name = excluded.head_repository_name,
         network_root_repository_id = excluded.network_root_repository_id,
         head_owner = excluded.head_owner,
         head_branch = excluded.head_branch,
         base_branch = excluded.base_branch,
         actor_id = excluded.actor_id,
         actor_login = excluded.actor_login,
         actor_node_id = excluded.actor_node_id,
         credential_source = excluded.credential_source,
         backend = excluded.backend,
         backend_version = excluded.backend_version,
         observed_at = excluded.observed_at,
         updated_at = excluded.updated_at`
    ).run(
      input.repoRoot,
      fingerprint,
      input.forgeHost,
      input.baseRepositoryId,
      input.baseRepositoryNodeId,
      input.baseRepositoryName,
      input.headRepositoryId,
      input.headRepositoryNodeId,
      input.headRepositoryName,
      input.networkRootRepositoryId,
      input.headOwner,
      input.headBranch,
      input.baseBranch,
      input.actorId,
      input.actorLogin,
      input.actorNodeId,
      input.credentialSource,
      input.backend,
      input.backendVersion,
      input.observedAt,
      now
    )
    return fingerprint
  }

  #commonDirs = new Map<string, string | undefined>()

  /**
   * The route is keyed by the repository's git common dir so every worktree
   * shares it; a worktree path is resolved to that key here.
   */
  repositoryPublicationRoute(repoRoot: string): RepositoryPublicationRouteRow | undefined {
    const select = this.#db.prepare(
      `SELECT repo_root, route_fingerprint, forge_host, base_repository_id,
              base_repository_node_id, base_repository_name, head_repository_id,
              head_repository_node_id, head_repository_name, network_root_repository_id,
              head_owner, head_branch, base_branch, actor_id, actor_login, actor_node_id,
              credential_source, backend, backend_version, observed_at, updated_at
       FROM repository_publication_routes WHERE repo_root = ?`
    )
    if (!this.#commonDirs.has(repoRoot)) {
      let commonDir: string | undefined
      try {
        commonDir = execFileSync(
          'git',
          ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
          { encoding: 'utf8', env: cleanGitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }
        ).trim()
      } catch {}
      this.#commonDirs.set(repoRoot, commonDir)
    }
    // The shared row under the git common dir wins; a worktree-keyed row from an
    // older per-worktree init only serves when no shared row exists.
    const commonDir = this.#commonDirs.get(repoRoot)
    const shared = commonDir && commonDir !== repoRoot
      ? select.get(commonDir) as RepositoryPublicationRouteRow | undefined
      : undefined
    return shared ?? (select.get(repoRoot) as RepositoryPublicationRouteRow | undefined)
  }

  recordStoredPublicationRoute(runId: string, repoRoot: string): string {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.run(runId)
      if (!run || run.repo_root !== repoRoot) {
        throw new Error(`run ${runId} does not belong to repository ${repoRoot}`)
      }
      const route = this.repositoryPublicationRoute(repoRoot)
      if (!route) throw new Error(`repository ${repoRoot} has no publication route`)
      const fingerprint = this.#recordStoredPublicationRoute(runId, route, run.branch, run.base_branch)
      this.#db.exec('COMMIT')
      return fingerprint
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #recordStoredPublicationRoute(
    runId: string,
    route: RepositoryPublicationRouteRow,
    headBranch: string,
    baseBranch: string
  ): string {
    return this.recordPublicationRoute({
      baseBranch,
      baseRepositoryId: route.base_repository_id,
      forgeHost: route.forge_host,
      headBranch,
      headOwner: route.head_owner,
      headRepositoryId: route.head_repository_id,
      runId
    })
  }

  recordPublicationRoute(input: {
    baseBranch: string
    baseRepositoryId: string
    forgeHost: string
    headBranch: string
    headOwner: string
    headRepositoryId: string
    runId: string
  }): string {
    const route = {
      baseBranch: input.baseBranch,
      baseRepositoryId: input.baseRepositoryId,
      forgeHost: input.forgeHost,
      headBranch: input.headBranch,
      headOwner: input.headOwner,
      headRepositoryId: input.headRepositoryId
    }
    const fingerprint = sha256(canonicalJson(route))
    this.#db.prepare(
      `INSERT INTO publication_routes (
         run_id, route_fingerprint, forge_host, base_repository_id, head_repository_id,
         head_owner, head_branch, base_branch, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.runId,
      fingerprint,
      input.forgeHost,
      input.baseRepositoryId,
      input.headRepositoryId,
      input.headOwner,
      input.headBranch,
      input.baseBranch,
      new Date().toISOString()
    )
    return fingerprint
  }

  publicationRoute(runId: string): {
    base_branch: string
    base_repository_id: string
    forge_host: string
    head_branch: string
    head_owner: string
    head_repository_id: string
    route_fingerprint: string
  } | undefined {
    return this.#db.prepare(
      `SELECT route_fingerprint, forge_host, base_repository_id, head_repository_id,
              head_owner, head_branch, base_branch
       FROM publication_routes WHERE run_id = ?`
    ).get(runId) as ReturnType<DomainLedger['publicationRoute']>
  }

  recordPublicationBaseline(input: {
    headCommitOid: string | null
    observedAt: string
    routeFingerprint: string
    runId: string
    transportUrl: string
  }): void {
    const route = this.publicationRoute(input.runId)
    if (!route || route.route_fingerprint !== input.routeFingerprint) {
      throw new Error(`run ${input.runId} has no matching publication route`)
    }
    if (input.transportUrl.trim() === '') {
      throw new Error(`run ${input.runId} publication baseline requires a transport URL`)
    }
    this.#db.prepare(
      `INSERT INTO publication_baselines (
         run_id, route_fingerprint, transport_url, head_commit_oid, authoritative_absence, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      input.runId,
      input.routeFingerprint,
      input.transportUrl,
      input.headCommitOid,
      input.headCommitOid === null ? 1 : 0,
      input.observedAt
    )
  }

  publicationBaseline(runId: string): {
    authoritative_absence: number
    head_commit_oid: string | null
    observed_at: string
    route_fingerprint: string
    transport_url: string | null
  } | undefined {
    return this.#db.prepare(
      `SELECT route_fingerprint, transport_url, head_commit_oid, authoritative_absence, observed_at
       FROM publication_baselines WHERE run_id = ?`
    ).get(runId) as ReturnType<DomainLedger['publicationBaseline']>
  }

  startAttempt(input: {
    actorIdentity: string
    attemptId: string
    coordinatorIdentity: string
    generationToken: number
    runId: string
    startedAt: string
  }): void {
    this.#db.prepare(
      `INSERT INTO run_attempts (
         attempt_id, run_id, generation_token, coordinator_identity, actor_identity, started_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      input.attemptId,
      input.runId,
      input.generationToken,
      input.coordinatorIdentity,
      input.actorIdentity,
      input.startedAt
    )
  }

  recordAttemptOutcome(input: AttemptOutcomeInput): string {
    const attempt = this.#db.prepare(
      `SELECT run_id, actor_identity, coordinator_identity
       FROM run_attempts WHERE attempt_id = ?`
    ).get(input.attemptId) as
      | { actor_identity: string; coordinator_identity: string; run_id: string }
      | undefined
    if (attempt?.run_id !== input.runId) {
      throw new Error(`attempt ${input.attemptId} does not belong to run ${input.runId}`)
    }
    if (attempt.actor_identity !== input.actorIdentity ||
        attempt.coordinator_identity !== input.coordinatorIdentity) {
      throw new Error(`attempt ${input.attemptId} identity does not match its outcome`)
    }
    const outcomeSha256 = attemptOutcomeSha256(input)
    this.#db.prepare(
      `INSERT INTO attempt_outcomes (
         outcome_id, attempt_id, run_id, verdict, stopping_fact, reason, candidate_commit_oid,
         coordinator_identity, actor_identity, custody_json, receipt_digests_json,
         resume_eligible, completed_at, outcome_sha256
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      input.attemptId,
      input.runId,
      input.verdict,
      input.stoppingFact,
      input.reason,
      input.candidateCommitOid,
      input.coordinatorIdentity,
      input.actorIdentity,
      canonicalJson(input.custody),
      canonicalJson(input.receiptDigests),
      input.resumeEligible ? 1 : 0,
      input.completedAt,
      outcomeSha256
    )
    return outcomeSha256
  }

  listAttemptOutcomes(runId: string): { outcome_sha256: string }[] {
    return this.#db.prepare(
      `SELECT o.outcome_sha256
       FROM attempt_outcomes o
       JOIN run_attempts a ON a.run_id = o.run_id AND a.attempt_id = o.attempt_id
       WHERE o.run_id = ? ORDER BY a.generation_token, o.rowid`
    ).all(runId) as { outcome_sha256: string }[]
  }

  recordRemoteObservation(input: {
    attemptId: string
    kind: string
    observedAt: string
    payload: Record<string, unknown>
    runId: string
    subject: string
  }): string {
    const observation = {
      attemptId: input.attemptId,
      kind: input.kind,
      observedAt: input.observedAt,
      payload: input.payload,
      runId: input.runId,
      subject: input.subject
    }
    const observationSha256 = sha256(canonicalJson(observation))
    this.#db.prepare(
      `INSERT INTO remote_observations (
         observation_id, run_id, attempt_id, kind, subject, payload_json,
         observed_at, observation_sha256
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      input.runId,
      input.attemptId,
      input.kind,
      input.subject,
      canonicalJson(input.payload),
      input.observedAt,
      observationSha256
    )
    return observationSha256
  }

  listRemoteObservations(runId: string): { observation_sha256: string }[] {
    return this.#db.prepare(
      `SELECT observation_sha256 FROM remote_observations
       WHERE run_id = ? ORDER BY observed_at, rowid`
    ).all(runId) as { observation_sha256: string }[]
  }

  remoteObservation(
    runId: string,
    observationSha256: string
  ): { kind: string; payload: Record<string, unknown>; subject: string } | undefined {
    const row = this.#db.prepare(
      `SELECT kind, payload_json, subject FROM remote_observations
       WHERE run_id = ? AND observation_sha256 = ?`
    ).get(runId, observationSha256) as
      | { kind: string; payload_json: string; subject: string }
      | undefined
    if (!row) return undefined
    return {
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      subject: row.subject
    }
  }

  recordMutationIntent(input: {
    attemptId: string
    createdAt: string
    kind: 'candidate-publication' | 'managed-comment' | 'pull-request'
    payload: Record<string, unknown>
    runId: string
    targetFingerprint: string
  }): string {
    const mutation = {
      attemptId: input.attemptId,
      createdAt: input.createdAt,
      kind: input.kind,
      payload: input.payload,
      runId: input.runId,
      targetFingerprint: input.targetFingerprint
    }
    const intentSha256 = sha256(canonicalJson(mutation))
    this.#db.prepare(
      `INSERT INTO mutation_intents (
         mutation_intent_id, run_id, attempt_id, kind, target_fingerprint,
         payload_json, created_at, intent_sha256
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      input.runId,
      input.attemptId,
      input.kind,
      input.targetFingerprint,
      canonicalJson(input.payload),
      input.createdAt,
      intentSha256
    )
    return intentSha256
  }

  listMutationIntents(runId: string): { intent_sha256: string }[] {
    return this.#db.prepare(
      'SELECT intent_sha256 FROM mutation_intents WHERE run_id = ? ORDER BY created_at, rowid'
    ).all(runId) as { intent_sha256: string }[]
  }

  resolveMutationIntent(input: {
    attemptId: string
    intentSha256: string
    reason: 'definite-failure' | 'lease-lost' | 'reconciled'
    runId: string
  }): void {
    const belongsToRun = this.#db.prepare(
      `SELECT 1
       FROM mutation_intents m
       JOIN run_attempts a ON a.run_id = m.run_id AND a.attempt_id = m.attempt_id
       WHERE m.run_id = ? AND m.intent_sha256 = ? AND m.attempt_id = ?`
    ).get(input.runId, input.intentSha256, input.attemptId)
    if (!belongsToRun) {
      throw new Error('mutation intent resolution does not belong to the run and attempt')
    }
    const existing = this.#db.prepare(
      `SELECT reason
       FROM resolved_mutation_intents
       WHERE run_id = ? AND intent_sha256 = ?`
    ).get(input.runId, input.intentSha256) as
      | { reason: string }
      | undefined
    if (existing) {
      if (existing.reason === input.reason) return
      throw new Error('mutation intent already has a different resolution')
    }
    this.#db.prepare(
      `INSERT INTO resolved_mutation_intents (
         resolution_id, run_id, attempt_id, intent_sha256, reason, resolved_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      input.runId,
      input.attemptId,
      input.intentSha256,
      input.reason,
      new Date().toISOString()
    )
  }

  unresolvedManagedCommentCreateIntent(runId: string): {
    attemptId: string
    createdAt: string
    intentSha256: string
    payload: Record<string, unknown>
    targetFingerprint: string
  } | undefined {
    const settledReceipts = this.#db.prepare(
      `SELECT receipt_json
       FROM remote_receipts
       WHERE run_id = ? AND kind = 'pull-request-binding'`
    ).all(runId) as Array<{
      receipt_json: string
    }>

    const resolvedIntents = new Set<string>()
    const resolvedRows = this.#db.prepare(
      `SELECT intent_sha256 FROM resolved_mutation_intents WHERE run_id = ?`
    ).all(runId) as Array<{ intent_sha256: string }>
    for (const r of resolvedRows) {
      resolvedIntents.add(r.intent_sha256)
    }
    for (const receipt of settledReceipts) {
      try {
        const parsed = JSON.parse(receipt.receipt_json) as {
          managedCommentIntent?: unknown
          payload?: { managedCommentIntent?: unknown }
        }
        const intent = typeof parsed?.managedCommentIntent === 'string'
          ? parsed.managedCommentIntent
          : typeof parsed?.payload?.managedCommentIntent === 'string'
          ? parsed.payload.managedCommentIntent
          : undefined
        if (intent) {
          resolvedIntents.add(intent)
        }
      } catch {
        // ignore malformed
      }
    }

    const rows = this.#db.prepare(
      `SELECT m.attempt_id, m.created_at, m.intent_sha256, m.payload_json, m.target_fingerprint,
              a.generation_token, m.rowid
       FROM mutation_intents m
       JOIN run_attempts a ON a.attempt_id = m.attempt_id AND a.run_id = m.run_id
       WHERE m.run_id = ? AND m.kind = 'managed-comment'
       ORDER BY a.generation_token ASC, m.rowid ASC`
    ).all(runId) as Array<{
      attempt_id: string
      created_at: string
      intent_sha256: string
      payload_json: string
      rowid: number | bigint
      target_fingerprint: string
    }>

    for (const row of rows) {
      if (resolvedIntents.has(row.intent_sha256)) {
        continue
      }
      try {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>
        if (payload.action === 'ensure-managed-summary' && payload.managedCommentNodeId === null) {
          return {
            attemptId: row.attempt_id,
            createdAt: row.created_at,
            intentSha256: row.intent_sha256,
            payload,
            targetFingerprint: row.target_fingerprint
          }
        }
      } catch {
        // ignore malformed
      }
    }
    return undefined
  }

  publishedPullRequestContent(
    runId: string,
    candidateCommitOid?: string
  ): { body: string; title: string } | undefined {
    const route = this.publicationRoute(runId)
    if (!route) return undefined
    const rows = this.#db.prepare(
      `SELECT m.payload_json
       FROM mutation_intents m
       JOIN run_attempts a ON a.attempt_id = m.attempt_id AND a.run_id = m.run_id
       WHERE m.run_id = ? AND m.kind = 'pull-request' AND m.target_fingerprint = ?
       ORDER BY a.generation_token DESC, m.rowid DESC`
    ).all(runId, route.route_fingerprint) as Array<{ payload_json: string }>
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>
        if (
          payload.action === 'ensure-body-and-await-merge' &&
          typeof payload.title === 'string' &&
          typeof payload.body === 'string' &&
          (!candidateCommitOid || payload.candidateCommitOid === candidateCommitOid)
        ) {
          return { body: payload.body, title: payload.title }
        }
      } catch {
      }
    }
    return undefined
  }

  #remoteObservationMatches(input: {
    allowHistoricalAttempt?: boolean
    candidateCommitOid: string
    kind: RemoteReceiptKind
    observationSha256: string
    receiptPayload: Record<string, unknown>
    runId: string
  }): boolean {
    const route = this.publicationRoute(input.runId)
    if (!route || input.receiptPayload.routeFingerprint !== route.route_fingerprint) return false
    const observation = this.#db.prepare(
      `SELECT o.attempt_id, o.kind, o.subject, o.payload_json, o.observed_at, a.generation_token
       FROM remote_observations o
       JOIN run_attempts a ON a.attempt_id = o.attempt_id AND a.run_id = o.run_id
       WHERE o.run_id = ? AND o.observation_sha256 = ?`
    ).get(input.runId, input.observationSha256) as
      | {
          attempt_id: string
          generation_token: number | bigint
          kind: string
          observed_at: string
          payload_json: string
          subject: string
        }
      | undefined
    if (!observation) return false
    if (!input.allowHistoricalAttempt) {
      const latest = this.#db.prepare(
        'SELECT MAX(generation_token) AS generation_token FROM run_attempts WHERE run_id = ?'
      ).get(input.runId) as { generation_token: number | bigint | null }
      if (latest.generation_token === null ||
          Number(observation.generation_token) !== Number(latest.generation_token)) return false
    }
    const baseline = this.publicationBaseline(input.runId)
    if (!baseline || baseline.route_fingerprint !== route.route_fingerprint) return false
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(observation.payload_json) as Record<string, unknown>
    } catch {
      return false
    }
    if (sha256(canonicalJson({
      attemptId: observation.attempt_id,
      kind: observation.kind,
      observedAt: observation.observed_at,
      payload,
      runId: input.runId,
      subject: observation.subject
    })) !== input.observationSha256) return false
    if (input.kind === 'candidate-publication') {
      const receipt = input.receiptPayload
      if (!hasOnlyOwnProperties(receipt, new Set([
        'mutationIntent', 'outcome', 'postRead', 'preRead', 'routeFingerprint'
      ])) ||
          !['created', 'updated', 'unchanged'].includes(String(receipt.outcome)) ||
          typeof receipt.preRead !== 'string' || typeof receipt.mutationIntent !== 'string' ||
          receipt.postRead !== input.observationSha256) return false
      const preRead = this.#db.prepare(
        `SELECT attempt_id, kind, subject, payload_json, observed_at
         FROM remote_observations WHERE run_id = ? AND observation_sha256 = ?`
      ).get(input.runId, receipt.preRead) as
        | { attempt_id: string; kind: string; observed_at: string; payload_json: string; subject: string }
        | undefined
      const mutation = this.#db.prepare(
        `SELECT attempt_id, kind, target_fingerprint, payload_json, created_at
         FROM mutation_intents WHERE run_id = ? AND intent_sha256 = ?`
      ).get(input.runId, receipt.mutationIntent) as
        | {
            attempt_id: string
            created_at: string
            kind: string
            payload_json: string
            target_fingerprint: string
          }
        | undefined
      if (!preRead || !mutation || preRead.attempt_id !== observation.attempt_id ||
          mutation.attempt_id !== observation.attempt_id ||
          mutation.kind !== 'candidate-publication' ||
          mutation.target_fingerprint !== route.route_fingerprint ||
          preRead.observed_at > mutation.created_at || mutation.created_at > observation.observed_at) {
        return false
      }
      let prePayload: Record<string, unknown>
      let mutationPayload: Record<string, unknown>
      try {
        prePayload = JSON.parse(preRead.payload_json) as Record<string, unknown>
        mutationPayload = JSON.parse(mutation.payload_json) as Record<string, unknown>
      } catch {
        return false
      }
      if (sha256(canonicalJson({
        attemptId: preRead.attempt_id,
        kind: preRead.kind,
        observedAt: preRead.observed_at,
        payload: prePayload,
        runId: input.runId,
        subject: preRead.subject
      })) !== receipt.preRead || sha256(canonicalJson({
        attemptId: mutation.attempt_id,
        createdAt: mutation.created_at,
        kind: mutation.kind,
        payload: mutationPayload,
        runId: input.runId,
        targetFingerprint: mutation.target_fingerprint
      })) !== receipt.mutationIntent) return false
      const subject = `${route.forge_host}/${route.head_repository_id}:refs/heads/${route.head_branch}`
      const routeFactsMatch = (candidate: Record<string, unknown>): boolean =>
        candidate.forgeHost === route.forge_host &&
        candidate.repositoryId === route.head_repository_id &&
        candidate.headOwner === route.head_owner &&
        candidate.headBranch === route.head_branch
      const preReadMatchesBaseline = baseline.authoritative_absence === 1
        ? hasOnlyOwnProperties(prePayload, new Set([
            'forgeHost', 'headBranch', 'headOwner', 'repositoryId', 'state'
          ])) && prePayload.state === 'absent'
        : hasOnlyOwnProperties(prePayload, new Set([
            'forgeHost', 'headBranch', 'headOwner', 'oid', 'repositoryId'
          ])) && prePayload.oid === baseline.head_commit_oid
      const reconciled = mutationPayload.reconciled === true
      const preReadMatchesCandidate = hasOnlyOwnProperties(prePayload, new Set([
        'forgeHost', 'headBranch', 'headOwner', 'oid', 'repositoryId'
      ])) && prePayload.oid === input.candidateCommitOid
      return preRead.kind === 'publication-head' && preRead.subject === subject &&
        observation.kind === 'publication-head' && observation.subject === subject &&
        routeFactsMatch(prePayload) && routeFactsMatch(payload) &&
        (preReadMatchesBaseline || (reconciled && preReadMatchesCandidate)) &&
        receipt.outcome === (reconciled && !preReadMatchesBaseline
          ? 'unchanged'
          : baseline.authoritative_absence === 1
          ? 'created'
          : baseline.head_commit_oid === input.candidateCommitOid
          ? 'unchanged'
          : 'updated') &&
        hasOnlyOwnProperties(payload, new Set([
          'forgeHost', 'headBranch', 'headOwner', 'oid', 'repositoryId'
        ])) && payload.oid === input.candidateCommitOid &&
        hasOnlyOwnProperties(mutationPayload, new Set(['expected', 'reconciled', 'update'])) &&
        mutationPayload.expected === (baseline.authoritative_absence === 1
          ? 'absent'
          : baseline.head_commit_oid) &&
        mutationPayload.update === input.candidateCommitOid
    }
    const receipt = input.receiptPayload
    const hasManagedComment = Object.hasOwn(receipt, 'managedCommentIntent')
    const hasBodyReport = Object.hasOwn(receipt, 'bodySha256')
    const hasPipelineEvidenceRoot = Object.hasOwn(receipt, 'pipelineEvidenceRoot')
    if (hasManagedComment && hasBodyReport) return false
    if ((hasManagedComment || hasBodyReport) !== hasPipelineEvidenceRoot) return false
    if (!hasOnlyOwnProperties(receipt, new Set([
      ...(hasManagedComment ? ['managedCommentIntent'] : []),
      ...(hasBodyReport ? ['bodySha256', 'state', 'titleSha256'] : []),
      ...(hasPipelineEvidenceRoot ? ['pipelineEvidenceRoot'] : []),
      'mutationIntent', 'number', 'outcome', 'postRead', 'routeFingerprint'
    ])) || !Number.isInteger(receipt.number) || Number(receipt.number) <= 0 ||
      !['created', 'updated', 'unchanged'].includes(String(receipt.outcome)) ||
      (hasManagedComment && typeof receipt.managedCommentIntent !== 'string') ||
      (hasPipelineEvidenceRoot &&
        (typeof receipt.pipelineEvidenceRoot !== 'string' ||
          !/^[0-9a-f]{64}$/.test(receipt.pipelineEvidenceRoot))) ||
      (hasBodyReport &&
        (typeof receipt.bodySha256 !== 'string' || !HEX_64.test(receipt.bodySha256) ||
          typeof receipt.titleSha256 !== 'string' || !HEX_64.test(receipt.titleSha256) ||
          (receipt.state !== 'merged' && receipt.state !== 'open'))) ||
      typeof receipt.mutationIntent !== 'string' ||
      receipt.postRead !== input.observationSha256) return false
    const mutation = this.#db.prepare(
      `SELECT attempt_id, kind, target_fingerprint, payload_json, created_at
       FROM mutation_intents WHERE run_id = ? AND intent_sha256 = ?`
    ).get(input.runId, receipt.mutationIntent) as
      | {
          attempt_id: string
          created_at: string
          kind: string
          payload_json: string
          target_fingerprint: string
        }
      | undefined
    const managedCommentMutation = hasManagedComment ? this.#db.prepare(
      `SELECT attempt_id, kind, target_fingerprint, payload_json, created_at
       FROM mutation_intents WHERE run_id = ? AND intent_sha256 = ?`
    ).get(input.runId, String(receipt.managedCommentIntent)) as
      | {
          attempt_id: string
          created_at: string
          kind: string
          payload_json: string
          target_fingerprint: string
        }
      | undefined : undefined
    const publication = this.remoteReceipt(input.runId, 'candidate-publication')
    if (!mutation || !publication ||
        publication.candidate_commit_oid !== input.candidateCommitOid ||
        mutation.attempt_id !== observation.attempt_id || mutation.kind !== 'pull-request' ||
        mutation.target_fingerprint !== route.route_fingerprint ||
        (hasManagedComment && (!managedCommentMutation ||
          managedCommentMutation.attempt_id !== observation.attempt_id ||
          managedCommentMutation.kind !== 'managed-comment' ||
          managedCommentMutation.target_fingerprint !== route.route_fingerprint ||
          managedCommentMutation.created_at > observation.observed_at)) ||
        mutation.created_at > observation.observed_at) return false
    let mutationPayload: Record<string, unknown>
    let managedCommentPayload: Record<string, unknown>
    try {
      mutationPayload = JSON.parse(mutation.payload_json) as Record<string, unknown>
      managedCommentPayload = managedCommentMutation
        ? JSON.parse(managedCommentMutation.payload_json) as Record<string, unknown>
        : {}
    } catch {
      return false
    }
    if (sha256(canonicalJson({
      attemptId: mutation.attempt_id,
      createdAt: mutation.created_at,
      kind: mutation.kind,
      payload: mutationPayload,
      runId: input.runId,
      targetFingerprint: mutation.target_fingerprint
    })) !== receipt.mutationIntent || (managedCommentMutation && sha256(canonicalJson({
      attemptId: managedCommentMutation.attempt_id,
      createdAt: managedCommentMutation.created_at,
      kind: managedCommentMutation.kind,
      payload: managedCommentPayload,
      runId: input.runId,
      targetFingerprint: managedCommentMutation.target_fingerprint
    })) !== receipt.managedCommentIntent)) return false
    const routeFacts = {
      baseBranch: route.base_branch,
      baseRepositoryId: route.base_repository_id,
      candidateCommitOid: input.candidateCommitOid,
      forgeHost: route.forge_host,
      headBranch: route.head_branch,
      headOwner: route.head_owner,
      headRepositoryId: route.head_repository_id
    }
    const commonMatch = observation.kind === 'pull-request' &&
      observation.subject === `${route.forge_host}/${route.base_repository_id}#${String(receipt.number)}` &&
      Object.entries(routeFacts).every(([key, value]) =>
        payload[key] === value && mutationPayload[key] === value
      ) && payload.number === receipt.number
    if (!commonMatch) return false
    if (hasBodyReport) {
      return payload.state === receipt.state && mutationPayload.action === 'ensure-body-and-await-merge' &&
        payload.bodySha256 === receipt.bodySha256 &&
        payload.titleSha256 === receipt.titleSha256 &&
        hasOnlyOwnProperties(payload, new Set([
          ...Object.keys(routeFacts), 'bodySha256', 'number', 'pullRequestNodeId', 'state', 'titleSha256'
        ])) && hasOnlyOwnProperties(mutationPayload, new Set([
          ...Object.keys(routeFacts), 'action', 'body', 'title'
        ])) &&
        typeof payload.pullRequestNodeId === 'string' && payload.pullRequestNodeId !== '' &&
        sha256(String(mutationPayload.body)) === receipt.bodySha256 &&
        sha256(String(mutationPayload.title)) === receipt.titleSha256
    }
    if (payload.state !== 'open' || mutationPayload.action !== 'ensure-open') return false
    if (!hasManagedComment) {
      return hasOnlyOwnProperties(payload, new Set([
        ...Object.keys(routeFacts), 'number', 'state'
      ])) && hasOnlyOwnProperties(mutationPayload, new Set([
        ...Object.keys(routeFacts), 'action'
      ]))
    }
    return hasOnlyOwnProperties(payload, new Set([
      ...Object.keys(routeFacts), 'managedCommentBodySha256', 'managedCommentNodeId',
      'number', 'pullRequestNodeId', 'state'
    ])) && hasOnlyOwnProperties(mutationPayload, new Set([
      ...Object.keys(routeFacts), 'action', 'body', 'title'
    ])) &&
      hasOnlyOwnProperties(managedCommentPayload, new Set([
        'action', 'bodySha256', 'managedCommentNodeId', 'number'
      ])) &&
      typeof payload.pullRequestNodeId === 'string' && payload.pullRequestNodeId !== '' &&
      typeof payload.managedCommentNodeId === 'string' && payload.managedCommentNodeId !== '' &&
      typeof payload.managedCommentBodySha256 === 'string' &&
      HEX_64.test(payload.managedCommentBodySha256) &&
      managedCommentPayload.action === 'ensure-managed-summary' &&
      managedCommentPayload.bodySha256 === payload.managedCommentBodySha256 &&
      (managedCommentPayload.managedCommentNodeId === null ||
        managedCommentPayload.managedCommentNodeId === payload.managedCommentNodeId) &&
      managedCommentPayload.number === receipt.number
  }

  settleRemoteStage(input: {
    checkpoint: {
      inputCommitOid: string
      outputCommitOid: string
      roundIndex: number
    }
    evidence: RecordEvidenceInput
    receipt: {
      authoritativePostObservationSha256: string
      candidateCommitOid: string
      kind: RemoteReceiptKind
      payload: Record<string, unknown>
    }
    runId: string
    stageId: 'pr' | 'push'
    supersedesEvidenceSha256?: string
    ownership: { branch: string; generationToken: number; repoRoot: string }
  }): { evidenceId: string; receiptSha256: string } {
    const expectedKind: RemoteReceiptKind =
      input.stageId === 'push' ? 'candidate-publication' : 'pull-request-binding'
    if (input.receipt.kind !== expectedKind) {
      throw new Error(`${input.stageId} requires a ${expectedKind} receipt`)
    }
    if (
      input.evidence.runId !== input.runId ||
      input.evidence.stageId !== input.stageId ||
      input.evidence.candidateCommitOid !== input.receipt.candidateCommitOid ||
      input.checkpoint.inputCommitOid !== input.receipt.candidateCommitOid ||
      input.checkpoint.outputCommitOid !== input.receipt.candidateCommitOid
    ) {
      throw new Error(`${input.stageId} receipt, evidence, and checkpoint must bind the same candidate`)
    }
    const expectedEvidenceSha256 = evidenceSha256({
      artifactSha256: input.evidence.artifactSha256,
      baseCommitOid: input.evidence.baseCommitOid,
      candidateCommitOid: input.evidence.candidateCommitOid,
      exitCode: input.evidence.exitCode,
      round: input.evidence.roundIndex,
      runId: input.runId,
      stage: input.stageId,
      summary: input.evidence.summary,
      workerIdentity: input.evidence.workerIdentity
    })
    if (input.evidence.evidenceSha256 !== expectedEvidenceSha256) {
      throw new Error(`${input.stageId} evidence digest does not match its recorded fields`)
    }
    if (!this.#remoteObservationMatches({
      candidateCommitOid: input.receipt.candidateCommitOid,
      kind: input.receipt.kind,
      observationSha256: input.receipt.authoritativePostObservationSha256,
      receiptPayload: input.receipt.payload,
      runId: input.runId
    })) {
      throw new Error(`${input.stageId} receipt does not match its authoritative post-read observation`)
    }

    const receiptJson = canonicalJson(input.receipt.payload)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      if (!this.ownsLease(input.runId, input.ownership)) {
        throw new Error(`run ${input.runId} no longer owns its branch lease`)
      }
      const existingEvidence = this.#db.prepare(
        `SELECT evidence_id
         FROM stage_evidence
         WHERE run_id = ? AND stage_id = ? AND round_index = ?
           AND candidate_commit_oid = ? AND base_commit_oid = ?
           AND worker_identity = ? AND exit_code = ? AND evidence_sha256 = ?
           AND artifact_path = ? AND artifact_sha256 IS ? AND summary = ?
           AND findings_json IS ? AND effective_policy_hash IS ? AND base_ref_sha IS ?
         LIMIT 1`
      ).get(
        input.runId,
        input.stageId,
        input.evidence.roundIndex,
        input.evidence.candidateCommitOid,
        input.evidence.baseCommitOid,
        input.evidence.workerIdentity,
        input.evidence.exitCode,
        input.evidence.evidenceSha256,
        input.evidence.artifactPath,
        input.evidence.artifactSha256,
        input.evidence.summary,
        input.evidence.findingsJson ?? null,
        input.evidence.effectivePolicyHash ?? null,
        input.evidence.baseRefSha ?? null
      ) as { evidence_id: string } | undefined
      const existingCheckpoint = this.#db.prepare(
        `SELECT 1
         FROM stage_checkpoints
         WHERE run_id = ? AND stage_id = ? AND round_index = ?
           AND input_commit_oid = ? AND output_commit_oid = ?
         LIMIT 1`
      ).get(
        input.runId,
        input.stageId,
        input.checkpoint.roundIndex,
        input.checkpoint.inputCommitOid,
        input.checkpoint.outputCommitOid
      )
      const existingReceipt = this.#db.prepare(
        `SELECT receipt_sha256
         FROM remote_receipts
         WHERE run_id = ? AND kind = ? AND candidate_commit_oid = ?
           AND authoritative_post_observation_sha256 = ? AND receipt_json = ?
         ORDER BY rowid DESC
         LIMIT 1`
      ).get(
        input.runId,
        input.receipt.kind,
        input.receipt.candidateCommitOid,
        input.receipt.authoritativePostObservationSha256,
        receiptJson
      ) as { receipt_sha256: string } | undefined
      const existingDisposition = this.#db.prepare(
        `SELECT 1 FROM stage_dispositions
         WHERE run_id = ? AND stage_id = ? AND disposition = 'satisfied'
           AND evidence_sha256 = ?`
      ).get(input.runId, input.stageId, input.evidence.evidenceSha256)
      const priorDispositionRow = this.#db.prepare(
        `SELECT COALESCE((SELECT s.disposition FROM stage_disposition_supersessions s
                          WHERE s.run_id = d.run_id AND s.stage_id = d.stage_id
                          ORDER BY s.rowid DESC LIMIT 1), d.disposition) AS disposition,
                COALESCE((SELECT s.evidence_sha256 FROM stage_disposition_supersessions s
                          WHERE s.run_id = d.run_id AND s.stage_id = d.stage_id
                          ORDER BY s.rowid DESC LIMIT 1), d.evidence_sha256) AS evidence_sha256
         FROM stage_dispositions d WHERE d.run_id = ? AND d.stage_id = ? LIMIT 1`
      ).get(input.runId, input.stageId) as { disposition: string; evidence_sha256: string } | undefined
      const priorDisposition = priorDispositionRow !== undefined ? 1 : undefined
      // An open binding settles pr; the ci stage later upgrades the same
      // candidate's receipt to merged through the supersession path below.
      const settlesDisposition = input.stageId !== 'pr' ||
        input.receipt.payload.state === 'merged' ||
        input.receipt.payload.state === 'open' ||
        (Object.hasOwn(input.receipt.payload, 'managedCommentIntent') &&
          (input.evidence.roundIndex === 0 || priorDisposition === undefined))
      const priorEvidence = this.#db.prepare(
        'SELECT 1 FROM stage_evidence WHERE run_id = ? AND stage_id = ? AND round_index = ? LIMIT 1'
      ).get(input.runId, input.stageId, input.evidence.roundIndex)
      const priorCheckpoint = this.#db.prepare(
        'SELECT 1 FROM stage_checkpoints WHERE run_id = ? AND stage_id = ? AND round_index = ? LIMIT 1'
      ).get(input.runId, input.stageId, input.checkpoint.roundIndex)
      if (priorEvidence !== undefined || priorCheckpoint !== undefined) {
        if (existingEvidence && existingCheckpoint && existingReceipt &&
            (!settlesDisposition || existingDisposition)) {
          this.#db.exec('COMMIT')
          return {
            evidenceId: existingEvidence.evidence_id,
            receiptSha256: existingReceipt.receipt_sha256
          }
        }
        throw new Error(`${input.stageId} round ${input.checkpoint.roundIndex} is already settled with different facts`)
      }
      let isHistoricalPrUpgrade = false
      if (
        settlesDisposition &&
        priorDispositionRow !== undefined &&
        existingDisposition === undefined &&
        input.stageId === 'pr' &&
        (input.receipt.payload.state === 'merged' ||
          (input.receipt.payload.state === 'open' && typeof input.receipt.payload.bodySha256 === 'string')) &&
        priorDispositionRow.disposition === 'satisfied'
      ) {
        const priorPrReceipt = this.#db.prepare(
          `SELECT receipt_json, candidate_commit_oid FROM remote_receipts
           WHERE run_id = ? AND kind = 'pull-request-binding'
           ORDER BY rowid DESC LIMIT 1`
        ).get(input.runId) as { receipt_json: string; candidate_commit_oid: string } | undefined
        if (priorPrReceipt) {
          const parsedReceipt = JSON.parse(priorPrReceipt.receipt_json) as Record<string, unknown>
          const priorPayload = (parsedReceipt.payload as Record<string, unknown> | undefined) ?? parsedReceipt
          const priorManagedComment = priorPayload && (
            Object.hasOwn(priorPayload, 'managedCommentIntent') ||
            priorPayload.managedCommentNodeId !== undefined
          ) && priorPayload.state !== 'open' && priorPayload.state !== 'merged'
          const isManagedComment = input.receipt.payload.state === 'merged'
            ? priorManagedComment || (priorPayload && priorPayload.state === 'open')
            : priorManagedComment
          const matchesSuperseded =
            typeof input.supersedesEvidenceSha256 === 'string' &&
            input.supersedesEvidenceSha256 === priorDispositionRow.evidence_sha256
          if (
            isManagedComment &&
            matchesSuperseded &&
            priorPrReceipt.candidate_commit_oid === input.receipt.candidateCommitOid
          ) {
            isHistoricalPrUpgrade = true
          }
        }
      }
      if (settlesDisposition && priorDisposition !== undefined && existingDisposition === undefined && !isHistoricalPrUpgrade) {
        throw new Error(`${input.stageId} is already settled with a different disposition`)
      }

      const createdAt = new Date().toISOString()
      const receiptSha256 = sha256(canonicalJson({
        authoritativePostObservationSha256: input.receipt.authoritativePostObservationSha256,
        candidateCommitOid: input.receipt.candidateCommitOid,
        createdAt,
        kind: input.receipt.kind,
        payload: input.receipt.payload,
        runId: input.runId
      }))
      this.#db.prepare(
        `INSERT INTO remote_receipts (
           receipt_id, run_id, kind, candidate_commit_oid,
           authoritative_post_observation_sha256, receipt_json, receipt_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(),
        input.runId,
        input.receipt.kind,
        input.receipt.candidateCommitOid,
        input.receipt.authoritativePostObservationSha256,
        receiptJson,
        receiptSha256,
        createdAt
      )
      const evidenceId = this.#recordEvidence(input.evidence)
      this.#recordCheckpoint({
        ...input.checkpoint,
        runId: input.runId,
        stageId: input.stageId
      })
      if (isHistoricalPrUpgrade) {
        this.#db.prepare(
          `INSERT INTO stage_disposition_supersessions
             (run_id, stage_id, disposition, prior_evidence_sha256, evidence_sha256, recorded_at)
           VALUES (?, ?, 'satisfied', ?, ?, ?)`
        ).run(
          input.runId,
          input.stageId,
          priorDispositionRow!.evidence_sha256,
          input.evidence.evidenceSha256,
          createdAt
        )
      } else if (settlesDisposition && existingDisposition === undefined) {
        this.recordStageDisposition({
          disposition: 'satisfied',
          evidenceSha256: input.evidence.evidenceSha256,
          runId: input.runId,
          stageId: input.stageId
        })
      }
      this.#db.exec('COMMIT')
      return { evidenceId, receiptSha256 }
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  remoteReceipt(
    runId: string,
    kind: RemoteReceiptKind,
    receiptSha256?: string
  ): RemoteReceiptRow | undefined {
    return this.#db.prepare(
      `SELECT kind, candidate_commit_oid, authoritative_post_observation_sha256,
              receipt_json, receipt_sha256, created_at
       FROM remote_receipts
       WHERE run_id = ? AND kind = ? AND (? IS NULL OR receipt_sha256 = ?)
       ORDER BY rowid DESC
       LIMIT 1`
    ).get(runId, kind, receiptSha256 ?? null, receiptSha256 ?? null) as
      | RemoteReceiptRow
      | undefined
  }

  prepareResume(input: {
    baseBranch: string
    baseRefSha?: string
    branch: string
    effectivePolicyHash: string
    force?: boolean
    head: string
    intent: string
    policySha256: string
    repoRoot: string
    runId: string
  }): { claimId: string; checkpoint: StageCheckpointRow; generationToken: number } {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const checkpoint = this.#validateResume(input)
      const existing = this.leaseFor(input.repoRoot, input.branch)
      if (existing && existing.run_id !== input.runId && !input.force) {
        throw new Error(
          `branch ${input.branch} is already leased by run ${existing.run_id}; pass --force-lease to reclaim it`
        )
      }
      const generationToken =
        existing?.run_id === input.runId
          ? existing.generation_token
          : this.#nextGenerationToken(
              input.repoRoot,
              existing ? existing.generation_token + 1 : 1
            )
      const claimId = randomUUID()
      this.#db
        .prepare(
          `INSERT INTO resume_claims (run_id, claim_id, generation_token)
           VALUES (?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             claim_id = excluded.claim_id,
             generation_token = excluded.generation_token`
        )
        .run(input.runId, claimId, generationToken)
      this.#db.exec('COMMIT')
      return { claimId, checkpoint, generationToken }
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  resumeRun(input: {
    baseBranch: string
    baseRefSha?: string
    branch: string
    claimId: string
    effectivePolicyHash: string
    force?: boolean
    head: string
    intent: string
    policySha256: string
    repoRoot: string
    runId: string
  }): { checkpoint: StageCheckpointRow; generationToken: number } {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const checkpoint = this.#validateResume(input)
      const claim = this.#db
        .prepare(
          `SELECT generation_token FROM resume_claims
           WHERE run_id = ? AND claim_id = ?`
        )
        .get(input.runId, input.claimId) as
        | { generation_token: number | bigint }
        | undefined
      if (!claim) throw new Error(`run ${input.runId} has no matching resume claim`)
      const generationToken = Number(claim.generation_token)
      this.#acquireClaimedLeaseLocked(input, generationToken)
      this.#db
        .prepare(
          "UPDATE runs SET status = 'in-progress', terminal_commit_oid = NULL, completed_at = NULL WHERE run_id = ?"
        )
        .run(input.runId)
      this.#db.exec('COMMIT')
      return { checkpoint, generationToken }
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  resumeClaimMatches(input: {
    claimId: string
    generationToken: number
    runId: string
  }): boolean {
    return (
      this.#db
        .prepare(
          `SELECT 1 FROM resume_claims
           WHERE run_id = ? AND claim_id = ? AND generation_token = ?`
        )
        .get(input.runId, input.claimId, input.generationToken) !== undefined
    )
  }

  clearResumeClaim(runId: string, claimId: string): void {
    this.#db
      .prepare('DELETE FROM resume_claims WHERE run_id = ? AND claim_id = ?')
      .run(runId, claimId)
  }

  #validateResume(input: {
    baseBranch: string
    baseRefSha?: string
    branch: string
    effectivePolicyHash: string
    head: string
    intent: string
    policySha256: string
    repoRoot: string
    runId: string
  }): StageCheckpointRow {
    const run = this.run(input.runId)
    if (!run) throw new Error(`run ${input.runId} does not exist`)
    if (run.status === 'in-progress') {
      throw new Error(
        `run ${input.runId} is still in-progress; adopting stranded remote-stage runs is a Release 4 limitation`
      )
    }
    if (run.status !== 'failed') {
      throw new Error(`run ${input.runId} cannot resume from status ${run.status}`)
    }
    if (
      run.repo_root !== input.repoRoot ||
      run.branch !== input.branch ||
      run.base_branch !== input.baseBranch ||
      run.intent !== input.intent
    ) {
      throw new Error(`run ${input.runId} does not match this repository, branch, base, and intent`)
    }
    if (run.policy_sha256 !== input.policySha256) {
      throw new Error(`run ${input.runId} validation policy changed since it failed`)
    }
    const incompatibleEvidence = this.#db
      .prepare(
        `SELECT COUNT(*) AS count FROM stage_evidence
         WHERE run_id = ? AND stage_id NOT IN ('push', 'pr')
           AND (effective_policy_hash IS NULL OR effective_policy_hash <> ?)`
      )
      .get(input.runId, input.effectivePolicyHash) as { count: number | bigint }
    if (Number(incompatibleEvidence.count) > 0) {
      throw new Error(`run ${input.runId} effective validation policy changed since it failed`)
    }
    const incompatibleBaseEvidence = (
      input.baseRefSha === undefined
        ? this.#db.prepare(
            `SELECT COUNT(*) AS count FROM stage_evidence
             WHERE run_id = ? AND stage_id NOT IN ('push', 'pr')
               AND base_ref_sha IS NOT NULL`
          ).get(input.runId)
        : this.#db.prepare(
            `SELECT COUNT(*) AS count FROM stage_evidence
             WHERE run_id = ? AND stage_id NOT IN ('push', 'pr')
               AND (base_ref_sha IS NULL OR base_ref_sha <> ?)`
          ).get(input.runId, input.baseRefSha)
    ) as { count: number | bigint }
    const lintValidated = this.#db.prepare(
      `SELECT 1 FROM stage_dispositions
       WHERE run_id = ? AND stage_id = 'lint' AND disposition = 'satisfied'`
    ).get(input.runId) !== undefined
    if (Number(incompatibleBaseEvidence.count) > 0 && !lintValidated) {
      throw new Error(`run ${input.runId} base ref changed since it failed`)
    }
    const checkpoint = this.#db
      .prepare(
        `SELECT input_commit_oid, output_commit_oid, round_index, stage_id
         FROM stage_checkpoints WHERE run_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(input.runId) as StageCheckpointRow | undefined
    if (!checkpoint) throw new Error(`run ${input.runId} has no durable checkpoint to resume`)
    if (checkpoint.output_commit_oid !== input.head) {
      throw new Error(
        `HEAD ${input.head} does not match checkpoint ${checkpoint.output_commit_oid} for run ${input.runId}`
      )
    }
    return checkpoint
  }

  finishRun(
    runId: string,
    status: Exclude<RunStatus, 'in-progress'>,
    terminalCommitOid?: string
  ): boolean {
    const result = this.#db
      .prepare(
        "UPDATE runs SET status = ?, completed_at = ?, terminal_commit_oid = COALESCE(?, terminal_commit_oid) WHERE run_id = ? AND status = 'in-progress'"
      )
      .run(status, new Date().toISOString(), terminalCommitOid ?? null, runId)
    return Number(result.changes) > 0
  }

  acquireLease(options: {
    branch: string
    force?: boolean
    repoRoot: string
    runId: string
  }): number {
    // BEGIN IMMEDIATE serializes concurrent coordinators for the whole
    // read-decide-write, so generation tokens stay unique and the takeover
    // compare-and-swap below can never race.
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const token = this.#acquireLeaseLocked(options)
      this.#db.exec('COMMIT')
      return token
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #acquireLeaseLocked(options: {
    branch: string
    force?: boolean
    repoRoot: string
    runId: string
  }): number {
    const existing = this.#db
      .prepare('SELECT run_id, generation_token FROM branch_leases WHERE repo_root = ? AND branch = ?')
      .get(options.repoRoot, options.branch) as LeaseRow | undefined
    const now = new Date().toISOString()
    if (existing && existing.run_id !== options.runId) {
      if (!options.force) {
        throw new Error(
          `branch ${options.branch} is already leased by run ${existing.run_id}; pass --force-lease to reclaim it`
        )
      }
      // ponytail: fenced compare-and-swap on the observed generation; SQLite serializes
      // writers, so a concurrent taker changes the token first and this update no-ops.
      const nextToken = this.#nextGenerationToken(
        options.repoRoot,
        Number(existing.generation_token) + 1
      )
      const takeover = this.#db
        .prepare(
          'UPDATE branch_leases SET run_id = ?, generation_token = ?, acquired_at = ?, heartbeat_at = ? WHERE repo_root = ? AND branch = ? AND generation_token = ?'
        )
        .run(options.runId, nextToken, now, now, options.repoRoot, options.branch, existing.generation_token)
      if (Number(takeover.changes) === 0) {
        throw new Error(
          `branch ${options.branch} was concurrently reclaimed by another coordinator; inspect its state before forcing again`
        )
      }
      return nextToken
    }
    if (existing) {
      this.#db
        .prepare('UPDATE branch_leases SET heartbeat_at = ? WHERE repo_root = ? AND branch = ?')
        .run(now, options.repoRoot, options.branch)
      return Number(existing.generation_token)
    }
    const token = this.#nextGenerationToken(options.repoRoot)
    this.#db
      .prepare(
        'INSERT INTO branch_leases (repo_root, branch, run_id, generation_token, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(options.repoRoot, options.branch, options.runId, token, now, now)
    return token
  }

  #acquireClaimedLeaseLocked(
    options: { branch: string; force?: boolean; repoRoot: string; runId: string },
    generationToken: number
  ): void {
    const existing = this.#db
      .prepare('SELECT run_id, generation_token FROM branch_leases WHERE repo_root = ? AND branch = ?')
      .get(options.repoRoot, options.branch) as LeaseRow | undefined
    const now = new Date().toISOString()
    if (existing?.run_id === options.runId) {
      if (Number(existing.generation_token) !== generationToken) {
        throw new Error(`run ${options.runId} resume claim no longer matches its branch lease`)
      }
      this.#db
        .prepare('UPDATE branch_leases SET heartbeat_at = ? WHERE repo_root = ? AND branch = ?')
        .run(now, options.repoRoot, options.branch)
      return
    }
    if (existing) {
      if (!options.force) {
        throw new Error(
          `branch ${options.branch} is already leased by run ${existing.run_id}; pass --force-lease to reclaim it`
        )
      }
      if (Number(existing.generation_token) >= generationToken) {
        throw new Error(`run ${options.runId} resume claim is stale`)
      }
      const takeover = this.#db
        .prepare(
          'UPDATE branch_leases SET run_id = ?, generation_token = ?, acquired_at = ?, heartbeat_at = ? WHERE repo_root = ? AND branch = ? AND generation_token = ?'
        )
        .run(
          options.runId,
          generationToken,
          now,
          now,
          options.repoRoot,
          options.branch,
          existing.generation_token
        )
      if (Number(takeover.changes) === 0) {
        throw new Error(`run ${options.runId} resume claim is stale`)
      }
      return
    }
    this.#db
      .prepare(
        'INSERT INTO branch_leases (repo_root, branch, run_id, generation_token, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(options.repoRoot, options.branch, options.runId, generationToken, now, now)
  }

  #nextGenerationToken(repoRoot: string, minimum = 1): number {
    const row = this.#db
      .prepare('SELECT next_token FROM lease_generations WHERE repo_root = ?')
      .get(repoRoot) as { next_token: number | bigint } | undefined
    const token = Math.max(row ? Number(row.next_token) : 1, minimum)
    this.#db
      .prepare(
        'INSERT INTO lease_generations (repo_root, next_token) VALUES (?, ?) ON CONFLICT(repo_root) DO UPDATE SET next_token = excluded.next_token'
      )
      .run(repoRoot, token + 1)
    return token
  }

  heartbeatLease(repoRoot: string, branch: string, runId: string): void {
    const result = this.#db
      .prepare('UPDATE branch_leases SET heartbeat_at = ? WHERE repo_root = ? AND branch = ? AND run_id = ?')
      .run(new Date().toISOString(), repoRoot, branch, runId)
    if (Number(result.changes) === 0) {
      throw new Error(`the semantic lease for branch ${branch} was lost or reclaimed`)
    }
  }

  ownsLease(
    runId: string,
    ownership?: { branch: string; generationToken?: number; repoRoot: string }
  ): boolean {
    const run = this.runIdentity(runId)
    if (!run || run.status !== 'in-progress') return false
    const repoRoot = ownership?.repoRoot ?? run.repo_root
    const branch = ownership?.branch ?? run.branch
    const lease = this.leaseFor(repoRoot, branch)
    return (
      run.repo_root === repoRoot &&
      run.branch === branch &&
      lease?.run_id === runId &&
      (ownership?.generationToken === undefined ||
        lease.generation_token === ownership.generationToken)
    )
  }

  releaseLease(runId: string): void {
    this.#db.prepare('DELETE FROM branch_leases WHERE run_id = ?').run(runId)
  }

  abandonRun(input: { runId: string; reason: string; actorIdentity: string }): void {
    if (!input.reason.trim() || !input.actorIdentity.trim()) {
      throw new Error('abandon requires a reason and actor identity')
    }
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.run(input.runId)
      if (!run) throw new Error(`run ${input.runId} does not exist`)
      if (this.#db.prepare('SELECT 1 FROM run_abandonments WHERE run_id = ?').get(input.runId)) {
        this.#db.exec('COMMIT')
        return
      }
      if (run.status !== 'in-progress' && run.status !== 'failed') {
        throw new Error(`cannot abandon a ${run.status} run`)
      }
      if (this.#db.prepare('SELECT 1 FROM resume_claims WHERE run_id = ?').get(input.runId)) {
        throw new Error(`run ${input.runId} has a pending resume claim; recover its launcher first`)
      }
      const attempt = this.#db.prepare(
        `SELECT coordinator_identity, generation_token FROM run_attempts
         WHERE run_id = ? ORDER BY generation_token DESC LIMIT 1`
      ).get(input.runId) as { coordinator_identity: string; generation_token: number } | undefined
      const lease = this.#db.prepare(
        'SELECT generation_token FROM branch_leases WHERE run_id = ?'
      ).get(input.runId) as { generation_token: number } | undefined
      if (lease && (!attempt || lease.generation_token !== attempt.generation_token)) {
        throw new Error(`run ${input.runId} has an unrecorded lease owner; recover its launcher first`)
      }
      const initial = this.#db.prepare(
        'SELECT initial_coordinator_identity FROM runs WHERE run_id = ?'
      ).get(input.runId) as { initial_coordinator_identity: string | null }
      const coordinatorIdentity = attempt?.coordinator_identity ?? initial.initial_coordinator_identity ?? ''
      const generationToken = attempt?.generation_token ?? 0
      const pid = Number(/^no-mistakes:([1-9]\d*)$/.exec(coordinatorIdentity)?.[1])
      if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) {
        throw new Error(`run ${input.runId} has no verifiable local coordinator PID`)
      }
      // PID absence proves death; permission errors and PID reuse remain uncertain.
      // The write lock prevents resume from racing this check and cancellation.
      try {
        process.kill(pid, 0)
        throw new Error(`run ${input.runId} coordinator PID ${pid} is still present`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      const abandonedAt = new Date().toISOString()
      this.#db.prepare(
        `INSERT INTO run_abandonments
         (run_id, prior_status, coordinator_identity, generation_token, actor_identity, reason, abandoned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(input.runId, run.status, coordinatorIdentity, generationToken,
        input.actorIdentity, input.reason.trim(), abandonedAt)
      this.#db.prepare(
        "UPDATE runs SET status = 'cancelled', completed_at = ? WHERE run_id = ?"
      ).run(abandonedAt, input.runId)
      this.#db.prepare(
        `DELETE FROM pending_admission_leases
         WHERE admission_id IN (SELECT admission_id FROM submission_admissions WHERE run_id = ?)`
      ).run(input.runId)
      this.#db.prepare(
        `UPDATE submission_admissions
         SET status = 'failed', run_id = NULL, launched_at = NULL, launcher_pid = NULL,
             accepted_oid = NULL, accepted_at = NULL
         WHERE run_id = ?`
      ).run(input.runId)
      this.releaseLease(input.runId)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  settleRun(
    runId: string,
    status: 'cancelled' | 'failed',
    ownership?: { branch: string; generationToken?: number; repoRoot: string },
    presentation?: { eventKey: string; snapshot: PresentationSnapshot }
  ): boolean {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const settled = this.#settleRunLocked(runId, status, ownership, presentation)
      this.#db.exec('COMMIT')
      return settled
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  settleRunWithAttemptOutcome(
    input: AttemptOutcomeInput,
    runId: string,
    status: 'cancelled' | 'failed',
    ownership?: { branch: string; generationToken?: number; repoRoot: string },
    presentation?: { eventKey: string; snapshot: PresentationSnapshot }
  ): boolean {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      if (this.#settlementBlocked(runId, status, ownership)) {
        this.#db.exec('COMMIT')
        return false
      }
      this.recordAttemptOutcome(input)
      const settled = this.#settleRunLocked(runId, status, ownership, presentation)
      if (!settled) {
        this.#db.exec('ROLLBACK')
        return settled
      }
      this.#db.exec('COMMIT')
      return settled
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #settlementBlocked(
    runId: string,
    status: 'cancelled' | 'failed',
    ownership?: { branch: string; generationToken?: number; repoRoot: string }
  ): boolean {
    if (ownership === undefined) return false
    const run = this.runIdentity(runId)
    const lease = this.leaseFor(ownership.repoRoot, ownership.branch)
    return (
      !run ||
      run.repo_root !== ownership.repoRoot ||
      run.branch !== ownership.branch ||
      (run.status === 'in-progress'
        ? lease?.run_id !== runId ||
          (ownership.generationToken !== undefined &&
            lease.generation_token !== ownership.generationToken)
        : run.status !== status)
    )
  }

  #settleRunLocked(
    runId: string,
    status: 'cancelled' | 'failed',
    ownership?: { branch: string; generationToken?: number; repoRoot: string },
    presentation?: { eventKey: string; snapshot: PresentationSnapshot }
  ): boolean {
    if (this.#settlementBlocked(runId, status, ownership)) return false
    const run = this.runIdentity(runId)
    const settled = this.finishRun(runId, status)
    const alreadySettled = run?.status === status
    if (settled || alreadySettled) this.releaseLease(runId)
    let presentationRecorded: boolean | undefined
    if (presentation && (settled || alreadySettled)) {
      presentationRecorded = this.recordPresentationSnapshot(
        runId,
        presentation.eventKey,
        presentation.snapshot
      )
      if (settled && !presentationRecorded) {
        throw new Error(`presentation event ${presentation.eventKey} is already recorded`)
      }
    }
    if (presentation) return presentationRecorded ?? false
    return ownership === undefined ? settled : settled || alreadySettled
  }

  #requirePassedRunLease(
    runId: string,
    ownership?: { branch: string; generationToken: number; repoRoot: string }
  ): void {
    if (!this.ownsLease(runId, ownership)) {
      throw new Error(`run ${runId} no longer owns its branch lease`)
    }
  }

  #completePassedRun(manifest: CompletionAttestationManifest, terminalCommitOid: string): void {
    if (!this.finishRun(manifest.runId, 'passed', terminalCommitOid)) {
      throw new Error(`run ${manifest.runId} is already settled`)
    }
    this.releaseLease(manifest.runId)
    this.recordAttestation(manifest)
  }

  finalizePassedRun(
    manifest: CompletionAttestationManifest,
    terminalCommitOid: string,
    ownership?: { branch: string; generationToken: number; repoRoot: string }
  ): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#requirePassedRunLease(manifest.runId, ownership)
      this.#completePassedRun(manifest, terminalCommitOid)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  async finalizePassedRunWithLeaseMutation(
    manifest: CompletionAttestationManifest,
    terminalCommitOid: string,
    ownership: { branch: string; generationToken: number; repoRoot: string },
    mutation: () => Promise<string>,
    presentation?: { eventKey: string; snapshot: PresentationSnapshot }
  ): Promise<string> {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#requirePassedRunLease(manifest.runId, ownership)
      const result = await mutation()
      this.#completePassedRun(manifest, terminalCommitOid)
      if (presentation) this.#recordPresentationMilestone(manifest.runId, presentation)
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  finalizePassedRunWithAttemptOutcome(
    manifest: PipelineCompletionAttestationManifest,
    terminalCommitOid: string,
    ownership: { branch: string; generationToken: number; repoRoot: string },
    outcome: AttemptOutcomeInput,
    presentation?: { eventKey: string; snapshot: PresentationSnapshot }
  ): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#requirePassedRunLease(manifest.runId, ownership)
      if (this.recordAttemptOutcome(outcome) !== manifest.attemptOutcomeDigests.at(-1)) {
        throw new Error('terminal attempt outcome does not match the completion attestation')
      }
      this.#completePassedRun(manifest, terminalCommitOid)
      if (presentation) this.#recordPresentationMilestone(manifest.runId, presentation)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  async finalizePassedRunWithAttemptOutcomeAndLeaseMutation(
    runId: string,
    terminalCommitOid: string,
    ownership: { branch: string; generationToken: number; repoRoot: string },
    mutate: () => Promise<string>,
    outcomeFor: (custodyNote: string) => AttemptOutcomeInput,
    manifestFor: (
      outcome: AttemptOutcomeInput,
      outcomeSha256: string
    ) => PipelineCompletionAttestationManifest,
    presentation?: { eventKey: string; snapshot: PresentationSnapshot }
  ): Promise<{ custodyNote: string; manifest: PipelineCompletionAttestationManifest }> {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#requirePassedRunLease(runId, ownership)
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    try {
      const custodyNote = await mutate()
      const outcome = outcomeFor(custodyNote)
      const outcomeDigest = attemptOutcomeSha256(outcome)
      const manifest = manifestFor(outcome, outcomeDigest)
      if (manifest.runId !== runId || outcome.runId !== runId) {
        throw new Error('terminal settlement run identity changed')
      }
      this.#requirePassedRunLease(manifest.runId, ownership)
      if (this.recordAttemptOutcome(outcome) !== outcomeDigest) {
        throw new Error('terminal attempt outcome changed during settlement')
      }
      this.#completePassedRun(manifest, terminalCommitOid)
      if (presentation) this.#recordPresentationMilestone(manifest.runId, presentation)
      this.#db.exec('COMMIT')
      return { custodyNote, manifest }
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  recordCheckpoint(
    input: {
      inputCommitOid: string
      outputCommitOid: string
      roundIndex: number
      runId: string
      stageId: string
    },
    presentation?: { eventKey: string; snapshot: PresentationSnapshot }
  ): void {
    if (presentation) this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#recordCheckpoint(input)
      if (presentation) {
        this.#recordPresentationMilestone(input.runId, presentation)
        this.#db.exec('COMMIT')
      }
    } catch (error) {
      if (presentation) this.#db.exec('ROLLBACK')
      throw error
    }
  }

  settleLocalStage(
    input: {
      checkpoint: {
        inputCommitOid: string
        outputCommitOid: string
        roundIndex: number
      }
      evidenceSha256: string
      supersedesEvidenceSha256?: string
      runId: string
      stageId: string
    },
    presentation?: { eventKey: string; snapshot: PresentationSnapshot }
  ): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const settlesDisposition = this.stagePlan(input.runId).some(
        (entry) => entry.stage_id === 'push'
      )
      const disposition = this.stageDispositions(input.runId)
        .find((entry) => entry.stage_id === input.stageId)
      const dispositionChanged = settlesDisposition && disposition &&
        (disposition.disposition !== 'satisfied' ||
          disposition.evidence_sha256 !== input.evidenceSha256)
      if (dispositionChanged) {
        const candidates = this.#db.prepare(
          `SELECT rowid AS sequence, evidence_sha256, candidate_commit_oid, worker_identity FROM stage_evidence
           WHERE run_id = ? AND stage_id = ? AND evidence_sha256 IN (?, ?)`
        ).all(input.runId, input.stageId, disposition.evidence_sha256, input.evidenceSha256) as Array<{
          sequence: number
          worker_identity: string
          candidate_commit_oid: string
          evidence_sha256: string
        }>
        const priorEvidence = candidates.find(
          (row) => row.evidence_sha256 === disposition.evidence_sha256
        )
        const nextEvidence = candidates.find(
          (row) => row.evidence_sha256 === input.evidenceSha256
        )
        if (disposition.disposition !== 'satisfied' ||
            input.supersedesEvidenceSha256 !== disposition.evidence_sha256 ||
            !priorEvidence || !nextEvidence || nextEvidence.sequence <= priorEvidence.sequence ||
            !isAuthoritativeStageEvidence(nextEvidence.worker_identity) ||
            nextEvidence.candidate_commit_oid !== input.checkpoint.outputCommitOid) {
          throw new Error(`${input.stageId} is already settled with a different disposition`)
        }
        this.#db.prepare(
          `INSERT INTO stage_disposition_supersessions
             (run_id, stage_id, disposition, prior_evidence_sha256, evidence_sha256, recorded_at)
           VALUES (?, ?, 'satisfied', ?, ?, ?)`
        ).run(
          input.runId,
          input.stageId,
          disposition.evidence_sha256,
          input.evidenceSha256,
          new Date().toISOString()
        )
      }
      this.recordCheckpoint({ ...input.checkpoint, runId: input.runId, stageId: input.stageId })
      if (settlesDisposition && !disposition) {
        this.recordStageDisposition({
          disposition: 'satisfied',
          evidenceSha256: input.evidenceSha256,
          runId: input.runId,
          stageId: input.stageId
        })
      }
      if (presentation) this.#recordPresentationMilestone(input.runId, presentation)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #recordCheckpoint(input: {
    inputCommitOid: string
    outputCommitOid: string
    roundIndex: number
    runId: string
    stageId: string
  }): void {
    this.#db
      .prepare(
        'INSERT INTO stage_checkpoints (run_id, stage_id, round_index, input_commit_oid, output_commit_oid, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        input.runId,
        input.stageId,
        input.roundIndex,
        input.inputCommitOid,
        input.outputCommitOid,
        new Date().toISOString()
      )
  }

  recordEvidence(input: RecordEvidenceInput): string {
    return this.#recordEvidence(input)
  }

  #recordEvidence(input: RecordEvidenceInput): string {
    const evidenceId = randomUUID()
    this.#db
      .prepare(
        `INSERT INTO stage_evidence (
           evidence_id, run_id, stage_id, round_index, candidate_commit_oid, base_commit_oid,
           worker_identity, exit_code, evidence_sha256, artifact_path, artifact_sha256, summary,
           findings_json, effective_policy_hash, base_ref_sha, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        evidenceId,
        input.runId,
        input.stageId,
        input.roundIndex,
        input.candidateCommitOid,
        input.baseCommitOid,
        input.workerIdentity,
        input.exitCode,
        input.evidenceSha256,
        input.artifactPath,
        input.artifactSha256,
        input.summary,
        input.findingsJson ?? null,
        input.effectivePolicyHash ?? null,
        input.baseRefSha ?? null,
        new Date().toISOString()
      )
    return evidenceId
  }

  listEvidence(runId: string): StageEvidenceRow[] {
    return this.#db
      .prepare(
        `SELECT evidence_id, run_id, stage_id, round_index, candidate_commit_oid, base_commit_oid,
                worker_identity, exit_code, evidence_sha256, artifact_path, artifact_sha256,
                summary, findings_json, effective_policy_hash, base_ref_sha
         FROM stage_evidence WHERE run_id = ? ORDER BY rowid`
      )
      .all(runId) as StageEvidenceRow[]
  }

  /**
   * Re-derives every stage evidence digest a manifest attests to, from what is
   * on disk.
   *
   * Three tampering routes are covered: editing a stage log changes the
   * artifact digest, editing any bound field of a row -- commit OIDs, worker
   * identity, exit code, summary, round -- changes the evidence digest, and
   * deleting the row outright would otherwise leave nothing to check, so every
   * manifest entry must still find its row. Returns one message per failure so
   * a caller can report them all at once.
   */
  verifyEvidence(
    manifest: Pick<PassedAttestationManifest, 'runId' | 'stageEvidence'>
  ): string[] {
    return this.#verifyEvidence(manifest.runId, manifest.stageEvidence).problems
  }

  #verifyEvidence(runId: string, entries: StageEvidenceManifestEntry[]): {
    problems: string[]
    rows: StageEvidenceRow[]
  } {
    const problems: string[] = []
    const rows = this.listEvidence(runId)
    const unmatched = [...rows]
    for (const entry of entries) {
      const index = unmatched.findIndex(
        (row) => row.evidence_sha256 === entry.evidenceSha256
      )
      if (index === -1) {
        problems.push(
          `${entry.stage} round ${entry.round}: the attested evidence row is missing from the ledger`
        )
      } else {
        unmatched.splice(index, 1)
      }
    }
    for (const row of unmatched) {
      problems.push(
        `${row.stage_id} round ${row.round_index}: the ledger evidence row is absent from the attestation`
      )
    }
    for (const row of rows) {
      const label = `${row.stage_id} round ${row.round_index}`
      if (!row.artifact_sha256) {
        problems.push(`${label}: no artifact digest was recorded`)
        continue
      }
      let artifact: Buffer
      try {
        // A stage artifact is a regular file no larger than the log cap. Reading
        // whatever the recorded path names would let a hand-edited row aim
        // verification at a FIFO or a device and hang it, so the shape and size
        // are checked from metadata before any bytes are read.
        const info = statSync(row.artifact_path)
        if (!info.isFile()) throw new Error('not a regular file')
        if (info.size > MAX_LOG_BYTES) throw new Error('larger than the log cap')
        artifact = readFileSync(row.artifact_path)
      } catch {
        problems.push(`${label}: artifact ${row.artifact_path} is missing or unreadable`)
        continue
      }
      const artifactSha256 = sha256(artifact)
      if (artifactSha256 !== row.artifact_sha256) {
        problems.push(`${label}: artifact ${row.artifact_path} does not match its recorded digest`)
        continue
      }
      let artifactReport: Record<string, unknown> | undefined
      try {
        const parsed = JSON.parse(artifact.toString('utf8')) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          artifactReport = parsed as Record<string, unknown>
        }
      } catch {}
      if (
        artifactReport === undefined &&
        (row.findings_json !== null ||
          row.effective_policy_hash !== null ||
          row.base_ref_sha !== null)
      ) {
        problems.push(`${label}: artifact findings are unreadable`)
        continue
      }
      if (artifactReport !== undefined) {
        if (
          (Object.hasOwn(artifactReport, 'effective_policy_hash') ||
            row.effective_policy_hash !== null) &&
          artifactReport.effective_policy_hash !== row.effective_policy_hash
        ) {
          problems.push(`${label}: recorded policy provenance does not match the attested artifact`)
        }
        const artifactBaseRefSha = Object.hasOwn(artifactReport, 'base_ref_sha')
          ? artifactReport.base_ref_sha
          : null
        if (artifactBaseRefSha !== row.base_ref_sha) {
          problems.push(`${label}: recorded base provenance does not match the attested artifact`)
        }
        if (
          row.findings_json !== null &&
          JSON.stringify(artifactReport.findings) !== row.findings_json
        ) {
          problems.push(`${label}: recorded findings do not match the attested artifact`)
        }
      }
      const expected = evidenceSha256({
        artifactSha256,
        baseCommitOid: row.base_commit_oid,
        candidateCommitOid: row.candidate_commit_oid,
        exitCode: Number(row.exit_code),
        round: Number(row.round_index),
        runId,
        stage: row.stage_id,
        summary: row.summary,
        workerIdentity: row.worker_identity
      })
      if (expected !== row.evidence_sha256) {
        problems.push(`${label}: evidence digest does not match its recorded fields`)
      }
    }
    return { problems, rows }
  }

  /**
   * Stages that must not be attested: the latest recorded round still carries a
   * finding nobody addressed, and no gate decision waived it. Findings come from
   * the durable evidence rows, so this holds independently of whatever the
   * coordinator's stage loop believed about the run. Unreadable findings block
   * too -- an unresolved stage and an unreadable one are equally unattestable.
   */
  attestationBlockers(runId: string, entries: StageEvidenceManifestEntry[]): string[] {
    const evidence = this.#verifyEvidence(runId, entries)
    if (evidence.problems.length > 0) return evidence.problems

    // Keyed by the exact evidence digest the decision was recorded against, so a
    // waiver never carries over to a later round of the same stage.
    const auditsByGateId = new Map(
      this.listGateAudit(runId).map((audit) => [audit.gate_id, audit])
    )
    const waived = new Set(
      entries
        .filter((entry) => {
          const waiver = entry.waiverOrApproval
          if (!waiver) return false
          const audit = auditsByGateId.get(waiver.gateId)
          return (
            audit !== undefined &&
            gateAuditMatchesEvidence(
              audit,
              entry.stage,
              entry.round,
              entry.evidenceSha256
            ) &&
            audit.decision === waiver.decision &&
            audit.resolved_at !== null
          )
        })
        .map((entry) => entry.evidenceSha256)
    )
    // listEvidence orders by insertion, so the last row written for a stage is
    // the one left in the map.
    const latest = new Map<string, StageEvidenceRow>()
    for (const row of evidence.rows) {
      if (isAuthoritativeStageEvidence(row.worker_identity)) {
        latest.set(row.stage_id, row)
      }
    }
    const blockers: string[] = []
    for (const row of latest.values()) {
      const label = `${row.stage_id} round ${row.round_index}`
      if (row.stage_id.startsWith('command-') && row.exit_code !== 0) {
        blockers.push(`${label}: required command gate failed`)
        continue
      }
      if (row.findings_json === null) {
        blockers.push(`${label}: recorded findings are unreadable`)
        continue
      }
      let unresolved: number
      try {
        unresolved = (JSON.parse(row.findings_json) as { action?: string }[]).filter(
          (finding) => finding?.action !== 'no-op'
        ).length
      } catch {
        blockers.push(`${label}: recorded findings are unreadable`)
        continue
      }
      if (waived.has(row.evidence_sha256)) continue
      if (unresolved > 0) {
        blockers.push(
          `${label}: ${unresolved} unaddressed finding(s) ` +
            'and no recorded waiver or approval'
        )
      }
    }
    return blockers
  }

  /**
   * Records a decision gate the moment it opens, before the coordinator blocks
   * on a human. A run interrupted mid-gate therefore still leaves the gate
   * event — including its exhaustion origin — in the ledger as `pending`.
   */
  openGateAudit(input: {
    evidenceSha256: string
    gateId: string
    gateKind: GateKind
    optionsJson: string
    question: string
    roundIndex: number
    runId: string
    stageId: string
  }): void {
    this.#db
      .prepare(
        `INSERT INTO gate_audit (
           gate_id, run_id, stage_id, round_index, evidence_sha256, gate_kind, question, options_json,
           resolution, decision, guidance, opened_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'pending', NULL, ?)
         ON CONFLICT(gate_id) DO NOTHING`
      )
      .run(
        input.gateId,
        input.runId,
        input.stageId,
        input.roundIndex,
        input.evidenceSha256,
        input.gateKind,
        input.question,
        input.optionsJson,
        new Date().toISOString()
      )
  }

  recordGateAudit(input: {
    decision: string
    evidenceSha256?: string
    gateId: string
    gateKind?: GateKind
    guidance?: string
    optionsJson: string
    question: string
    resolution: string
    roundIndex: number
    runId: string
    selectedFindingIds?: string[]
    stageId: string
  }): void {
    const now = new Date().toISOString()
    const evidenceSha256 =
      input.evidenceSha256 ??
      (input.gateKind === 'guardrail'
        ? null
        : (this.#db
            .prepare(
              `SELECT evidence_sha256 FROM stage_evidence
               WHERE run_id = ? AND stage_id = ? AND round_index = ?
               ORDER BY rowid DESC LIMIT 1`
            )
            .get(input.runId, input.stageId, input.roundIndex) as
            | { evidence_sha256: string }
            | undefined)?.evidence_sha256 ?? null)
    this.#db
      .prepare(
         `INSERT INTO gate_audit (
            gate_id, run_id, stage_id, round_index, evidence_sha256, gate_kind, question, options_json,
            resolution, decision, guidance, selected_finding_ids, opened_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(gate_id) DO UPDATE SET
            resolution = excluded.resolution,
            decision = excluded.decision,
            guidance = excluded.guidance,
            selected_finding_ids = excluded.selected_finding_ids,
            evidence_sha256 = COALESCE(gate_audit.evidence_sha256, excluded.evidence_sha256),
            resolved_at = excluded.resolved_at`
      )
      .run(
        input.gateId,
        input.runId,
        input.stageId,
        input.roundIndex,
        evidenceSha256,
        input.gateKind ?? 'finding',
        input.question,
        input.optionsJson,
        input.resolution,
        input.decision,
        input.guidance ?? null,
        input.selectedFindingIds === undefined
          ? null
          : JSON.stringify(input.selectedFindingIds),
        now,
        now
      )
  }

  recordAttestation(manifest: CompletionAttestationManifest): void {
    if (manifest.version === '2.0.0') {
      verifyCompletionAttestation(manifest)
      this.verifyRetainedCompletionAttestation(manifest)
    }
    this.#db
      .prepare(
        `INSERT INTO passed_attestations (
           run_id, candidate_commit_oid, base_commit_oid, policy_sha256, intent, intent_hash,
           merkle_root, manifest_json, coordinator_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        manifest.runId,
        manifest.candidateCommitOid,
        manifest.baseCommitOid,
        manifest.policySha256,
        manifest.intent,
        manifest.intentHash,
        manifest.merkleRoot,
        JSON.stringify(manifest),
        manifest.coordinatorVersion,
        new Date().toISOString()
      )
  }

  verifyRetainedCompletionAttestation(manifest: PipelineCompletionAttestationManifest): void {
    verifyCompletionAttestation(manifest)
    const problems: string[] = []
    const retainedEvidence = this.#verifyEvidence(manifest.runId, manifest.stageEvidence)
    problems.push(...retainedEvidence.problems.map((problem) => `stage evidence: ${problem}`))
    const gateAudits = new Map(this.listGateAudit(manifest.runId).map((audit) => [audit.gate_id, audit]))
    for (const disposition of manifest.stageDispositions) {
      const evidence = manifest.stageEvidence.find(
        (entry) => entry.evidenceSha256 === disposition.evidenceSha256
      )
      if (disposition.disposition !== 'satisfied' || !evidence || evidence.exitCode === 0) continue
      const waiver = evidence.waiverOrApproval
      const audit = waiver ? gateAudits.get(waiver.gateId) : undefined
      if (!audit || audit.resolved_at === null || audit.decision !== waiver?.decision ||
          !gateAuditMatchesEvidence(audit, evidence.stage, evidence.round, evidence.evidenceSha256)) {
        problems.push(`stage evidence: ${evidence.stage} nonzero evidence lacks an exact approval`)
      }
    }
    const retainedRun = this.#db.prepare(
      `SELECT status, terminal_commit_oid, intent, intent_hash, policy_sha256
       FROM runs WHERE run_id = ?`
    ).get(manifest.runId) as
      | {
          intent: string
          intent_hash: string
          policy_sha256: string
          status: RunStatus
          terminal_commit_oid: string | null
        }
      | undefined
    if (!retainedRun || retainedRun.status !== 'passed' ||
        retainedRun.terminal_commit_oid !== manifest.candidateCommitOid ||
        retainedRun.intent !== manifest.intent || retainedRun.intent_hash !== manifest.intentHash ||
        retainedRun.policy_sha256 !== manifest.policySha256) {
      problems.push('passed run')
    }
    const expectedPlan = manifest.stagePlan.map((entry, position) => ({
      position,
      requirement: entry.requirement,
      stage_id: entry.stage
    }))
    if (canonicalJson(this.stagePlan(manifest.runId)) !== canonicalJson(expectedPlan)) {
      problems.push('frozen stage plan')
    }

    const expectedDispositions = manifest.stageDispositions.map((entry) => ({
      disposition: entry.disposition,
      evidence_sha256: entry.evidenceSha256 ?? null,
      stage_id: entry.stage
    }))
    if (
      canonicalJson(this.stageDispositions(manifest.runId)) !==
      canonicalJson(expectedDispositions)
    ) {
      problems.push('stage dispositions')
    }
    const baseDisposition =
      manifest.stageDispositions.find(
        (disposition) =>
          disposition.stage === 'rebase' && disposition.evidenceSha256 !== undefined
      ) ??
      manifest.stageDispositions.find(
        (disposition) => disposition.evidenceSha256 !== undefined
      )
    const baseEvidence = manifest.stageEvidence.find(
      (evidence) => evidence.evidenceSha256 === baseDisposition?.evidenceSha256
    )
    const retainedBaseEvidence = retainedEvidence.rows.find(
      (row) => row.evidence_sha256 === baseEvidence?.evidenceSha256
    )
    if (!retainedBaseEvidence || retainedBaseEvidence.base_commit_oid !== manifest.baseCommitOid) {
      problems.push('base commit evidence')
    }

    const route = this.publicationRoute(manifest.runId)
    const expectedRoute = {
      base_branch: manifest.publicationRoute.baseBranch,
      base_repository_id: manifest.publicationRoute.baseRepositoryId,
      forge_host: manifest.publicationRoute.forgeHost,
      head_branch: manifest.publicationRoute.headBranch,
      head_owner: manifest.publicationRoute.headOwner,
      head_repository_id: manifest.publicationRoute.headRepositoryId,
      route_fingerprint: manifest.publicationRoute.routeFingerprint
    }
    if (canonicalJson(route) !== canonicalJson(expectedRoute)) {
      problems.push('publication route')
    }

    const retainedOutcomes = this.#db.prepare(
      `SELECT o.attempt_id, o.run_id, o.verdict, o.stopping_fact, o.reason,
              o.candidate_commit_oid, o.coordinator_identity, o.actor_identity,
              o.custody_json, o.receipt_digests_json, o.resume_eligible,
              o.completed_at, o.outcome_sha256, a.generation_token
       FROM attempt_outcomes o
       JOIN run_attempts a ON a.run_id = o.run_id AND a.attempt_id = o.attempt_id
       WHERE o.run_id = ? ORDER BY a.generation_token, o.rowid`
    ).all(manifest.runId) as {
      actor_identity: string
      attempt_id: string
      candidate_commit_oid: string
      completed_at: string
      coordinator_identity: string
      custody_json: string
      generation_token: number | bigint
      outcome_sha256: string
      reason: string
      receipt_digests_json: string
      resume_eligible: number | bigint
      run_id: string
      stopping_fact: string
      verdict: Exclude<RunStatus, 'in-progress'>
    }[]
    const outcomes = retainedOutcomes.map((row) => {
      try {
        const digest = attemptOutcomeSha256({
          actorIdentity: row.actor_identity,
          attemptId: row.attempt_id,
          candidateCommitOid: row.candidate_commit_oid,
          completedAt: row.completed_at,
          coordinatorIdentity: row.coordinator_identity,
          custody: JSON.parse(row.custody_json) as AttemptOutcomeInput['custody'],
          reason: row.reason,
          receiptDigests: JSON.parse(row.receipt_digests_json) as string[],
          resumeEligible: Number(row.resume_eligible) === 1,
          runId: row.run_id,
          stoppingFact: row.stopping_fact,
          verdict: row.verdict
        })
        return digest === row.outcome_sha256 ? digest : ''
      } catch {
        return ''
      }
    })
    if (canonicalJson(outcomes) !== canonicalJson(manifest.attemptOutcomeDigests)) {
      problems.push('attempt outcomes')
    }

    const expectedReceiptDigests = [
      manifest.candidatePublicationReceiptSha256,
      manifest.pullRequestBindingReceiptSha256
    ].sort()
    const latestAttempt = this.#db.prepare(
      'SELECT MAX(generation_token) AS generation_token FROM run_attempts WHERE run_id = ?'
    ).get(manifest.runId) as { generation_token: number | bigint | null }
    const passedOutcome = retainedOutcomes.find((row) => {
      if (row.verdict !== 'passed' || row.candidate_commit_oid !== manifest.candidateCommitOid) {
        return false
      }
      if (latestAttempt.generation_token === null ||
          Number(row.generation_token) !== Number(latestAttempt.generation_token)) return false
      try {
        const custody = JSON.parse(row.custody_json) as unknown
        const receipts = JSON.parse(row.receipt_digests_json) as unknown
        return canonicalJson(custody) === canonicalJson(manifest.custody) &&
          Array.isArray(receipts) &&
          canonicalJson([...receipts].sort()) === canonicalJson(expectedReceiptDigests)
      } catch {
        return false
      }
    })
    if (!passedOutcome) problems.push('passed attempt outcome')
    if (passedOutcome?.outcome_sha256 !== manifest.attemptOutcomeDigests.at(-1)) {
      problems.push('terminal attempt outcome ordering')
    }

    const publication = this.remoteReceipt(
      manifest.runId,
      'candidate-publication',
      manifest.candidatePublicationReceiptSha256
    )
    if (
      publication?.receipt_sha256 !== manifest.candidatePublicationReceiptSha256 ||
      publication.candidate_commit_oid !== manifest.candidateCommitOid
    ) {
      problems.push('candidate-publication receipt')
    }
    const pullRequest = this.remoteReceipt(
      manifest.runId,
      'pull-request-binding',
      manifest.pullRequestBindingReceiptSha256
    )
    if (
      pullRequest?.receipt_sha256 !== manifest.pullRequestBindingReceiptSha256 ||
      pullRequest.candidate_commit_oid !== manifest.candidateCommitOid
    ) {
      problems.push(
        `pull-request-binding receipt (receipt ${pullRequest?.receipt_sha256 ?? 'missing'} / candidate ${pullRequest?.candidate_commit_oid ?? 'missing'})`
      )
    }
    for (const receipt of [publication, pullRequest]) {
      if (!receipt) continue
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(receipt.receipt_json) as Record<string, unknown>
      } catch {
        problems.push(`${receipt.kind} observation`)
        continue
      }
      if (sha256(canonicalJson({
        authoritativePostObservationSha256: receipt.authoritative_post_observation_sha256,
        candidateCommitOid: receipt.candidate_commit_oid,
        createdAt: receipt.created_at,
        kind: receipt.kind,
        payload,
        runId: manifest.runId
      })) !== receipt.receipt_sha256) {
        problems.push(`${receipt.kind} receipt digest`)
      }
      if (!this.#remoteObservationMatches({
        allowHistoricalAttempt: receipt.kind === 'candidate-publication' ||
          (receipt.kind === 'pull-request-binding' && payload.state === 'merged'),
        candidateCommitOid: receipt.candidate_commit_oid,
        kind: receipt.kind,
        observationSha256: receipt.authoritative_post_observation_sha256,
        receiptPayload: payload,
        runId: manifest.runId
      })) {
        problems.push(`${receipt.kind} observation`)
      }
      if (receipt.kind === 'pull-request-binding') {
        const hasManagedComment = Object.hasOwn(payload, 'managedCommentIntent')
        const hasBody = Object.hasOwn(payload, 'bodySha256')
        const hasTitle = Object.hasOwn(payload, 'titleSha256')
        const hasPipelineEvidenceRoot = Object.hasOwn(payload, 'pipelineEvidenceRoot')
        if (
          (hasManagedComment && hasBody) ||
          hasBody !== hasTitle ||
          ((hasManagedComment || hasBody) && !hasPipelineEvidenceRoot) ||
          (!hasManagedComment && !hasBody && hasPipelineEvidenceRoot)
        ) {
          problems.push('pull-request-binding receipt')
        }
        if (hasManagedComment && payload.pipelineEvidenceRoot !== manifest.pipelineEvidenceRoot) {
          problems.push('pipeline evidence root')
        }
      }
    }

    if (problems.length > 0) {
      throw new Error(`v2 attestation does not match retained ledger facts: ${problems.join(', ')}`)
    }
  }

  getAttestation(ref: string): PassedAttestationManifest {
    return this.getCompletionAttestation(ref) as PassedAttestationManifest
  }

  getCompletionAttestation(ref: string): CompletionAttestationManifest {
    const manifest = this.findCompletionAttestation(ref)
    if (!manifest) throw new Error(`no passed attestation found for ${ref}`)
    return manifest
  }

  /**
   * The stored manifest for a run ID or candidate commit, or undefined when the
   * ledger simply has no such record -- the case offline verification expects
   * on a machine that never ran the pipeline. A record that is present but
   * disagrees with its own indexed Merkle root still throws: that is tampering,
   * not absence.
   */
  findAttestation(ref: string): PassedAttestationManifest | undefined {
    return this.findCompletionAttestation(ref) as PassedAttestationManifest | undefined
  }

  findCompletionAttestation(ref: string): CompletionAttestationManifest | undefined {
    const row = (this.#db
      .prepare('SELECT manifest_json, merkle_root FROM passed_attestations WHERE run_id = ?')
      .get(ref)
      ?? this.#db
        .prepare(
          'SELECT manifest_json, merkle_root FROM passed_attestations WHERE candidate_commit_oid = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
        )
        .get(ref)) as { manifest_json: string; merkle_root: string } | undefined
    if (!row) return undefined
    const manifest = JSON.parse(row.manifest_json) as CompletionAttestationManifest
    if (manifest.merkleRoot !== row.merkle_root) {
      throw new Error('stored attestation manifest does not match the ledger Merkle root')
    }
    return manifest
  }

  /**
   * Runs eligible for pruning: completed, matching the filters, and holding no
   * branch lease. A lease outlives its run only when custody was never settled
   * -- a coordinator killed mid-run, or a failure whose recovery ref could not
   * be anchored -- and the lease row cascades away with the run, so pruning one
   * would erase the only record that the branch is still owned.
   *
   * `repoRoot` matches the run's repository root itself or anything nested
   * under it, so `--repo <path>` names a checkout rather than any run whose
   * path happens to contain the text.
   *
   * Containment is proven outside this transaction, so a pipeline rewriting the
   * same branch concurrently can make a proven-contained commit unmerged again
   * after its row is gone. That is deliberately not fenced: prune never deletes
   * refs, so the commits stay reachable at `refs/no-mistakes/recover/<run-id>`
   * and remain discoverable by name. Only the ledger row and the artifact logs
   * go -- which is what the operator asked for. Reserving the branch for the
   * duration would put a manual cleanup command in the path of the lease that
   * real runs depend on, to protect metadata about commits that are still on
   * disk.
   */
  prunableRuns(options: { before?: Date; repoRoot?: string }): PrunableRun[] {
    const before = options.before ? options.before.toISOString() : null
    const rows = this.#db
      .prepare(
        `SELECT run_id, repo_root, branch, base_branch FROM runs
         WHERE status <> 'in-progress'
           AND completed_at IS NOT NULL
           AND (? IS NULL OR completed_at < ?)
           AND run_id NOT IN (SELECT run_id FROM branch_leases)
         ORDER BY completed_at, rowid`
      )
      .all(before, before) as PrunableRun[]
    if (!options.repoRoot) return rows
    const root = path.resolve(options.repoRoot)
    return rows.filter((row) => isWithin(root, row.repo_root))
  }

  /**
   * Deletes the named runs. Checkpoints, evidence, gate audit rows and the
   * attestation cascade with them. Nothing else in the ledger removes a run:
   * evidence is retained indefinitely until an operator asks for this.
   */
  prune(runIds: string[]): number {
    if (runIds.length === 0) return 0
    let pruned = 0
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      // One statement per id rather than an IN list: a long-lived ledger can
      // hold more completed runs than SQLite allows host parameters.
      const removable = this.#db.prepare(
        "SELECT 1 FROM runs WHERE run_id = ? AND status <> 'in-progress' AND run_id NOT IN (SELECT run_id FROM branch_leases)"
      )
      // Accepted admissions retain their run binding indefinitely, so the
      // runs.delete would trip the run foreign key. The admission follows its
      // run: without it the ledger would keep replay rows that can never
      // resolve to the evidence an operator just asked to remove.
      const removeAdmissions = this.#db.prepare(
        'DELETE FROM submission_admissions WHERE run_id = ?'
      )
      const remove = this.#db.prepare(
        "DELETE FROM runs WHERE run_id = ? AND status <> 'in-progress' AND run_id NOT IN (SELECT run_id FROM branch_leases)"
      )
      for (const runId of runIds) {
        if (removable.get(runId) === undefined) continue
        removeAdmissions.run(runId)
        pruned += Number(remove.run(runId).changes)
      }
      this.#db.exec('COMMIT')
      return pruned
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  recordPresentationSnapshot(
    runId: string,
    eventKey: string,
    snapshot: PresentationSnapshot
  ): boolean {
    if (snapshot.runId !== runId) throw new Error('presentation snapshot run ID mismatch')
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO presentation_snapshots (
           run_id, event_key, sequence, snapshot_json, created_at
         ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(runId, eventKey, snapshot.sequence, JSON.stringify(snapshot), snapshot.updatedAt)
    if (Number(result.changes) > 0) return true
    const replay = this.#db
      .prepare(
        'SELECT sequence FROM presentation_snapshots WHERE run_id = ? AND event_key = ?'
      )
      .get(runId, eventKey) as { sequence: number } | undefined
    if (replay) return false
    const conflict = this.#db
      .prepare(
        'SELECT event_key FROM presentation_snapshots WHERE run_id = ? AND sequence = ?'
      )
      .get(runId, snapshot.sequence) as { event_key: string } | undefined
    if (conflict) {
      throw new Error(
        `presentation sequence ${snapshot.sequence} for run ${runId} is already held by event ${conflict.event_key}`
      )
    }
    throw new Error(`presentation event ${eventKey} could not be recorded`)
  }

  #recordPresentationMilestone(
    runId: string,
    presentation: { eventKey: string; snapshot: PresentationSnapshot }
  ): void {
    if (!this.recordPresentationSnapshot(runId, presentation.eventKey, presentation.snapshot)) {
      throw new Error(`presentation event ${presentation.eventKey} is already recorded`)
    }
  }

  recordAutoFixMode(
    runId: string,
    enabled: boolean,
    source: AutoFixModeEvent['source'],
    presentation?: { eventKey: string; snapshot: PresentationSnapshot }
  ): boolean {
    const insert = this.#db.prepare(
      `INSERT INTO auto_fix_mode_events (run_id, enabled, source, changed_at)
       VALUES (?, ?, ?, ?)`
    )
    const values = [runId, enabled ? 1 : 0, source, new Date().toISOString()] as const
    if (!presentation) {
      insert.run(...values)
      return true
    }
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      insert.run(...values)
      const recorded = this.recordPresentationSnapshot(
        runId,
        presentation.eventKey,
        presentation.snapshot
      )
      if (!recorded) {
        this.#db.exec('ROLLBACK')
        return false
      }
      this.#db.exec('COMMIT')
      return true
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  latestAutoFixMode(runId: string): boolean | undefined {
    const row = this.#db
      .prepare(
        `SELECT enabled FROM auto_fix_mode_events
         WHERE run_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(runId) as { enabled: number } | undefined
    return row === undefined ? undefined : row.enabled === 1
  }

  listAutoFixModeEvents(runId: string): AutoFixModeEvent[] {
    return (
      this.#db
        .prepare(
          `SELECT changed_at, enabled, source FROM auto_fix_mode_events
           WHERE run_id = ? ORDER BY id`
        )
        .all(runId) as {
        changed_at: string
        enabled: number
        source: AutoFixModeEvent['source']
      }[]
    ).map((row) => ({
      changedAt: row.changed_at,
      enabled: row.enabled === 1,
      source: row.source
    }))
  }

  listPresentationSnapshots(runId: string): PresentationSnapshot[] {
    return (
      this.#db
        .prepare(
          'SELECT snapshot_json FROM presentation_snapshots WHERE run_id = ? ORDER BY sequence'
        )
        .all(runId) as { snapshot_json: string }[]
    ).map(({ snapshot_json }) => JSON.parse(snapshot_json) as PresentationSnapshot)
  }

  runStatus(runId: string): RunStatus | undefined {
    const row = this.#db.prepare('SELECT status FROM runs WHERE run_id = ?').get(runId) as
      | { status: RunStatus }
      | undefined
    return row?.status
  }

  runIdentity(
    runId: string
  ): { branch: string; repo_root: string; status: RunStatus } | undefined {
    return this.#db
      .prepare('SELECT repo_root, branch, status FROM runs WHERE run_id = ?')
      .get(runId) as { branch: string; repo_root: string; status: RunStatus } | undefined
  }

  run(runId: string): RunRecord | undefined {
    return this.#db
      .prepare(
        `SELECT run_id, repo_root, branch, base_branch, submission_commit_oid,
                intent, policy_sha256, status FROM runs WHERE run_id = ?`
      )
      .get(runId) as RunRecord | undefined
  }

  listRuns(): { intent: string; run_id: string }[] {
    return this.#db.prepare('SELECT intent, run_id FROM runs ORDER BY created_at').all() as {
      intent: string
      run_id: string
    }[]
  }

  leaseFor(repoRoot: string, branch: string): { generation_token: number; run_id: string } | undefined {
    return this.#db
      .prepare('SELECT generation_token, run_id FROM branch_leases WHERE repo_root = ? AND branch = ?')
      .get(repoRoot, branch) as { generation_token: number; run_id: string } | undefined
  }

  listCheckpoints(runId: string): StageCheckpointRow[] {
    return this.#db
      .prepare(
        'SELECT input_commit_oid, output_commit_oid, round_index, stage_id FROM stage_checkpoints WHERE run_id = ? ORDER BY id'
      )
      .all(runId) as StageCheckpointRow[]
  }

  listGateAudit(runId: string): GateAuditRow[] {
    return this.#db
      .prepare(
        `SELECT decision, evidence_sha256, gate_id, stage_id, round_index, gate_kind, guidance, options_json, question, resolution,
                resolved_at, selected_finding_ids
         FROM gate_audit WHERE run_id = ? ORDER BY opened_at, rowid`
      )
      .all(runId) as GateAuditRow[]
  }

  listFindingDecisions(input: {
    branch: string
    repoRoot: string
    runId: string
  }): { decisions: FindingDecisionRow[]; truncated: boolean } {
    const limit = 20
    const rows = this.#db
      .prepare(
        `SELECT g.decision,
                (SELECT e.findings_json FROM stage_evidence e
                  WHERE e.run_id = g.run_id AND e.evidence_sha256 = g.evidence_sha256
                    AND e.findings_json IS NOT NULL LIMIT 1) AS findings_json,
                g.round_index, g.run_id, g.selected_finding_ids, g.stage_id
           FROM gate_audit g
           JOIN runs r ON r.run_id = g.run_id
           JOIN runs current_run ON current_run.run_id = ?
          WHERE r.repo_root = ? AND r.branch = ? AND r.rowid <= current_run.rowid
            AND g.stage_id IN ('review', 'test', 'document', 'lint')
            AND g.resolved_at IS NOT NULL AND g.selected_finding_ids IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM stage_evidence e
               WHERE e.run_id = g.run_id AND e.evidence_sha256 = g.evidence_sha256
                 AND e.findings_json IS NOT NULL
            )
           ORDER BY g.resolved_at DESC, g.rowid DESC
          LIMIT ?`
      )
      .all(input.runId, input.repoRoot, input.branch, limit + 1) as FindingDecisionRow[]
    return {
      decisions: rows.slice(0, limit).reverse(),
      truncated: rows.length > limit
    }
  }

  close(): void {
    this.#db.close()
  }

  mediaPublication(key: { runId: string; candidate: string; digest: string; repositoryId: string; host: string }, artifactPath: string):
    { status: 'pending' | 'published' | 'failed' | 'uncertain'; url: string | null; detail: string; artifactPath: string } | undefined {
    return this.#db.prepare(`SELECT status, url, detail, artifacts.artifact_path AS artifactPath FROM media_publications
      JOIN media_publication_artifacts AS artifacts USING (run_id, candidate_commit_oid, artifact_sha256, repository_id, host)
      WHERE run_id = ? AND candidate_commit_oid = ? AND artifact_sha256 = ? AND repository_id = ? AND host = ? AND artifacts.artifact_path = ?`)
      .get(key.runId, key.candidate, key.digest, key.repositoryId, key.host, artifactPath) as ReturnType<DomainLedger['mediaPublication']>
  }

  publishedMediaDigests(runId: string, candidate: string, repositoryId: string, host: string): string[] {
    return (this.#db.prepare(`SELECT artifact_sha256 FROM media_publications
      WHERE run_id = ? AND candidate_commit_oid = ? AND repository_id = ? AND host = ? AND status = 'published'`)
      .all(runId, candidate, repositoryId, host) as Array<{ artifact_sha256: string }>).map(row => row.artifact_sha256)
  }

  beginMediaPublication(key: { runId: string; candidate: string; digest: string; repositoryId: string; host: string }, artifactPath: string,
    ownership: { repoRoot: string; branch: string; generationToken: number }): boolean {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const owned = this.ownsLease(key.runId, ownership)
      const reserved = owned && this.#db.prepare(`INSERT OR IGNORE INTO media_publications
        (run_id, candidate_commit_oid, artifact_sha256, repository_id, host, artifact_path, status, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 'Upload outcome unknown; automatic retry withheld.', ?)`)
        .run(key.runId, key.candidate, key.digest, key.repositoryId, key.host, artifactPath, new Date().toISOString()).changes === 1
      if (owned) this.#db.prepare(`INSERT OR IGNORE INTO media_publication_artifacts
        (run_id, candidate_commit_oid, artifact_sha256, repository_id, host, artifact_path) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(key.runId, key.candidate, key.digest, key.repositoryId, key.host, artifactPath)
      this.#db.exec('COMMIT')
      return reserved
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  finishMediaPublication(key: { runId: string; candidate: string; digest: string; repositoryId: string; host: string },
    result: { status: 'published' | 'failed' | 'uncertain'; url?: string; detail: string },
    ownership: { repoRoot: string; branch: string; generationToken: number }): boolean {
    const changed = this.#db.prepare(`UPDATE media_publications SET status = ?, url = ?, detail = ?
      WHERE run_id = ? AND candidate_commit_oid = ? AND artifact_sha256 = ? AND repository_id = ? AND host = ? AND status = 'pending'
      AND EXISTS (SELECT 1 FROM runs r JOIN branch_leases l
        ON l.run_id = r.run_id AND l.repo_root = r.repo_root AND l.branch = r.branch
        WHERE r.run_id = media_publications.run_id AND r.status = 'in-progress'
          AND r.repo_root = ? AND r.branch = ? AND l.generation_token = ?)`)
      .run(result.status, result.url ?? null, result.detail, key.runId, key.candidate, key.digest, key.repositoryId, key.host,
        ownership.repoRoot, ownership.branch, ownership.generationToken).changes
    return changed === 1
  }
}
