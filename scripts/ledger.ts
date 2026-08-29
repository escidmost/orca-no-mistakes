import { createHash, randomUUID } from 'node:crypto'
import { constants, mkdirSync, readFileSync, statSync } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { GuardrailMode } from './config.ts'

const { O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_RDWR, O_WRONLY } = constants

export type RunStatus = 'in-progress' | 'passed' | 'failed' | 'cancelled'

export type GateKind = 'exhaustion' | 'finding' | 'guardrail'

export type GateAuditRow = {
  decision: string
  gate_id: string
  gate_kind: GateKind
  guidance: string | null
  question: string
  resolution: string
  resolved_at: string | null
  round_index: number
  selected_finding_ids: string | null
  stage_id: string
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
  candidate_commit_oid: string
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

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
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

function redactKnownSecrets(content: string): string {
  return applyRedaction(content, knownSecrets())
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

  async #append(chunk: string, source: symbol): Promise<void> {
    if (chunk.length === 0) return
    await this.#start()
    const secrets = knownSecrets()
    const redacted = applyRedaction(
      `${this.#carries.get(source) ?? ''}${chunk}`,
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

  async close(): Promise<void> {
    try {
      await this.#pending
      if (this.#carries.size > 0) {
        const carried = [...this.#carries.values()]
        this.#carries.clear()
        await this.#start()
        for (const chunk of carried) await this.#absorb(redactKnownSecrets(chunk))
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
    const reopenedStat = await reopened.stat()
    this.#fileIdentity = `${reopenedStat.dev}:${reopenedStat.ino}`
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
      const fileStat = await file.stat()
      let existingBytes = fileStat.size
      const fileIdentity = `${fileStat.dev}:${fileStat.ino}`
      await file.chmod(0o600)
      // The first `keep` bytes are the round's head and never change; whatever
      // follows is the previous worker's marker and tail, which this worker's
      // output replaces so the file ends with the round's final tail. Nothing
      // already on disk is parsed back, so worker text cannot forge accounting.
      const recorded = await this.#priorAccounting()
      const prior = recorded?.fileIdentity === fileIdentity ? recorded : undefined
      this.#originalBytesKnown =
        existingBytes === 0 ||
        (prior !== undefined && prior.originalBytesKnown !== false)
      this.#originalBytes =
        prior === undefined
          ? existingBytes
          : prior.originalBytes +
            (prior.fileBytes !== undefined && existingBytes > prior.fileBytes
              ? existingBytes - prior.fileBytes
              : 0)
      // A prior total larger than the file means the round already compacted:
      // its marker describes the old tail, so close() has to rewrite it even
      // though the physical file is back under the cap.
      this.#compacted =
        prior !== undefined &&
        (this.#originalBytes > existingBytes ||
          (prior.fileBytes !== undefined && existingBytes < prior.fileBytes))
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
   * The round's byte accounting carried across writers and reopens. It lives
   * beside the log rather than inside it because a count parsed back out of the
   * log would be worker-writable, and a worker could forge its own truncation
   * accounting.
   */
  async #priorAccounting(): Promise<
    {
      fileBytes?: number
      fileIdentity?: string
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
          (parsed.fileIdentity === undefined || typeof parsed.fileIdentity === 'string') &&
          (parsed.originalBytesKnown === undefined ||
            typeof parsed.originalBytesKnown === 'boolean')
        ) {
          return {
            fileBytes: parsed.fileBytes as number,
            fileIdentity: parsed.fileIdentity as string | undefined,
            originalBytes: parsed.originalBytes as number,
            originalBytesKnown: parsed.originalBytesKnown as boolean | undefined,
          }
        }
      } catch {}
      const originalBytes = Number.parseInt(raw, 10)
      return Number.isSafeInteger(originalBytes) && originalBytes >= 0
        ? { originalBytes }
        : undefined
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

  async #write(data: string | Buffer): Promise<void> {
    if (!this.#file) throw new Error('stage log is not open')
    await this.#file.writeFile(data)
  }
}

export function noMistakesHome(): string {
  return process.env.ORCA_NO_MISTAKES_HOME ?? path.join(homedir(), '.orca-no-mistakes')
}

export function defaultLedgerPath(): string {
  return path.join(noMistakesHome(), 'ledger.db')
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  submission_commit_oid TEXT NOT NULL,
  terminal_commit_oid TEXT,
  intent TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  policy_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('in-progress', 'passed', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  completed_at TEXT
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
CREATE INDEX IF NOT EXISTS idx_stage_evidence_run ON stage_evidence(run_id);
CREATE INDEX IF NOT EXISTS idx_stage_evidence_stage
  ON stage_evidence(run_id, stage_id, round_index);
CREATE INDEX IF NOT EXISTS idx_gate_audit_run ON gate_audit(run_id);

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
`

export class DomainLedger {
  readonly #db: DatabaseSync
  readonly #path: string

  constructor(dbPath: string = defaultLedgerPath()) {
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(dbPath), { recursive: true })
    }
    this.#path = dbPath
    this.#db = new DatabaseSync(dbPath)
    this.#db.exec('PRAGMA journal_mode = WAL')
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
    this.#db.exec(SCHEMA)
    // ponytail: nullable columns added post-release use the idempotent ALTER
    // path. Only the expected duplicate-column failure is tolerated.
    for (const [table, column] of [
      ['stage_evidence', 'effective_policy_hash TEXT'],
      ['stage_evidence', 'base_ref_sha TEXT'],
      ['stage_evidence', 'artifact_sha256 TEXT'],
      ['stage_evidence', 'findings_json TEXT'],
      ['gate_audit', 'selected_finding_ids TEXT']
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
    baseBranch: string
    branch: string
    intent: string
    policySha256: string
    repoRoot: string
    runId: string
    submissionCommitOid: string
  }): void {
    this.#db
      .prepare(
        `INSERT INTO runs (
           run_id, repo_root, branch, base_branch, submission_commit_oid, terminal_commit_oid,
           intent, intent_hash, policy_sha256, status, created_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'in-progress', ?, NULL)`
      )
      .run(
        input.runId,
        input.repoRoot,
        input.branch,
        input.baseBranch,
        input.submissionCommitOid,
        input.intent,
        intentHash(input.intent),
        input.policySha256,
        new Date().toISOString()
      )
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
      const nextToken = Number(existing.generation_token) + 1
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

  #nextGenerationToken(repoRoot: string): number {
    const row = this.#db
      .prepare('SELECT next_token FROM lease_generations WHERE repo_root = ?')
      .get(repoRoot) as { next_token: number | bigint } | undefined
    const token = row ? Number(row.next_token) : 1
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

  releaseLease(runId: string): void {
    this.#db.prepare('DELETE FROM branch_leases WHERE run_id = ?').run(runId)
  }

  settleRun(
    runId: string,
    status: 'cancelled' | 'failed',
    ownership?: { branch: string; repoRoot: string }
  ): boolean {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.runIdentity(runId)
      const lease =
        ownership === undefined ? undefined : this.leaseFor(ownership.repoRoot, ownership.branch)
      if (
        ownership !== undefined &&
        (!run ||
          run.repo_root !== ownership.repoRoot ||
          run.branch !== ownership.branch ||
          (run.status === 'in-progress'
            ? lease?.run_id !== runId
            : run.status !== status))
      ) {
        this.#db.exec('COMMIT')
        return false
      }
      const settled = this.finishRun(runId, status)
      if (settled || run?.status === status) this.releaseLease(runId)
      this.#db.exec('COMMIT')
      return ownership === undefined ? settled : settled || run?.status === status
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  finalizePassedRun(
    manifest: PassedAttestationManifest,
    terminalCommitOid: string
  ): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      if (!this.finishRun(manifest.runId, 'passed', terminalCommitOid)) {
        throw new Error(`run ${manifest.runId} is already settled`)
      }
      this.releaseLease(manifest.runId)
      this.recordAttestation(manifest)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  recordCheckpoint(input: {
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

  recordEvidence(input: {
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
  }): string {
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
                summary, findings_json
         FROM stage_evidence WHERE run_id = ? ORDER BY stage_id, round_index, rowid`
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
  verifyEvidence(manifest: PassedAttestationManifest): string[] {
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
      if (row.findings_json !== null) {
        let artifactFindings: unknown
        try {
          const parsed = JSON.parse(artifact.toString('utf8')) as { findings?: unknown } | null
          if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'findings')) {
            throw new Error('artifact findings are unreadable')
          }
          artifactFindings = parsed.findings
        } catch {
          problems.push(`${label}: artifact findings are unreadable`)
          continue
        }
        if (JSON.stringify(artifactFindings) !== row.findings_json) {
          problems.push(`${label}: recorded findings do not match the attested artifact`)
          continue
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
            audit?.stage_id === entry.stage &&
            audit.round_index === entry.round &&
            audit.decision === waiver.decision &&
            audit.resolved_at !== null
          )
        })
        .map((entry) => entry.evidenceSha256)
    )
    // listEvidence orders by (stage_id, round_index, rowid), so the last row
    // written for a stage is the one left in the map.
    const latest = new Map<string, StageEvidenceRow>()
    for (const row of evidence.rows) latest.set(row.stage_id, row)
    const blockers: string[] = []
    for (const row of latest.values()) {
      const label = `${row.stage_id} round ${row.round_index}`
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
           gate_id, run_id, stage_id, round_index, gate_kind, question, options_json,
           resolution, decision, guidance, opened_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 'pending', NULL, ?)
         ON CONFLICT(gate_id) DO NOTHING`
      )
      .run(
        input.gateId,
        input.runId,
        input.stageId,
        input.roundIndex,
        input.gateKind,
        input.question,
        input.optionsJson,
        new Date().toISOString()
      )
  }

  recordGateAudit(input: {
    decision: string
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
    this.#db
      .prepare(
         `INSERT INTO gate_audit (
            gate_id, run_id, stage_id, round_index, gate_kind, question, options_json,
            resolution, decision, guidance, selected_finding_ids, opened_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(gate_id) DO UPDATE SET
            resolution = excluded.resolution,
            decision = excluded.decision,
            guidance = excluded.guidance,
            selected_finding_ids = excluded.selected_finding_ids,
            resolved_at = excluded.resolved_at`
      )
      .run(
        input.gateId,
        input.runId,
        input.stageId,
        input.roundIndex,
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

  recordAttestation(manifest: PassedAttestationManifest): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO passed_attestations (
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

  getAttestation(ref: string): PassedAttestationManifest {
    const manifest = this.findAttestation(ref)
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
    const row = (this.#db
      .prepare('SELECT manifest_json, merkle_root FROM passed_attestations WHERE run_id = ?')
      .get(ref)
      ?? this.#db
        .prepare(
          'SELECT manifest_json, merkle_root FROM passed_attestations WHERE candidate_commit_oid = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
        )
        .get(ref)) as { manifest_json: string; merkle_root: string } | undefined
    if (!row) return undefined
    const manifest = JSON.parse(row.manifest_json) as PassedAttestationManifest
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
      const remove = this.#db.prepare(
        "DELETE FROM runs WHERE run_id = ? AND status <> 'in-progress' AND run_id NOT IN (SELECT run_id FROM branch_leases)"
      )
      for (const runId of runIds) pruned += Number(remove.run(runId).changes)
      this.#db.exec('COMMIT')
      return pruned
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
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

  listCheckpoints(
    runId: string
  ): { input_commit_oid: string; output_commit_oid: string; round_index: number; stage_id: string }[] {
    return this.#db
      .prepare(
        'SELECT input_commit_oid, output_commit_oid, round_index, stage_id FROM stage_checkpoints WHERE run_id = ? ORDER BY id'
      )
      .all(runId) as { input_commit_oid: string; output_commit_oid: string; round_index: number; stage_id: string }[]
  }

  listGateAudit(runId: string): GateAuditRow[] {
    return this.#db
      .prepare(
        `SELECT decision, gate_id, stage_id, round_index, gate_kind, guidance, question, resolution,
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
                  WHERE e.run_id = g.run_id AND e.stage_id = g.stage_id
                    AND e.round_index = g.round_index AND e.findings_json IS NOT NULL
                  ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1) AS findings_json,
                g.round_index, g.run_id, g.selected_finding_ids, g.stage_id
           FROM gate_audit g
           JOIN runs r ON r.run_id = g.run_id
           JOIN runs current_run ON current_run.run_id = ?
          WHERE r.repo_root = ? AND r.branch = ? AND r.rowid <= current_run.rowid
            AND g.stage_id IN ('review', 'test', 'document', 'lint')
            AND g.resolved_at IS NOT NULL AND g.selected_finding_ids IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM stage_evidence e
               WHERE e.run_id = g.run_id AND e.stage_id = g.stage_id
                 AND e.round_index = g.round_index AND e.findings_json IS NOT NULL
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
}
