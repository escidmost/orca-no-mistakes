import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  canonicalJson,
  DomainLedger,
  normalizeIntent,
  RUN_ID_PATTERN,
  sha256,
  type SubmissionAdmissionInput,
  type SubmissionAdmissionRow
} from './ledger.ts'

export const GATE_REMOTE_NAME = 'orca-no-mistakes'
export const GATE_STATE_DIRECTORY = 'orca-no-mistakes'
export const GATE_DIRECTORY_NAME = 'gate.git'
export const INTENT_PUSH_OPTION_PREFIX = 'no-mistakes.intent='
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const REF_NAME = /^refs\/heads\/(.+)$/u
const ZERO_OBJECT_ID = /^(?:0{40}|0{64})$/u

export type ReceiveUpdate = {
  newOid: string
  oldOid: string
  refName: string
}

export type ValidatedReceive = ReceiveUpdate & {
  intent: string
  noEvent: boolean
}

export type GatePaths = {
  commonDir: string
  gatePath: string
  repoRoot: string
  stateDir: string
}

export type GateMetadata = GatePaths & {
  defaultBranch: string
  gateIdentity: string
  hookVersion: 1
  remoteName: typeof GATE_REMOTE_NAME
  version: 1
}

export type LaunchReadiness = {
  error?: string
  nonce?: string
  runId?: string
  state: 'failed' | 'ready'
}

export type AdmissionIdentityInput = Pick<
  SubmissionAdmissionInput,
  'gateIdentity' | 'intent' | 'newOid' | 'oldOid' | 'refName'
>

export function deriveSubmissionIdentity(input: AdmissionIdentityInput): string {
  const intent = normalizeIntent(input.intent)
  return sha256(
    canonicalJson({
      gateIdentity: input.gateIdentity,
      intentHash: sha256(intent),
      newOid: input.newOid,
      refName: input.refName
    })
  )
}

export function deriveAdmissionId(input: AdmissionIdentityInput): string {
  return `admission-${deriveSubmissionIdentity(input)}`
}

export function repositoryGatePaths(repoPath: string): GatePaths {
  const requestedPath = path.resolve(repoPath)
  const repoRoot = path.resolve(gitSync(['-C', requestedPath, 'rev-parse', '--show-toplevel']))
  const commonDirValue = gitSync([
    '-C',
    repoRoot,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir'
  ])
  const commonDir = path.resolve(commonDirValue)
  const stateDir = path.join(commonDir, GATE_STATE_DIRECTORY)
  return {
    commonDir,
    gatePath: path.join(stateDir, GATE_DIRECTORY_NAME),
    repoRoot,
    stateDir
  }
}

export function parseReceiveUpdates(input: string): ReceiveUpdate[] {
  if (!input) return []
  const lines = input.endsWith('\n') ? input.slice(0, -1).split('\n') : input.split('\n')
  if (lines.some((line) => !line)) throw new Error('pre-receive input contains an empty update')
  return lines.map((line) => {
    const fields = line.endsWith('\r') ? line.slice(0, -1).split(' ') : line.split(' ')
    if (fields.length !== 3 || fields.some((field) => !field)) {
      throw new Error('pre-receive input must contain old OID, new OID, and ref')
    }
    return { newOid: fields[1], oldOid: fields[0], refName: fields[2] }
  })
}

export function validateReceiveUpdate(
  updates: readonly ReceiveUpdate[],
  defaultBranch: string,
  intent: string
): ValidatedReceive {
  if (updates.length !== 1) {
    throw new Error('the local gate accepts exactly one feature ref update')
  }
  const [update] = updates
  if (!OBJECT_ID.test(update.oldOid) || !OBJECT_ID.test(update.newOid)) {
    throw new Error('feature ref updates must use full lowercase Git object IDs')
  }
  if (update.oldOid.length !== update.newOid.length) {
    throw new Error('feature ref updates must use one Git object format')
  }
  if (ZERO_OBJECT_ID.test(update.newOid)) {
    throw new Error('feature ref deletion is not accepted by the local gate')
  }
  const match = REF_NAME.exec(update.refName)
  if (!match || !validBranchName(match[1])) {
    throw new Error('the local gate accepts only valid refs/heads feature refs')
  }
  const normalizedDefaultBranch = defaultBranch.replace(/^refs\/heads\//u, '')
  if (match[1] === normalizedDefaultBranch) {
    throw new Error('the local gate does not accept the default branch')
  }
  const normalizedIntent = normalizeIntent(intent)
  return {
    ...update,
    intent: normalizedIntent,
    noEvent: update.oldOid === update.newOid
  }
}

export function decodeIntentPushOption(environment: NodeJS.ProcessEnv): string {
  if (environment.GIT_PUSH_OPTION_COUNT !== '1') {
    throw new Error('the local gate requires exactly one intent push option')
  }
  const option = environment.GIT_PUSH_OPTION_0
  if (!option) throw new Error('the local gate requires an intent push option')
  if (!option.startsWith(INTENT_PUSH_OPTION_PREFIX)) {
    throw new Error('the local gate received an unknown push option')
  }
  const encoded = option.slice(INTENT_PUSH_OPTION_PREFIX.length)
  if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error('the intent push option must contain unpadded base64url data')
  }
  let decoded: string
  try {
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.toString('base64url') !== encoded) throw new Error('non-canonical base64url')
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('the intent push option is not valid UTF-8 base64url data')
  }
  return normalizeIntent(decoded)
}

export function sanitizeCoordinatorEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const allowed = new Set([
    'ALL_PROXY',
    'CI',
    'COLORTERM',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'HOME',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'LANG',
    'LC_ALL',
    'LOGNAME',
    'NO_COLOR',
    'NO_PROXY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY',
    'XAI_API_KEY',
    'PATH',
    'SHELL',
    'SSH_AUTH_SOCK',
    'TERM',
    'TMPDIR',
    'USER',
    'XDG_CONFIG_HOME',
    'ORCA_CLI_COMMAND',
    'ORCA_NO_MISTAKES_HOME'
  ])
  const environment: NodeJS.ProcessEnv = {}
  for (const key of allowed) {
    if (source[key] !== undefined) environment[key] = source[key]
  }
  return environment
}

export async function initializeLocalGate(
  repoPath: string,
  executablePath: string
): Promise<GateMetadata> {
  const paths = repositoryGatePaths(repoPath)
  const gateExisted = existsSync(paths.gatePath)
  const metadataPath = path.join(paths.stateDir, 'gate.json')
  const metadataExisted = existsSync(metadataPath)
  const previousRemote = tryGitSync(['-C', paths.repoRoot, 'remote', 'get-url', GATE_REMOTE_NAME])
  const previousPushUrls = tryGitSync([
    '-C',
    paths.repoRoot,
    'config',
    '--get-all',
    `remote.${GATE_REMOTE_NAME}.pushurl`
  ])
  if (metadataExisted) {
    let recordedRoot: string | undefined
    try {
      const parsed = JSON.parse(await readFile(metadataPath, 'utf8')) as Partial<GateMetadata>
      if (typeof parsed.repoRoot === 'string') recordedRoot = parsed.repoRoot
    } catch {
      // Malformed metadata is repaired by re-initialization.
    }
    if (recordedRoot && path.resolve(recordedRoot) !== path.resolve(paths.repoRoot)) {
      throw new Error(
        `the local gate is routed to ${recordedRoot}; initialize it from that worktree to keep one repository-wide route`
      )
    }
  }
  try {
    if (!tryGitSync(['-C', paths.repoRoot, 'remote', 'get-url', 'origin'])) {
      throw new Error('the repository must have an origin remote before gate initialization')
    }
    const objectFormat = gitSync(['-C', paths.repoRoot, 'rev-parse', '--show-object-format'])
    if (!gateExisted) {
      await mkdir(paths.stateDir, { recursive: true })
      gitSync([
        'init',
        '--bare',
        '--quiet',
        `--object-format=${objectFormat}`,
        paths.gatePath
      ])
    } else {
      const isBare = tryGitSync([
        '--git-dir',
        paths.gatePath,
        'rev-parse',
        '--is-bare-repository'
      ])
      if (isBare !== 'true') {
        throw new Error('the existing gate path is not a bare repository')
      }
      const gateFormat = tryGitSync(['--git-dir', paths.gatePath, 'rev-parse', '--show-object-format'])
      if (gateFormat !== objectFormat) {
        throw new Error(
          `the existing gate object format ${gateFormat ?? 'unknown'} does not match the repository object format ${objectFormat}`
        )
      }
    }
    await mkdir(path.join(paths.gatePath, 'hooks'), { recursive: true })
    gitSync(['--git-dir', paths.gatePath, 'config', 'core.hooksPath', path.join(paths.gatePath, 'hooks')])
    gitSync(['--git-dir', paths.gatePath, 'config', 'receive.advertisePushOptions', 'true'])
    if (previousRemote) {
      gitSync(['-C', paths.repoRoot, 'remote', 'set-url', GATE_REMOTE_NAME, paths.gatePath])
    } else {
      gitSync(['-C', paths.repoRoot, 'remote', 'add', GATE_REMOTE_NAME, paths.gatePath])
    }
    tryGitSync(['-C', paths.repoRoot, 'config', '--unset-all', `remote.${GATE_REMOTE_NAME}.pushurl`])
    if (
      tryGitSync([
        '-C',
        paths.repoRoot,
        'config',
        '--get-all',
        `remote.${GATE_REMOTE_NAME}.pushurl`
      ]) !== undefined
    ) {
      throw new Error(`could not reset the ${GATE_REMOTE_NAME} remote push URL`)
    }
    const metadata: GateMetadata = {
      ...paths,
      defaultBranch: detectDefaultBranch(paths.repoRoot),
      gateIdentity: sha256(canonicalJson({ gatePath: paths.gatePath, repoRoot: paths.repoRoot })),
      hookVersion: 1,
      remoteName: GATE_REMOTE_NAME,
      version: 1
    }
    await writeAtomic(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 0o600)
    await writeAtomic(
      path.join(paths.gatePath, 'hooks', 'pre-receive'),
      managedHook(executablePath, paths.gatePath),
      0o755
    )
    return metadata
  } catch (error) {
    if (previousRemote) {
      tryGitSync(['-C', paths.repoRoot, 'remote', 'set-url', GATE_REMOTE_NAME, previousRemote])
      tryGitSync(['-C', paths.repoRoot, 'config', '--unset-all', `remote.${GATE_REMOTE_NAME}.pushurl`])
      for (const pushUrl of previousPushUrls?.split('\n').filter(Boolean) ?? []) {
        tryGitSync(['-C', paths.repoRoot, 'config', '--add', `remote.${GATE_REMOTE_NAME}.pushurl`, pushUrl])
      }
    } else {
      tryGitSync(['-C', paths.repoRoot, 'remote', 'remove', GATE_REMOTE_NAME])
    }
    if (!metadataExisted) await rm(metadataPath, { force: true }).catch(() => undefined)
    if (!gateExisted) await rm(paths.gatePath, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function readGateMetadata(gatePath: string): Promise<GateMetadata> {
  const metadataPath = path.join(path.dirname(gatePath), 'gate.json')
  const parsed = JSON.parse(await readFile(metadataPath, 'utf8')) as Partial<GateMetadata>
  if (
    parsed.version !== 1 ||
    parsed.hookVersion !== 1 ||
    parsed.remoteName !== GATE_REMOTE_NAME ||
    typeof parsed.repoRoot !== 'string' ||
    typeof parsed.commonDir !== 'string' ||
    typeof parsed.stateDir !== 'string' ||
    typeof parsed.gateIdentity !== 'string' ||
    typeof parsed.defaultBranch !== 'string' ||
    path.resolve(parsed.gatePath ?? '') !== path.resolve(gatePath)
  ) {
    throw new Error('local gate metadata is invalid')
  }
  const paths = repositoryGatePaths(parsed.repoRoot)
  const expectedIdentity = sha256(
    canonicalJson({ gatePath: paths.gatePath, repoRoot: paths.repoRoot })
  )
  const configuredRemote = tryGitSync(['-C', paths.repoRoot, 'remote', 'get-url', GATE_REMOTE_NAME])
  const configuredPushUrls = tryGitSync([
    '-C',
    paths.repoRoot,
    'config',
    '--get-all',
    `remote.${GATE_REMOTE_NAME}.pushurl`
  ])
  if (
    path.resolve(parsed.commonDir) !== paths.commonDir ||
    path.resolve(parsed.stateDir) !== paths.stateDir ||
    path.resolve(parsed.gatePath ?? '') !== paths.gatePath ||
    path.resolve(parsed.repoRoot) !== paths.repoRoot ||
    parsed.gateIdentity !== expectedIdentity ||
    !validBranchName(parsed.defaultBranch) ||
    configuredRemote !== paths.gatePath ||
    configuredPushUrls !== undefined ||
    detectDefaultBranch(paths.repoRoot) !== parsed.defaultBranch
  ) {
    throw new Error('local gate metadata does not match its repository')
  }
  return parsed as GateMetadata
}

export function admissionReadinessPath(metadata: GateMetadata, admissionId: string): string {
  if (!/^admission-[0-9a-f]{64}$/u.test(admissionId)) {
    throw new Error('invalid admission ID')
  }
  return path.join(metadata.stateDir, 'admissions', `${admissionId}.json`)
}

export async function writeLaunchReadiness(
  readinessPath: string,
  readiness: LaunchReadiness
): Promise<void> {
  await mkdir(path.dirname(readinessPath), { recursive: true })
  await writeAtomic(readinessPath, `${JSON.stringify(readiness)}\n`, 0o600)
}

export async function waitForLaunchReadiness(
  readinessPath: string,
  startupTimeoutMs = 30_000,
  expectedNonce?: string
): Promise<LaunchReadiness> {
  const deadline = Date.now() + startupTimeoutMs
  for (;;) {
    try {
      const readiness = JSON.parse(await readFile(readinessPath, 'utf8')) as LaunchReadiness
      if (expectedNonce !== undefined && readiness.nonce !== expectedNonce) {
        throw new Error('ENOENT')
      }
      if (readiness.state === 'ready' && typeof readiness.runId === 'string') return readiness
      if (readiness.state === 'failed') {
        throw new Error(readiness.error ?? 'coordinator launch failed')
      }
      throw new Error('coordinator readiness is invalid')
    } catch (error) {
      if (error instanceof Error && error.message !== 'ENOENT' && !error.message.includes('no such file')) {
        throw error
      }
    }
    if (Date.now() >= deadline) throw new Error('coordinator did not become ready')
    await delay(50)
  }
}

export function launchLockPath(readinessPath: string): string {
  return `${readinessPath}.lock`
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function claimAdmissionLaunch(
  lockPath: string
): Promise<{ nonce?: string; owned: boolean }> {
  if (existsSync(lockPath)) return { owned: false }
  const nonce = randomUUID()
  const staging = `${lockPath}.claim-${nonce}`
  try {
    await mkdir(staging)
    await writeFile(path.join(staging, 'nonce'), nonce, 'utf8')
    await writeFile(path.join(staging, 'owner'), `${process.pid}`, 'utf8')
    await rename(staging, lockPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return { owned: false }
    throw error
  } finally {
    await rm(staging, { force: true, recursive: true }).catch(() => undefined)
  }
  return { nonce, owned: true }
}

export async function recordCoordinatorLaunch(
  lockPath: string,
  expectedNonce?: string
): Promise<void> {
  if (expectedNonce === undefined) return
  const recordedNonce = await readFile(path.join(lockPath, 'nonce'), 'utf8')
    .then((text) => text.trim())
    .catch(() => undefined)
  if (recordedNonce !== expectedNonce) {
    throw new Error('the admission launch generation changed before the coordinator started')
  }
  const fencePath = path.join(lockPath, 'coordinator-generation')
  try {
    const fence = await open(fencePath, 'wx')
    try {
      await fence.writeFile(expectedNonce, 'utf8')
    } finally {
      await fence.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const fenced = await readFile(fencePath, 'utf8')
      .then((text) => text.trim())
      .catch(() => undefined)
    // The lock nonce was just validated as ours, so a foreign fence can only
    // be a leftover from a coordinator whose generation was reclaimed.
    if (fenced !== expectedNonce) {
      await writeFile(fencePath, expectedNonce, 'utf8')
    }
  }
  await writeFile(path.join(lockPath, 'coordinator'), `${process.pid}`, 'utf8')
  const claim = await readAdmissionLaunchClaim(lockPath)
  if (claim.nonce !== expectedNonce || claim.coordinatorPid !== process.pid) {
    throw new Error('the admission launch generation changed before the coordinator started')
  }
}

export async function readAdmissionLaunchClaim(
  lockPath: string
): Promise<{ coordinatorPid?: number; nonce?: string; ownerPid?: number }> {
  const readValue = async (name: string): Promise<string | undefined> => {
    try {
      return (await readFile(path.join(lockPath, name), 'utf8')).trim()
    } catch {
      return undefined
    }
  }
  const nonce = await readValue('nonce')
  const ownerPid = await readValue('owner')
  let coordinatorPid = await readValue('coordinator')
  if (nonce !== undefined && coordinatorPid !== undefined) {
    const fenced = await readValue('coordinator-generation')
    if (fenced !== undefined && fenced !== nonce) coordinatorPid = undefined
  }
  return {
    coordinatorPid: coordinatorPid === undefined ? undefined : Number(coordinatorPid),
    nonce,
    ownerPid: ownerPid === undefined ? undefined : Number(ownerPid)
  }
}

export async function releaseAdmissionLaunch(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true, recursive: true })
}

export type AdmissionLaunchSpawn = (nonce: string) => Promise<void>

async function reclaimIfAbandoned(
  lockPath: string
): Promise<boolean> {
  const claim = await readAdmissionLaunchClaim(lockPath)
  if (claim.nonce === undefined) return false
  const ownerAlive = claim.ownerPid !== undefined && isProcessAlive(claim.ownerPid)
  const coordinatorAlive =
    claim.coordinatorPid !== undefined && isProcessAlive(claim.coordinatorPid)
  if (!ownerAlive && !coordinatorAlive) {
    await releaseAdmissionLaunch(lockPath)
    return true
  }
  return false
}

export async function awaitAdmissionLaunch(
  readinessPath: string,
  spawnCoordinator: AdmissionLaunchSpawn,
  startupTimeoutMs = 30_000
): Promise<{ readiness: LaunchReadiness; releaseLaunch?: () => Promise<void> }> {
  const lockPath = launchLockPath(readinessPath)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claim = await claimAdmissionLaunch(lockPath)
    if (claim.owned && claim.nonce !== undefined) {
      await rm(readinessPath, { force: true })
      await spawnCoordinator(claim.nonce)
      const readiness = await waitForLaunchReadiness(
        readinessPath,
        startupTimeoutMs,
        claim.nonce
      )
      return {
        readiness,
        releaseLaunch: () => releaseAdmissionLaunch(lockPath)
      }
    }
    const existing = await readAdmissionLaunchClaim(lockPath)
    if (existing.nonce === undefined) {
      return { readiness: await waitForLaunchReadiness(readinessPath, startupTimeoutMs) }
    }
    if (await reclaimIfAbandoned(lockPath)) continue
    try {
      return {
        readiness: await waitForLaunchReadiness(readinessPath, startupTimeoutMs, existing.nonce)
      }
    } catch (error) {
      if (await reclaimIfAbandoned(lockPath)) continue
      throw error
    }
  }
  throw new Error('could not claim the admission launch')
}

export async function ensureCustodyLaunch(
  readinessPath: string,
  spawnCoordinator: AdmissionLaunchSpawn,
  startupTimeoutMs = 30_000
): Promise<{ readiness: LaunchReadiness; releaseLaunch: () => Promise<void> } | undefined> {
  const lockPath = launchLockPath(readinessPath)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claim = await claimAdmissionLaunch(lockPath)
    if (claim.owned && claim.nonce !== undefined) {
      await rm(readinessPath, { force: true })
      await spawnCoordinator(claim.nonce)
      const readiness = await waitForLaunchReadiness(
        readinessPath,
        startupTimeoutMs,
        claim.nonce
      )
      return {
        readiness,
        releaseLaunch: () => releaseAdmissionLaunch(lockPath)
      }
    }
    if (await reclaimIfAbandoned(lockPath)) continue
    return undefined
  }
  throw new Error('could not claim the admission launch')
}

export function launchDetachedCoordinator(input: {
  args: readonly string[]
  cwd: string
  entrypoint: string
  environment?: NodeJS.ProcessEnv
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [input.entrypoint, ...input.args], {
      cwd: input.cwd,
      detached: true,
      env: sanitizeCoordinatorEnvironment(input.environment),
      stdio: ['ignore', 'ignore', 'ignore']
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      if (child.pid === undefined) reject(new Error('coordinator did not receive a process ID'))
      else resolve(child.pid)
    })
  })
}

export function validateQuarantinedCommit(
  gatePath: string,
  newOid: string,
  environment: NodeJS.ProcessEnv = process.env
): void {
  if (!OBJECT_ID.test(newOid) || ZERO_OBJECT_ID.test(newOid)) {
    throw new Error('the admitted object ID is invalid')
  }
  try {
    execFileSync(
      'git',
      ['--git-dir', gatePath, '--no-replace-objects', 'cat-file', '-e', `${newOid}^{commit}`],
      { env: environment, stdio: ['ignore', 'ignore', 'ignore'] }
    )
  } catch {
    throw new Error('the proposed commit is not available as a commit object')
  }
}

export function readGateRef(metadata: GateMetadata, refName: string): string | undefined {
  return tryGitSync([
    '--git-dir',
    metadata.gatePath,
    'rev-parse',
    '--verify',
    `${refName}^{commit}`
  ])
}

export async function waitForPermanentRef(
  metadata: GateMetadata,
  update: ReceiveUpdate,
  pollMs = 100,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const current = tryGitSync([
      '--git-dir',
      metadata.gatePath,
      'rev-parse',
      '--verify',
      `${update.refName}^{commit}`
    ])
    if (current === update.newOid) return
    if (current && current !== update.oldOid) {
      throw new Error('the admitted feature ref was superseded before acceptance')
    }
    if (!current && !ZERO_OBJECT_ID.test(update.oldOid)) {
      throw new Error('the admitted feature ref was superseded before acceptance')
    }
    if (Date.now() >= deadline) {
      throw new Error('the admitted feature ref did not materialize in the gate')
    }
    await delay(pollMs)
  }
}

export function anchorPermanentRef(
  metadata: GateMetadata,
  update: ReceiveUpdate,
  runId: string
): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('invalid run ID for the admission anchor')
  const anchor = `refs/orca-no-mistakes/heads/${runId}`
  const existing = tryGitSync(['--git-dir', metadata.gatePath, 'rev-parse', '--verify', `${anchor}^{commit}`])
  const transaction = [
    'start',
    `verify ${update.refName} ${update.newOid}`,
    existing
      ? `update ${anchor} ${update.newOid} ${existing}`
      : `create ${anchor} ${update.newOid}`,
    'prepare',
    'commit',
    ''
  ].join('\n')
  try {
    execFileSync('git', ['--git-dir', metadata.gatePath, 'update-ref', '--stdin'], {
      input: transaction,
      stdio: ['pipe', 'ignore', 'ignore']
    })
  } catch {
    throw new Error('could not atomically anchor the admitted feature ref')
  }
}

export function beginGateAdmission(
  ledger: DomainLedger,
  metadata: GateMetadata,
  update: ValidatedReceive
): SubmissionAdmissionRow {
  const input: SubmissionAdmissionInput = {
    admissionId: deriveAdmissionId({
      gateIdentity: metadata.gateIdentity,
      intent: update.intent,
      newOid: update.newOid,
      oldOid: update.oldOid,
      refName: update.refName
    }),
    gateIdentity: metadata.gateIdentity,
    intent: update.intent,
    newOid: update.newOid,
    oldOid: update.oldOid,
    refName: update.refName,
    repoRoot: metadata.repoRoot,
    source: 'gate'
  }
  return ledger.beginSubmissionAdmission(input)
}

function validBranchName(branch: string): boolean {
  if (!branch) return false
  try {
    gitSync(['check-ref-format', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

function detectDefaultBranch(repoRoot: string): string {
  const remoteHead = tryGitSync([
    '-C',
    repoRoot,
    'symbolic-ref',
    '--short',
    'refs/remotes/origin/HEAD'
  ])
  if (remoteHead?.startsWith('origin/')) {
    return verifyOriginDefaultBranch(repoRoot, remoteHead.slice('origin/'.length))
  }
  for (const candidate of ['main', 'master']) {
    if (tryGitSync(['-C', repoRoot, 'show-ref', '--verify', `refs/remotes/origin/${candidate}`])) {
      return verifyOriginDefaultBranch(repoRoot, candidate)
    }
  }
  const remoteBranches = (tryGitSync([
    '-C',
    repoRoot,
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/remotes/origin'
  ]) ?? '')
    .split('\n')
    .filter((ref) => ref && ref !== 'origin/HEAD')
    .map((ref) => ref.slice('origin/'.length))
  if (remoteBranches.length === 1) {
    return verifyOriginDefaultBranch(repoRoot, remoteBranches[0])
  }
  if (!remoteBranches.length) {
    const advertisedDefault = advertisedOriginDefaultBranch(repoRoot)
    if (advertisedDefault) return advertisedDefault
    const localHead = tryGitSync(['-C', repoRoot, 'symbolic-ref', '--short', 'HEAD'])
    if (localHead) return localHead
  }
  throw new Error('could not determine the default branch of the origin remote')
}

function advertisedOriginDefaultBranch(repoRoot: string): string | undefined {
  const advertisement =
    tryGitSync(['-C', repoRoot, 'ls-remote', '--symref', 'origin', 'HEAD']) ?? ''
  const advertisedHead = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(advertisement)
  const advertisedOid = /^[0-9a-f]{40}(?:[0-9a-f]{24})?\tHEAD$/m.test(advertisement)
  return advertisedHead && advertisedOid ? advertisedHead[1] : undefined
}

function verifyOriginDefaultBranch(repoRoot: string, candidate: string): string {
  const advertised = advertisedOriginDefaultBranch(repoRoot)
  if (advertised !== undefined && advertised !== candidate) {
    throw new Error(
      `the origin default branch ${advertised} conflicts with local evidence ${candidate}`
    )
  }
  return candidate
}

function managedHook(executablePath: string, gatePath: string): string {
  return `#!/bin/sh
set -eu
# managed by orca-no-mistakes; do not edit
exec ${shellQuote(path.resolve(executablePath))} gate admit --gate ${shellQuote(path.resolve(gatePath))}
`
}

async function writeAtomic(filePath: string, contents: string, mode: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporaryPath, contents, { encoding: 'utf8', mode })
  const file = await open(temporaryPath, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporaryPath, filePath)
  await chmod(filePath, mode)
  const directory = await open(path.dirname(filePath), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function gitSync(args: readonly string[]): string {
  try {
    return String(
      execFileSync('git', [...args], {
        encoding: 'utf8',
        env: cleanGitEnvironment(),
        stdio: ['ignore', 'pipe', 'ignore']
      })
    ).trim()
  } catch {
    throw new Error(`git command failed: ${args[0] ?? 'git'}`)
  }
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const key of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PREFIX',
    'GIT_PUSH_OPTION_COUNT',
    'GIT_PUSH_OPTION_0',
    'GIT_PUSH_OPTION_1',
    'GIT_QUARANTINE_PATH',
    'GIT_WORK_TREE'
  ]) {
    delete environment[key]
  }
  for (const key of Object.keys(environment)) {
    if (/^GIT_(?:CONFIG_KEY|CONFIG_VALUE|PUSH_OPTION)_\d+$/u.test(key)) delete environment[key]
  }
  return environment
}

function tryGitSync(args: readonly string[]): string | undefined {
  try {
    return gitSync(args) || undefined
  } catch {
    return undefined
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
