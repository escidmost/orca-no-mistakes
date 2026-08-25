import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { O_APPEND, O_CREAT, O_NOFOLLOW, O_RDWR } from 'node:constants'
import { chmod, mkdir, open } from 'node:fs/promises'
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
const TRUNCATION_MARKER_PATTERN =
  /\n\[no-mistakes: log truncated; dropped (\d+) bytes; original bytes (\d+); retained ranges [^\]]+\]\n/g

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
 * The head is written straight to disk so a crashed run still keeps its opening
 * diagnostics; once the head budget is spent the tail is retained in memory and
 * flushed by `close`, so the middle is what a runaway worker loses.
 *
 * The budget belongs to the file, not the instance: the workers of one stage
 * round open it in turn, and each reads what is already there so their combined
 * output still lands under `maxBytes`.
 */
export class StageLog {
  readonly #path: string
  readonly #keep: number
  readonly #maxBytes: number
  #dropped = 0
  #headBytes = 0
  #started = false
  #tail: Buffer[] = []
  #tailBytes = 0
  #tailKeep = 0
  #file?: Awaited<ReturnType<typeof open>>
  #originalBytes = 0
  #hasNewOutput = false

  constructor(filePath: string, maxBytes = MAX_LOG_BYTES) {
    this.#path = filePath
    this.#maxBytes = maxBytes
    this.#keep = Math.max(0, Math.floor((maxBytes - 512) / 2))
  }

  async append(chunk: string): Promise<void> {
    await this.#start()
    let pending = Buffer.from(chunk, 'utf8')
    if (pending.length === 0) return
    this.#originalBytes += pending.length
    this.#hasNewOutput = true
    if (this.#headBytes < this.#keep) {
      const head = pending.subarray(0, this.#keep - this.#headBytes)
      await this.#write(head)
      this.#headBytes += head.length
      pending = pending.subarray(head.length)
    }
    if (pending.length === 0) return
    this.#tail.push(pending)
    this.#tailBytes += pending.length
    while (this.#tailBytes > this.#tailKeep) {
      const oldest = this.#tail[0]!
      const cut = Math.min(oldest.length, this.#tailBytes - this.#tailKeep)
      if (cut === oldest.length) this.#tail.shift()
      else this.#tail[0] = oldest.subarray(cut)
      this.#tailBytes -= cut
      this.#dropped += cut
    }
  }

  async close(): Promise<void> {
    try {
      if (!this.#hasNewOutput) return
      await this.#start()
      if (this.#dropped > 0) {
        await this.#write(this.#truncationMarker())
      }
      if (this.#tail.length > 0) {
        await this.#write(Buffer.concat(this.#tail))
      }
      this.#tail = []
    } finally {
      const file = this.#file
      this.#file = undefined
      if (file) await file.close()
    }
  }

  async #start(): Promise<void> {
    if (this.#started) return
    const directory = path.dirname(this.#path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const file = await open(
      this.#path,
      O_APPEND | O_CREAT | O_RDWR | O_NOFOLLOW,
      0o600,
    )
    try {
      const existing = await file.readFile()
      const existingText = existing.toString('utf8')
      const prior = [...existingText.matchAll(TRUNCATION_MARKER_PATTERN)].at(-1)
      const headBytes = prior
        ? Buffer.byteLength(existingText.slice(0, prior.index ?? 0))
        : Math.min(existing.length, this.#keep)
      await file.chmod(0o600)
      this.#originalBytes = prior ? Number(prior[2]) : existing.length
      this.#dropped = Math.max(0, this.#originalBytes - headBytes)
      await file.truncate(headBytes)
      this.#file = file
      this.#started = true
      this.#headBytes = headBytes
      this.#tailKeep = Math.max(
        0,
        Math.min(this.#keep, this.#maxBytes - headBytes - 512),
      )
    } catch (error) {
      await file.close()
      throw error
    }
  }

  #truncationMarker(): string {
    const headBytes = Math.min(this.#originalBytes, this.#keep)
    const ranges = []
    if (headBytes > 0) ranges.push(`0-${headBytes - 1}`)
    if (this.#tailBytes > 0) {
      ranges.push(
        `${this.#originalBytes - this.#tailBytes}-${this.#originalBytes - 1}`,
      )
    }
    return `\n[no-mistakes: log truncated; dropped ${this.#dropped} bytes; original bytes ${this.#originalBytes}; retained ranges ${ranges.join(", ") || "none"}]\n`
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
