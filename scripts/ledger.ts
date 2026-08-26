import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_RDWR, O_WRONLY } from 'node:constants'
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type RunStatus = 'in-progress' | 'passed' | 'failed' | 'cancelled'

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
  version: '1.0.0'
  runId: string
  candidateCommitOid: string
  baseCommitOid: string
  policySha256: string
  intent: string
  intentHash: string
  stageEvidence: StageEvidenceManifestEntry[]
  merkleRoot: string
  coordinatorVersion: string
  createdAt: string
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function intentHash(intent: string): string {
  return sha256(intent)
}

const HEX_64 = /^[0-9a-f]{64}$/
export const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export function evidenceSha256(input: {
  artifactSha256: string
  baseCommitOid: string
  candidateCommitOid: string
  exitCode: number
  round: number
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

export function buildAttestation(
  entries: StageEvidenceManifestEntry[],
  meta: {
    baseCommitOid: string
    candidateCommitOid: string
    intent: string
    policySha256: string
    runId: string
  }
): PassedAttestationManifest {
  const manifest: PassedAttestationManifest = {
    version: '1.0.0',
    runId: meta.runId,
    candidateCommitOid: meta.candidateCommitOid,
    baseCommitOid: meta.baseCommitOid,
    policySha256: meta.policySha256,
    intent: meta.intent,
    intentHash: intentHash(meta.intent),
    stageEvidence: entries,
    merkleRoot: merkleRoot(entries.map((entry) => sha256(canonicalEntry(entry)))),
    coordinatorVersion: COORDINATOR_VERSION,
    createdAt: new Date().toISOString()
  }
  verifyManifest(manifest)
  return manifest
}

export function verifyManifest(manifest: PassedAttestationManifest): void {
  if (!manifest || manifest.version !== '1.0.0') {
    throw new Error('attestation version is not 1.0.0')
  }
  if (!COMMIT_OID.test(manifest.candidateCommitOid) || !COMMIT_OID.test(manifest.baseCommitOid)) {
    throw new Error('attestation commit OIDs are not 40- or 64-character hex values')
  }
  if (!HEX_64.test(manifest.policySha256)) throw new Error('attestation policy hash is not a SHA-256')
  if (manifest.intentHash !== intentHash(manifest.intent)) {
    throw new Error('attestation intent hash does not match the recorded intent')
  }
  for (const entry of manifest.stageEvidence) {
    if (!HEX_64.test(entry.evidenceSha256)) {
      throw new Error(`stage ${entry.stage} evidence hash is not a SHA-256`)
    }
    if (evidenceSha256(entry) !== entry.evidenceSha256) {
      throw new Error(`stage ${entry.stage} evidence hash does not match its recorded fields`)
    }
  }
  const root = merkleRoot(manifest.stageEvidence.map((entry) => sha256(canonicalEntry(entry))))
  if (root !== manifest.merkleRoot) {
    throw new Error('attestation Merkle root does not match its stage evidence')
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
 * Rejects a symlink anywhere from the artifact root down to `target`, including
 * the root itself. Checking only the final parent leaves a symlinked component
 * free to land the log inside the repository once `mkdir -p` follows it; the
 * walk stops at the first component that does not exist yet, so callers run it
 * again after creating the directory when the whole chain is present. The log
 * file itself is left to `O_NOFOLLOW` on open.
 */
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
    let entry
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

function isWithin(root: string, target: string): boolean {
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
 * The budget belongs to the file, not the instance: the workers of one stage
 * round share a single bounded artifact, and a round whose combined output
 * still fits keeps every byte of it.
 */
export class StageLog {
  readonly #path: string
  readonly #keep: number
  readonly #maxBytes: number
  #carry = ''
  #fileBytes = 0
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

  append(chunk: string): Promise<void> {
    const pending = this.#pending.then(() => this.#append(chunk))
    this.#pending = pending.catch(() => {})
    return pending
  }

  async #append(chunk: string): Promise<void> {
    if (chunk.length === 0) return
    await this.#start()
    const secrets = knownSecrets()
    const redacted = applyRedaction(`${this.#carry}${chunk}`, secrets)
    // Hold back only a trailing partial secret, so a credential split across two
    // drain pages is whole the next time redaction runs while ordinary output
    // still reaches disk immediately. `[REDACTED]` contains no secret, so
    // re-scanning what is carried stays idempotent.
    const hold = pendingSecretPrefix(redacted, secrets)
    this.#carry = redacted.slice(redacted.length - hold)
    await this.#absorb(redacted.slice(0, redacted.length - hold))
    if (this.#hasNewOutput) await this.#recordOriginalBytes()
  }

  async close(): Promise<void> {
    try {
      await this.#pending
      if (this.#carry.length > 0) {
        const carried = this.#carry
        this.#carry = ''
        await this.#start()
        await this.#absorb(redactKnownSecrets(carried))
      }
      // A silent instance never opens the log, so a worker that printed
      // nothing cannot disturb what the round already recorded.
      if (!this.#hasNewOutput) return
      if (this.#compacted) await this.#compact()
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
   * Rewrites an over-cap log as head + marker + tail. Runs only once the file
   * actually exceeds the cap, so a round whose combined output still fits keeps
   * every byte, and the bytes are sliced positionally -- nothing in the file is
   * parsed, so worker output cannot influence the result.
   */
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

  async #compact(): Promise<void> {
    const file = this.#file
    if (!file) return
    // Read from position 0 explicitly: the handle is opened O_APPEND and sits
    // at EOF, so a position-relative read returns nothing.
    const size = (await file.stat()).size
    // read() may return fewer bytes than asked for, and the buffer is
    // uninitialized, so a short read would copy unrelated process memory into
    // the artifact. Fill it, and slice to what actually arrived.
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
      let existingBytes = (await file.stat()).size
      await file.chmod(0o600)
      // The first `keep` bytes are the round's head and never change; whatever
      // follows is the previous worker's marker and tail, which this worker's
      // output replaces so the file ends with the round's final tail. Nothing
      // already on disk is parsed back, so worker text cannot forge accounting.
      const prior = await this.#priorAccounting()
      this.#originalBytesKnown = existingBytes === 0 || prior !== undefined
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
      this.#file = file
      this.#started = true
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
   * The round's byte total carried between workers. It lives beside the log
   * rather than inside it because a count parsed back out of the log would be
   * worker-writable, and a worker could forge its own truncation accounting.
   */
  async #priorAccounting(): Promise<
    { fileBytes?: number; originalBytes: number } | undefined
  > {
    let file
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
          originalBytes?: unknown
        }
        if (
          Number.isSafeInteger(parsed.originalBytes) &&
          (parsed.originalBytes as number) >= 0 &&
          Number.isSafeInteger(parsed.fileBytes) &&
          (parsed.fileBytes as number) >= 0
        ) {
          return {
            fileBytes: parsed.fileBytes as number,
            originalBytes: parsed.originalBytes as number,
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
    if (!this.#originalBytesKnown) return
    // O_NOFOLLOW so a symlink planted at the sidecar path cannot redirect this
    // write onto an arbitrary file, matching how the log itself is opened.
    try {
      await this.#replaceFile(this.#metaPath(), [
        Buffer.from(
          JSON.stringify({
            fileBytes: this.#fileBytes,
            originalBytes: this.#originalBytes,
          }),
          'utf8',
        ),
      ])
    } catch {}
  }

  #truncationMarker(headBytes: number, tailBytes: number): string {
    const dropped = Math.max(0, this.#originalBytes - headBytes - tailBytes)
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
  summary TEXT NOT NULL,
  effective_policy_hash TEXT,
  base_ref_sha TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gate_audit (
  gate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL,
  round_index INTEGER NOT NULL,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  resolution TEXT NOT NULL,
  decision TEXT NOT NULL,
  guidance TEXT,
  resolved_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stage_checkpoints_run ON stage_checkpoints(run_id);
CREATE INDEX IF NOT EXISTS idx_stage_evidence_run ON stage_evidence(run_id);
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
    this.#db.exec(SCHEMA)
    // ponytail: nullable provenance columns added post-release; ALTER is the
    // idempotent path for ledgers created before ONM-40. Only the expected
    // duplicate-column failure is tolerated — anything else fails startup.
    for (const column of ['effective_policy_hash TEXT', 'base_ref_sha TEXT']) {
      try {
        this.#db.exec(`ALTER TABLE stage_evidence ADD COLUMN ${column}`)
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

  finishRun(runId: string, status: Exclude<RunStatus, 'in-progress'>, terminalCommitOid?: string): void {
    this.#db
      .prepare('UPDATE runs SET status = ?, completed_at = ?, terminal_commit_oid = COALESCE(?, terminal_commit_oid) WHERE run_id = ?')
      .run(status, new Date().toISOString(), terminalCommitOid ?? null, runId)
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
    baseCommitOid: string
    candidateCommitOid: string
    evidenceSha256: string
    exitCode: number
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
           worker_identity, exit_code, evidence_sha256, artifact_path, summary,
           effective_policy_hash, base_ref_sha, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        input.summary,
        input.effectivePolicyHash ?? null,
        input.baseRefSha ?? null,
        new Date().toISOString()
      )
    return evidenceId
  }

  recordGateAudit(input: {
    decision: string
    gateId: string
    guidance?: string
    optionsJson: string
    question: string
    resolution: string
    roundIndex: number
    runId: string
    stageId: string
  }): void {
    this.#db
      .prepare(
        `INSERT INTO gate_audit (
           gate_id, run_id, stage_id, round_index, question, options_json, resolution, decision, guidance, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(gate_id) DO UPDATE SET
           resolution = excluded.resolution,
           decision = excluded.decision,
           guidance = excluded.guidance,
           resolved_at = excluded.resolved_at`
      )
      .run(
        input.gateId,
        input.runId,
        input.stageId,
        input.roundIndex,
        input.question,
        input.optionsJson,
        input.resolution,
        input.decision,
        input.guidance ?? null,
        new Date().toISOString()
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
    const row = (this.#db
      .prepare('SELECT manifest_json, merkle_root FROM passed_attestations WHERE run_id = ?')
      .get(ref)
      ?? this.#db
        .prepare(
          'SELECT manifest_json, merkle_root FROM passed_attestations WHERE candidate_commit_oid = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
        )
        .get(ref)) as { manifest_json: string; merkle_root: string } | undefined
    if (!row) throw new Error(`no passed attestation found for ${ref}`)
    const manifest = JSON.parse(row.manifest_json) as PassedAttestationManifest
    if (manifest.merkleRoot !== row.merkle_root) {
      throw new Error('stored attestation manifest does not match the ledger Merkle root')
    }
    return manifest
  }

  prune(options: { before?: Date; repoSubstring?: string }): string[] {
    const before = options.before ? options.before.toISOString() : null
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.#db
        .prepare(
          `SELECT run_id FROM runs
           WHERE status <> 'in-progress'
             AND completed_at IS NOT NULL
             AND (? IS NULL OR completed_at < ?)
             AND (? IS NULL OR instr(repo_root, ?) > 0)`
        )
        .all(before, before, options.repoSubstring ?? null, options.repoSubstring ?? null) as {
        run_id: string
      }[]
      const runIds = rows.map((row) => row.run_id)
      if (runIds.length > 0) {
        const placeholders = runIds.map(() => '?').join(', ')
        this.#db.prepare(`DELETE FROM runs WHERE run_id IN (${placeholders})`).run(...runIds)
      }
      this.#db.exec('COMMIT')
      return runIds
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

  listGateAudit(
    runId: string
  ): { decision: string; gate_id: string; guidance: string | null; resolution: string }[] {
    return this.#db
      .prepare('SELECT decision, gate_id, guidance, resolution FROM gate_audit WHERE run_id = ? ORDER BY resolved_at')
      .all(runId) as { decision: string; gate_id: string; guidance: string | null; resolution: string }[]
  }

  close(): void {
    this.#db.close()
  }
}
