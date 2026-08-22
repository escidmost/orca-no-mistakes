import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
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

const HEX_40 = /^[0-9a-f]{40}$/
const HEX_64 = /^[0-9a-f]{64}$/

export function evidenceSha256(input: {
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

function canonicalEntry(entry: StageEvidenceManifestEntry): string {
  return JSON.stringify({
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
  if (!HEX_40.test(manifest.candidateCommitOid) || !HEX_40.test(manifest.baseCommitOid)) {
    throw new Error('attestation commit SHAs are not 40-character hex values')
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

export function capLog(content: string, maxBytes = MAX_LOG_BYTES): string {
  const source = Buffer.from(content, 'utf8')
  if (source.length <= maxBytes) return content
  const keep = Math.max(0, Math.floor((maxBytes - 512) / 2))
  const marker = `\n[no-mistakes: log truncated; retained first and last ${keep} of ${source.length} bytes]\n`
  return `${source.subarray(0, keep).toString('utf8')}${marker}${source.subarray(source.length - keep).toString('utf8')}`
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
      this.#db.exec('DROP TABLE passed_attestations')
    }
    this.#db.exec(SCHEMA)
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
  }): string {
    const evidenceId = randomUUID()
    this.#db
      .prepare(
        `INSERT INTO stage_evidence (
           evidence_id, run_id, stage_id, round_index, candidate_commit_oid, base_commit_oid,
           worker_identity, exit_code, evidence_sha256, artifact_path, summary, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

  waiverForStage(runId: string, stageId: string, roundIndex: number): GateDecisionRecord | undefined {
    const row = this.#db
      .prepare(
        `SELECT gate_id, decision, resolved_at FROM gate_audit
         WHERE run_id = ? AND stage_id = ? AND round_index = ? AND decision IN ('approve', 'skip')
         ORDER BY resolved_at DESC LIMIT 1`
      )
      .get(runId, stageId, roundIndex) as
      | { decision: string; gate_id: string; resolved_at: string }
      | undefined
    if (!row || (row.decision !== 'approve' && row.decision !== 'skip')) return undefined
    return { decision: row.decision, gateId: row.gate_id, resolvedAt: row.resolved_at }
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
          'SELECT manifest_json, merkle_root FROM passed_attestations WHERE candidate_commit_oid = ? ORDER BY created_at DESC LIMIT 1'
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
    for (const row of rows) {
      this.#db.prepare('DELETE FROM runs WHERE run_id = ?').run(row.run_id)
    }
    return rows.map((row) => row.run_id)
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
