#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PIPELINE_STEPS = [
  'intent',
  'rebase',
  'review',
  'test',
  'document',
  'lint',
  'push',
  'pr',
  'ci'
] as const

export type StageName = (typeof PIPELINE_STEPS)[number]
export type FindingAction = 'ask-user' | 'auto-fix' | 'no-op'

export type Finding = {
  action: FindingAction
  description: string
  file?: string
  id: string
  line?: number
  severity: 'error' | 'info' | 'warning'
}

export type StageReport = {
  artifacts?: string[]
  findings: Finding[]
  summary: string
  tested?: string[]
}

export type WorkerLaunch = {
  name: string
  prompt: string
  role: 'fixer' | 'reviewer'
  stage: StageName
  terminal?: string
  worktree: 'current' | 'new-child'
}

export type WorkerResult = {
  deliveryId?: string
  dispatchId: string
  report: StageReport
  taskId: string
  terminalHandle?: string
  worktreeId?: string
}

export interface OrcaOperations {
  createRun(objective: string): Promise<string>
  createTask(spec: string, options?: { deps?: string[]; parent?: string }): Promise<string>
  startWorker(taskId: string, launch: WorkerLaunch): Promise<WorkerResult>
  finishWorker(worker: WorkerResult, disposition: 'release' | 'retain'): Promise<void>
  removeWorktree(worktreeId: string): Promise<void>
  completeTask(taskId: string, report: StageReport): Promise<void>
  createGate(taskId: string, question: string, options?: string[]): Promise<string>
  waitForGate(gateId: string): Promise<string>
  setWorktreeStatus(comment: string, status?: string): Promise<void>
}

export interface GitOperations {
  assertReady(): Promise<{ base: string; branch: string; head: string; root: string }>
  assertClean(): Promise<void>
  head(): Promise<string>
  rebase(base: string): Promise<StageReport>
  push(branch: string): Promise<StageReport>
}

export type PipelineOptions = {
  intent: string
  maxFixRounds?: number
}

export type PipelineResult = {
  runId: string
  steps: readonly StageName[]
}

type RepoState = Awaited<ReturnType<GitOperations['assertReady']>>

export async function runPipeline(
  options: PipelineOptions,
  orca: OrcaOperations,
  git: GitOperations
): Promise<PipelineResult> {
  const intent = options.intent.trim()
  if (!intent) {
    throw new Error('--intent is required')
  }
  const maxFixRounds = options.maxFixRounds ?? 3
  if (!Number.isInteger(maxFixRounds) || maxFixRounds < 0) {
    throw new Error('maxFixRounds must be a non-negative integer')
  }

  const repo = await git.assertReady()
  const runId = await orca.createRun(`no-mistakes: ${intent}`)
  const evidenceBase = path.join(homedir(), '.orca-no-mistakes', 'evidence')
  const evidenceDir = path.resolve(evidenceBase, runId)
  if (!runId.trim() || !isWithin(evidenceBase, evidenceDir)) {
    throw new Error('Orca returned an unsafe Run ID')
  }
  await mkdir(evidenceBase, { recursive: true })
  await mkdir(evidenceDir, { recursive: true })
  const [canonicalEvidenceBase, canonicalEvidenceDir] = await Promise.all([
    realpath(evidenceBase),
    realpath(evidenceDir)
  ])
  if (!isWithin(canonicalEvidenceBase, canonicalEvidenceDir)) {
    throw new Error('Orca returned an unsafe Run ID')
  }
  const stageTasks = new Map<StageName, string>()
  let previousTask: string | undefined
  let retainedFixer: WorkerResult | undefined

  for (const stage of PIPELINE_STEPS) {
    const task = await orca.createTask(stageTaskSpec(stage, intent), {
      deps: previousTask ? [previousTask] : []
    })
    stageTasks.set(stage, task)
    previousTask = task
  }

  await orca.setWorktreeStatus('no-mistakes started: intent', 'in-progress')

  try {
    for (const stage of PIPELINE_STEPS) {
      const taskId = stageTasks.get(stage)!
      await orca.setWorktreeStatus(
        `no-mistakes ${stage} (${stageIndex(stage)}/${PIPELINE_STEPS.length})`,
        'in-progress'
      )
      let round = 0
      let attempt = 0
      const runStage = async () =>
        await executeStage(stage, attempt++, taskId, intent, evidenceDir, repo, orca, git)
      let report = await runStage()

      while (actionableFindings(report).length > 0) {
        const actionable = actionableFindings(report)
        const asksUser = actionable.some((finding) => finding.action === 'ask-user')
        let shouldFix = !asksUser
        let guidance = ''

        if (asksUser) {
          const deliveryStage = stage === 'push' || stage === 'pr' || stage === 'ci'
          const gateOptions = deliveryStage ? ['retry', 'stop'] : ['approve', 'fix', 'skip', 'stop']
          const gateId = await orca.createGate(
            taskId,
            gateQuestion(stage, report, gateOptions),
            gateOptions
          )
          const resolution = (await orca.waitForGate(gateId)).trim()
          const decision = gateDecision(resolution)
          if (!deliveryStage && (decision === 'approve' || decision === 'skip')) {
            break
          }
          if (deliveryStage && decision === 'retry') {
            report = await runStage()
            continue
          } else if (!deliveryStage && decision === 'fix') {
            shouldFix = true
            guidance = resolution.slice(3).replace(/^\s*:\s*/, '')
          } else {
            throw new Error(`${stage} gate stopped the pipeline: ${resolution}`)
          }
        }

        if (!shouldFix) {
          break
        }
        if (round >= maxFixRounds) {
          throw new Error(`${stage} still has findings after ${round} fix rounds: ${report.summary}`)
        }

        round += 1
        const nextFixer = await runFixer(
          stage,
          round,
          taskId,
          intent,
          report,
          guidance,
          path.join(evidenceDir, `fixer-${stage}-${round}.json`),
          retainedFixer,
          orca,
          git
        )
        if (retainedFixer) {
          await orca.finishWorker(retainedFixer, 'release')
        }
        retainedFixer = nextFixer
        if (stage === 'pr' || stage === 'ci') {
          await repushAfterDeliveryFix(stage, taskId, repo.branch, orca, git)
        }
        report = await runStage()
      }

      await orca.completeTask(taskId, report)
    }

    if (retainedFixer) {
      await orca.finishWorker(retainedFixer, 'release')
      retainedFixer = undefined
    }
    await orca.setWorktreeStatus(`no-mistakes passed all ${PIPELINE_STEPS.length} stages`, 'completed')
    return { runId, steps: PIPELINE_STEPS }
  } catch (error) {
    if (retainedFixer) {
      await orca.finishWorker(retainedFixer, 'release').catch(() => {})
    }
    const message = error instanceof Error ? error.message : String(error)
    await orca.setWorktreeStatus(`no-mistakes stopped: ${message}`, 'in-review').catch(() => {})
    throw error
  }
}

async function executeStage(
  stage: StageName,
  attempt: number,
  taskId: string,
  intent: string,
  evidenceDir: string,
  repo: RepoState,
  orca: OrcaOperations,
  git: GitOperations
): Promise<StageReport> {
  if (stage === 'intent') {
    return { findings: [], summary: `Intent recorded: ${intent}` }
  }
  if (stage === 'rebase') {
    return await git.rebase(repo.base)
  }
  if (stage === 'push') {
    return await git.push(repo.branch)
  }
  return await runReviewer(stage, attempt, taskId, intent, evidenceDir, repo, orca)
}

async function runReviewer(
  stage: StageName,
  attempt: number,
  parentTask: string,
  intent: string,
  evidenceDir: string,
  repo: RepoState,
  orca: OrcaOperations
): Promise<StageReport> {
  const prompt = checkerPrompt(
    stage,
    intent,
    repo,
    path.join(evidenceDir, `${stage}-${attempt + 1}.json`)
  )
  const childTask = await orca.createTask(`[${stage} check ${attempt + 1}]\n${prompt}`, {
    parent: parentTask
  })
  const worker = await orca.startWorker(childTask, {
    name: `no-mistakes-${stage}-${attempt + 1}`,
    prompt,
    role: 'reviewer',
    stage,
    worktree: 'new-child'
  })
  try {
    return await validateReport(worker.report, stage, evidenceDir)
  } finally {
    await orca.finishWorker(worker, 'release')
    if (worker.worktreeId) {
      await orca.removeWorktree(worker.worktreeId)
    }
  }
}

async function runFixer(
  stage: StageName,
  round: number,
  parentTask: string,
  intent: string,
  report: StageReport,
  guidance: string,
  reportPath: string,
  retainedFixer: WorkerResult | undefined,
  orca: OrcaOperations,
  git: GitOperations
): Promise<WorkerResult> {
  await git.assertClean()
  const before = await git.head()
  const prompt = fixerPrompt(stage, intent, report, guidance, reportPath)
  const childTask = await orca.createTask(`[${stage} fix ${round}]\n${prompt}`, {
    parent: parentTask
  })
  const worker = await orca.startWorker(childTask, {
    name: `no-mistakes-fixer-${stage}-${round}`,
    prompt,
    role: 'fixer',
    stage,
    terminal: retainedFixer?.terminalHandle,
    worktree: 'current'
  })
  try {
    await validateReport(worker.report, stage, path.dirname(reportPath))
    await git.assertClean()
    const after = await git.head()
    if (before === after) {
      throw new Error(`${stage} fixer did not commit a change`)
    }
    await orca.finishWorker(worker, 'retain')
    return worker
  } catch (error) {
    await orca.finishWorker(worker, 'release').catch(() => {})
    throw error
  }
}

async function repushAfterDeliveryFix(
  stage: 'ci' | 'pr',
  taskId: string,
  branch: string,
  orca: OrcaOperations,
  git: GitOperations
): Promise<void> {
  for (;;) {
    const report = await git.push(branch)
    if (actionableFindings(report).length === 0) return
    const gateOptions = ['retry', 'stop']
    const gateId = await orca.createGate(
      taskId,
      `${stage} produced a new commit, but repush failed. ${gateQuestion('push', report, gateOptions)}`,
      gateOptions
    )
    const resolution = (await orca.waitForGate(gateId)).trim()
    if (gateDecision(resolution) !== 'retry') {
      throw new Error(`${stage} repush stopped the pipeline: ${resolution}`)
    }
  }
}

function actionableFindings(report: StageReport): Finding[] {
  return report.findings.filter((finding) => finding.action !== 'no-op')
}

async function validateReport(
  report: StageReport,
  stage: StageName,
  evidenceRoot: string
): Promise<StageReport> {
  if (
    !report ||
    !Array.isArray(report.findings) ||
    typeof report.summary !== 'string' ||
    !report.summary.trim() ||
    !optionalStringArray(report.artifacts) ||
    !optionalStringArray(report.tested)
  ) {
    throw new Error(`${stage} worker returned an invalid report`)
  }
  for (const finding of report.findings) {
    if (
      !finding ||
      typeof finding.id !== 'string' ||
      !finding.id.trim() ||
      typeof finding.description !== 'string' ||
      !finding.description.trim() ||
      !['ask-user', 'auto-fix', 'no-op'].includes(finding.action) ||
      !['error', 'info', 'warning'].includes(finding.severity) ||
      (finding.file !== undefined && (typeof finding.file !== 'string' || !finding.file.trim())) ||
      (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1))
    ) {
      throw new Error(`${stage} worker returned an invalid finding`)
    }
  }
  const artifacts = report.artifacts ?? []
  const canonicalEvidenceRoot = artifacts.length > 0 ? await realpath(evidenceRoot) : evidenceRoot
  for (const artifact of artifacts) {
    const resolved = path.resolve(evidenceRoot, artifact)
    if (!isWithin(evidenceRoot, resolved)) {
      throw new Error(`${stage} worker returned an unsafe artifact path`)
    }
    let canonicalArtifact: string
    try {
      await stat(resolved)
      canonicalArtifact = await realpath(resolved)
    } catch {
      throw new Error(`${stage} worker returned a missing artifact`)
    }
    if (!isWithin(canonicalEvidenceRoot, canonicalArtifact)) {
      throw new Error(`${stage} worker returned an unsafe artifact path`)
    }
  }
  return report
}

function optionalStringArray(value: string[] | undefined): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
}

function stageIndex(stage: StageName): number {
  return PIPELINE_STEPS.indexOf(stage) + 1
}

function stageTaskSpec(stage: StageName, intent: string): string {
  return `[${stage}] no-mistakes stage ${stageIndex(stage)}/${PIPELINE_STEPS.length}. Intent: ${intent}`
}

function checkerBrief(stage: StageName): string {
  const briefs: Record<Exclude<StageName, 'intent' | 'push' | 'rebase'>, string> = {
    review: 'Adversarially review the committed change.',
    test: 'Run the smallest relevant behavioral checks.',
    document: 'Check whether the change made owned documentation stale.',
    lint: 'Run the repository lint and formatting checks.',
    pr: 'Create or update the pull request without merging it.',
    ci: 'Wait for the pull request checks and report their terminal state.'
  }
  return briefs[stage as keyof typeof briefs]
}

function checkerPrompt(
  stage: StageName,
  intent: string,
  repo: RepoState,
  reportPath: string
): string {
  return `You are the independent read-only ${stage} worker in an active no-mistakes run.

Repository: ${repo.root}
Branch: ${repo.branch}
Base: ${repo.base}
User intent: ${intent}
Assignment: ${checkerBrief(stage)}

Do not edit or commit files. Do not invoke no-mistakes or Orca pipeline controls. Inspect the actual diff and execute only focused checks needed for this phase. Evidence belongs outside the repository at ${reportPath}.

Write one JSON object to ${reportPath} with this shape:
{"findings":[{"id":"stable-id","severity":"error|warning|info","file":"optional/path","line":1,"description":"full finding","action":"auto-fix|ask-user|no-op"}],"summary":"concise result","tested":["optional command"],"artifacts":["optional path"]}

Create the parent directory if needed. Then report exactly once with worker_done: keep --body to the required three-sentence executive summary and pass --report-path ${reportPath}. Use auto-fix only for a concrete mechanical repair. Use ask-user for product choices, intent conflicts, destructive actions, credentials, or uncertain delivery state. An empty findings array means this phase passed.`
}

function fixerPrompt(
  stage: StageName,
  intent: string,
  report: StageReport,
  guidance: string,
  reportPath: string
): string {
  return `You are the durable fixer for the ${stage} phase of an active no-mistakes run.

User intent: ${intent}
Findings: ${JSON.stringify(actionableFindings(report))}
${guidance ? `User guidance: ${guidance}\n` : ''}
Fix all listed findings without changing unrelated behavior. Run one focused verification after all edits. Commit only your fixes on the current feature branch. Do not push, create a PR, run the whole repository suite, or invoke no-mistakes/Orca pipeline controls.

Write {"findings":[],"summary":"what was fixed and committed","tested":["focused command"]} to ${reportPath}, creating its parent directory if needed. Then report exactly once with worker_done: keep --body to the required three-sentence executive summary and pass --report-path ${reportPath}.`
}

function gateQuestion(stage: StageName, report: StageReport, options: string[]): string {
  const choices = options.map((option) => (option === 'fix' ? 'fix[: guidance]' : option)).join(', ')
  return `${stage} needs a human decision. Resolve with ${choices}. Findings: ${JSON.stringify(actionableFindings(report))}`
}

function gateDecision(resolution: string): string {
  return resolution.trim().toLowerCase().split(/[\s:]/, 1)[0]
}

type CommandResult = { code: number; stderr: string; stdout: string }

async function command(
  executable: string,
  args: string[],
  cwd: string,
  options: { allowFailure?: boolean; timeoutMs?: number | null } = {}
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timeoutMs = options.timeoutMs === undefined ? 120_000 : options.timeoutMs
    let timedOut = false
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
          }, timeoutMs)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (timedOut) {
        const message = `${executable} ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs}ms`
        if (options.allowFailure) {
          resolve({ code: 124, stdout, stderr: `${stderr}${stderr ? '\n' : ''}${message}` })
        } else {
          reject(new Error(message))
        }
        return
      }
      if (code === 0 || options.allowFailure) {
        resolve({ code: code ?? 1, stdout, stderr })
      } else {
        reject(new Error(`${executable} ${args.join(' ')} failed (${code}): ${stderr || stdout}`))
      }
    })
  })
}

function unwrapJson<T>(stdout: string): T {
  const parsed = JSON.parse(stdout) as { result?: T } | T
  return typeof parsed === 'object' && parsed !== null && 'result' in parsed
    ? (parsed as { result: T }).result
    : (parsed as T)
}

const DEFAULT_WORKER_AGENT = 'opencode'
const DEFAULT_WORKER_MODEL = 'opencode-go/ox-alpha-free'
const DEFAULT_WORKER_EFFORT = 'max'

type CliOrcaOptions = {
  command?: string
  cwd: string
  fixerEffort?: string
  fixerModel?: string
  reviewerModel?: string
}

export class CliOrca implements OrcaOperations {
  readonly #command: string
  readonly #cwd: string
  readonly #fixerEffort: string
  readonly #fixerModel: string
  readonly #reviewerModel: string
  #runId?: string

  constructor(options: CliOrcaOptions) {
    this.#command =
      options.command ?? process.env.ORCA_CLI_COMMAND ?? (process.platform === 'linux' ? 'orca-ide' : 'orca')
    this.#cwd = options.cwd
    this.#fixerEffort = options.fixerEffort ?? DEFAULT_WORKER_EFFORT
    this.#fixerModel = options.fixerModel ?? DEFAULT_WORKER_MODEL
    this.#reviewerModel = options.reviewerModel ?? DEFAULT_WORKER_MODEL
  }

  async createRun(objective: string): Promise<string> {
    const result = await this.#json<{ run: { id: string } }>([
      'orchestration',
      'run-create',
      '--objective',
      objective,
      '--json'
    ])
    this.#runId = result.run.id
    return result.run.id
  }

  async createTask(spec: string, options: { deps?: string[]; parent?: string } = {}): Promise<string> {
    const args = ['orchestration', 'task-create', '--spec', spec]
    if (options.deps?.length) args.push('--deps', JSON.stringify(options.deps))
    if (options.parent) args.push('--parent', options.parent)
    if (this.#runId) args.push('--run', this.#runId)
    args.push('--json')
    const result = await this.#json<{ task: { id: string } }>(args)
    return result.task.id
  }

  async startWorker(taskId: string, launch: WorkerLaunch): Promise<WorkerResult> {
    const args = ['orchestration', 'worker-start', '--task', taskId]
    if (this.#runId) args.push('--run', this.#runId)
    if (launch.terminal) {
      args.push('--terminal', launch.terminal)
    } else {
      args.push('--worktree', launch.worktree, '--agent', DEFAULT_WORKER_AGENT)
      if (launch.worktree === 'new-child') args.push('--name', launch.name, '--setup', 'run')
      args.push('--model', launch.role === 'reviewer' ? this.#reviewerModel : this.#fixerModel)
      args.push('--effort', launch.role === 'reviewer' ? DEFAULT_WORKER_EFFORT : this.#fixerEffort)
    }
    args.push('--json')
    const receipt = await this.#json<{
      dispatchId: string
      effects?: { action?: string; id?: string; kind?: string }[]
      state: string
    }>(args, true)
    if (!receipt || typeof receipt.dispatchId !== 'string' || typeof receipt.state !== 'string') {
      throw new Error('worker-start returned an invalid receipt')
    }
    const worktreeId = receipt.effects?.find(
      (effect) => effect.kind === 'worktree' && effect.action === 'created'
    )?.id
    if (receipt.state !== 'ready') {
      await this.#cleanupFailedWorker(receipt.dispatchId, worktreeId)
      throw new Error(`worker ${receipt.dispatchId} did not start: ${receipt.state}`)
    }
    let deliveryId: string | undefined
    try {
      const result = await this.#waitForWorker(taskId, receipt.dispatchId)
      deliveryId = result.deliveryId
      if (result.error) throw new Error(result.error)
      const shown = await this.#json<{
        worker: { agent_terminal_handle: string | null }
      }>(['orchestration', 'worker-show', '--dispatch', receipt.dispatchId, '--json'])
      return {
        deliveryId,
        report: result.report!,
        taskId,
        dispatchId: receipt.dispatchId,
        terminalHandle: shown.worker.agent_terminal_handle ?? undefined,
        worktreeId
      }
    } catch (error) {
      await this.#cleanupFailedWorker(receipt.dispatchId, worktreeId, deliveryId)
      throw error
    }
  }

  async finishWorker(worker: WorkerResult, disposition: 'release' | 'retain'): Promise<void> {
    await this.#json([
      'orchestration',
      disposition === 'release' ? 'worker-release' : 'worker-retain',
      '--dispatch',
      worker.dispatchId,
      '--json'
    ])
    if (worker.deliveryId) {
      await this.#json([
        'orchestration',
        'check',
        '--ack',
        worker.deliveryId,
        ...(this.#runId ? ['--run', this.#runId] : []),
        '--json'
      ])
      worker.deliveryId = undefined
    }
  }

  async removeWorktree(worktreeId: string): Promise<void> {
    await this.#json(['worktree', 'rm', '--worktree', `id:${worktreeId}`, '--force', '--json'])
  }

  async completeTask(taskId: string, report: StageReport): Promise<void> {
    await this.#json([
      'orchestration',
      'task-update',
      '--id',
      taskId,
      '--status',
      'completed',
      '--result',
      JSON.stringify(report),
      ...(this.#runId ? ['--run', this.#runId] : []),
      '--json'
    ])
  }

  async createGate(
    taskId: string,
    question: string,
    options = ['approve', 'fix', 'skip', 'stop']
  ): Promise<string> {
    const result = await this.#json<{ gate: { id: string } }>([
      'orchestration',
      'gate-create',
      '--task',
      taskId,
      '--question',
      question,
      '--options',
      JSON.stringify(options),
      '--json'
    ])
    return result.gate.id
  }

  async waitForGate(gateId: string): Promise<string> {
    for (;;) {
      const result = await this.#json<{
        gates: { id: string; resolution?: string; status: string }[]
      }>([
        'orchestration',
        'gate-list',
        ...(this.#runId ? ['--run', this.#runId] : []),
        '--json'
      ])
      const gate = result.gates.find((candidate) => candidate.id === gateId)
      if (gate?.status === 'resolved') return gate.resolution ?? ''
      if (gate?.status === 'timeout') throw new Error(`gate ${gateId} timed out`)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  async setWorktreeStatus(comment: string, status?: string): Promise<void> {
    const args = ['worktree', 'set', '--worktree', 'active', '--comment', comment]
    if (status) args.push('--workspace-status', status)
    args.push('--json')
    try {
      await this.#json(args)
    } catch (error) {
      console.error(`warning: could not update Orca worktree status: ${String(error)}`)
    }
  }

  async #waitForWorker(
    taskId: string,
    dispatchId: string
  ): Promise<{ deliveryId?: string; error?: string; report?: StageReport }> {
    for (;;) {
      const result = await this.#json<{
        cancelled?: boolean
        connectionLost?: boolean
        deliveryId?: string
        messages?: {
          body?: string
          payload?: Record<string, unknown> | string | null
          subject?: string
          type?: string
        }[]
        timedOut?: boolean
      }>([
        'orchestration',
        'check',
        '--wait',
        '--types',
        'worker_done,escalation,question',
        '--timeout-ms',
        '900000',
        ...(this.#runId ? ['--run', this.#runId] : []),
        '--json'
      ])
      if (result.timedOut) continue
      if (result.cancelled || result.connectionLost) {
        return {
          deliveryId: result.deliveryId,
          error: result.cancelled ? 'orchestration wait was cancelled' : 'orchestration connection was lost'
        }
      }
      if (!Array.isArray(result.messages) || result.messages.length === 0) {
        return { deliveryId: result.deliveryId, error: 'orchestration check returned no messages' }
      }
      for (const message of result.messages) {
        let payload: Record<string, unknown>
        try {
          payload =
            typeof message.payload === 'string'
              ? (JSON.parse(message.payload) as Record<string, unknown>)
              : (message.payload ?? {})
        } catch {
          return { deliveryId: result.deliveryId, error: `worker ${dispatchId} returned invalid metadata` }
        }
        if (payload.dispatchId !== dispatchId) {
          return {
            deliveryId: result.deliveryId,
            error: `unexpected orchestration message while waiting for ${dispatchId}`
          }
        }
        if (message.type !== 'worker_done') {
          return {
            deliveryId: result.deliveryId,
            error: `${message.type ?? 'worker'} from ${dispatchId}: ${message.body ?? message.subject ?? ''}`
          }
        }
        if (payload.taskId !== taskId) {
          return { deliveryId: result.deliveryId, error: `worker ${dispatchId} reported for the wrong task` }
        }
        if (payload.outcome !== 'succeeded') {
          return {
            deliveryId: result.deliveryId,
            error: `worker ${dispatchId} failed: ${message.body ?? message.subject ?? ''}`
          }
        }
        if (typeof payload.reportPath !== 'string') {
          return { deliveryId: result.deliveryId, error: `worker ${dispatchId} returned no report path` }
        }
        const requestedReportPath = path.resolve(payload.reportPath)
        const evidenceBase = path.join(homedir(), '.orca-no-mistakes', 'evidence')
        const evidenceRoot = this.#runId ? path.resolve(evidenceBase, this.#runId) : undefined
        if (
          !evidenceRoot ||
          !isWithin(evidenceBase, evidenceRoot) ||
          !isWithin(evidenceRoot, requestedReportPath)
        ) {
          return { deliveryId: result.deliveryId, error: `worker ${dispatchId} used an unsafe report path` }
        }
        try {
          const [canonicalBase, canonicalRoot, reportPath] = await Promise.all([
            realpath(evidenceBase),
            realpath(evidenceRoot),
            realpath(requestedReportPath)
          ])
          if (!isWithin(canonicalBase, canonicalRoot) || !isWithin(canonicalRoot, reportPath)) {
            return { deliveryId: result.deliveryId, error: `worker ${dispatchId} used an unsafe report path` }
          }
          const report = JSON.parse(await readFile(reportPath, 'utf8')) as StageReport
          return { deliveryId: result.deliveryId, report }
        } catch (error) {
          return {
            deliveryId: result.deliveryId,
            error: `worker ${dispatchId} report could not be read: ${String(error)}`
          }
        }
      }
    }
  }

  async #cleanupFailedWorker(
    dispatchId: string,
    worktreeId?: string,
    deliveryId?: string
  ): Promise<void> {
    await this.#json(
      ['orchestration', 'worker-release', '--dispatch', dispatchId, '--json'],
      true
    ).catch(() => {})
    if (worktreeId) {
      await this.#json(['worktree', 'rm', '--worktree', `id:${worktreeId}`, '--force', '--json'], true).catch(
        () => {}
      )
    }
    if (deliveryId) {
      await this.#json(
        [
          'orchestration',
          'check',
          '--ack',
          deliveryId,
          ...(this.#runId ? ['--run', this.#runId] : []),
          '--json'
        ],
        true
      ).catch(() => {})
    }
  }

  async #json<T = unknown>(args: string[], acceptFailure = false): Promise<T> {
    const result = await command(this.#command, args, this.#cwd, {
      allowFailure: acceptFailure,
      timeoutMs: args.includes('--wait') ? 910_000 : undefined
    })
    if (result.code !== 0 && !result.stdout.trim()) {
      throw new Error(result.stderr.trim() || `${this.#command} failed with exit ${result.code}`)
    }
    try {
      return unwrapJson<T>(result.stdout)
    } catch {
      const detail = result.stderr.trim() || result.stdout.trim() || 'empty output'
      throw new Error(`${this.#command} ${args.slice(0, 2).join(' ')} returned invalid JSON: ${detail}`)
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

type GitShellOptions = { base?: string; expectedHead?: string; repo: string }

export class GitShell implements GitOperations {
  readonly #requestedBase?: string
  readonly #expectedHead?: string
  readonly #repo: string
  #state?: RepoState

  constructor(options: GitShellOptions) {
    this.#repo = path.resolve(options.repo)
    this.#requestedBase = options.base
    this.#expectedHead = options.expectedHead
  }

  async assertReady(): Promise<RepoState> {
    const root = (await this.#git(['rev-parse', '--show-toplevel'])).stdout.trim()
    await this.assertClean()
    const branch = (await this.#git(['branch', '--show-current'])).stdout.trim()
    if (!branch) throw new Error('no-mistakes requires a named feature branch')
    const head = await this.head()
    if (this.#expectedHead && head !== this.#expectedHead) {
      throw new Error(`current HEAD ${head} does not match pushed HEAD ${this.#expectedHead}`)
    }
    const base = this.#requestedBase ?? (await this.#detectBase())
    if (branch === base) throw new Error(`no-mistakes refuses to run on the default branch ${base}`)
    await this.#git(['remote', 'get-url', 'origin'])
    this.#state = { base, branch, head, root }
    return this.#state
  }

  async assertClean(): Promise<void> {
    const status = (await this.#git(['status', '--porcelain'])).stdout.trim()
    if (status) throw new Error('no-mistakes requires a clean committed worktree')
  }

  async head(): Promise<string> {
    return (await this.#git(['rev-parse', 'HEAD'])).stdout.trim()
  }

  async rebase(base: string): Promise<StageReport> {
    const fetch = await this.#git(['fetch', 'origin', base], true)
    if (fetch.failed) {
      return failureReport('rebase-fetch', 'ask-user', fetch.output)
    }
    const rebase = await this.#git(['rebase', `origin/${base}`], true)
    if (!rebase.failed) return { findings: [], summary: `rebased onto origin/${base}` }
    await this.#git(['rebase', '--abort'], true)
    return failureReport('rebase-conflict', 'auto-fix', rebase.output)
  }

  async push(branch: string): Promise<StageReport> {
    const push = await this.#git(
      ['push', '--force-with-lease', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`],
      true
    )
    return push.failed
      ? failureReport('push-failed', 'ask-user', push.output)
      : { findings: [], summary: `pushed ${branch} with force-with-lease` }
  }

  async #detectBase(): Promise<string> {
    const symbolic = await this.#git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], true)
    if (!symbolic.failed) return symbolic.output.trim().replace(/^origin\//, '')
    for (const candidate of ['main', 'master']) {
      const exists = await this.#git(['show-ref', '--verify', `refs/remotes/origin/${candidate}`], true)
      if (!exists.failed) return candidate
    }
    throw new Error('could not detect the default branch; pass --base')
  }

  async #git(
    args: string[],
    allowFailure = false
  ): Promise<CommandResult & { failed: boolean; output: string }> {
    const result = await command('git', ['-C', this.#repo, ...args], this.#repo, { allowFailure })
    const output = `${result.stdout}${result.stderr}`.trim()
    return { ...result, failed: result.code !== 0, output }
  }
}

function failureReport(id: string, action: FindingAction, description: string): StageReport {
  return {
    findings: [{ id, action, severity: 'error', description }],
    summary: description.split('\n')[0] || id
  }
}

type InstallOptions = { force?: boolean; repo: string }

export async function pushToGate(options: { intent: string; repo: string }): Promise<void> {
  const intent = options.intent.trim()
  if (!intent) throw new Error('push requires --intent')
  if (intent.includes('\n') || intent.includes('\0')) {
    throw new Error('--intent must be a single line')
  }
  const repo = path.resolve(options.repo)
  await command(
    'git',
    ['-C', repo, 'push', '--push-option', `no-mistakes.intent=${intent}`, 'no-mistakes'],
    repo,
    { timeoutMs: null }
  )
}

export async function installGitGate(options: InstallOptions): Promise<string> {
  const repo = path.resolve(options.repo)
  const gitDirValue = (await command('git', ['-C', repo, 'rev-parse', '--git-dir'], repo)).stdout.trim()
  const gitDir = path.isAbsolute(gitDirValue) ? gitDirValue : path.resolve(repo, gitDirValue)
  const gateDir = path.join(gitDir, 'orca-no-mistakes-gate.git')
  try {
    await stat(gateDir)
  } catch {
    await command('git', ['init', '--bare', gateDir], repo)
  }
  const hooksDir = path.join(gateDir, 'hooks')
  await mkdir(hooksDir, { recursive: true })
  await command('git', [`--git-dir=${gateDir}`, 'config', 'core.hooksPath', hooksDir], repo)
  await command('git', [`--git-dir=${gateDir}`, 'config', 'receive.advertisePushOptions', 'true'], repo)

  const existing = await command('git', ['-C', repo, 'remote', 'get-url', 'no-mistakes'], repo, {
    allowFailure: true
  })
  const existingUrl = existing.stdout.trim()
  if (existingUrl && path.resolve(repo, existingUrl) !== gateDir && !options.force) {
    throw new Error('remote no-mistakes already exists; pass --force to replace it')
  }
  await command(
    'git',
    ['-C', repo, 'remote', existingUrl ? 'set-url' : 'add', 'no-mistakes', gateDir],
    repo
  )
  await command('git', ['-C', repo, 'config', '--unset-all', 'orca-no-mistakes.intent'], repo, {
    allowFailure: true
  })

  const scriptPath = fileURLToPath(import.meta.url)
  const readPushIntent = `intent=
option_index=0
option_count=\${GIT_PUSH_OPTION_COUNT:-0}
while [ "$option_index" -lt "$option_count" ]; do
  eval "option=\\$GIT_PUSH_OPTION_$option_index"
  case "$option" in
    no-mistakes.intent=*)
      [ -z "$intent" ] || { echo 'no-mistakes: multiple per-push intents were provided' >&2; exit 1; }
      intent=\${option#no-mistakes.intent=}
      ;;
  esac
  option_index=$((option_index + 1))
done
[ -n "$intent" ] || { echo 'no-mistakes: per-push intent is required; use orca-no-mistakes push --intent "..."' >&2; exit 1; }
`
  const preReceivePath = path.join(hooksDir, 'pre-receive')
  await writeFile(preReceivePath, `#!/bin/sh\nset -u\n${readPushIntent}`, 'utf8')
  await chmod(preReceivePath, 0o755)
  const postReceivePath = path.join(hooksDir, 'post-receive')
  const postReceive = `#!/bin/sh
set -u
${readPushIntent}
unset $(git rev-parse --local-env-vars)
while read -r oldrev newrev refname; do
  case "$newrev" in
    *[!0]*) ;;
    *) continue ;;
  esac
  case "$refname" in
    refs/heads/*)
      ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} run --repo ${shellQuote(repo)} --head "$newrev" --intent "$intent" || exit $?
      ;;
  esac
done
`
  await writeFile(postReceivePath, postReceive, 'utf8')
  await chmod(postReceivePath, 0o755)
  return gateDir
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

type CliFlags = Record<string, string | boolean>

const BOOLEAN_FLAGS = new Set(['force'])
const VALUE_FLAGS = new Set([
  'base',
  'fixer-effort',
  'fixer-model',
  'head',
  'intent',
  'max-fix-rounds',
  'repo',
  'reviewer-model'
])
const COMMAND_FLAGS: Record<string, Set<string>> = {
  install: new Set(['force', 'repo']),
  push: new Set(['intent', 'repo']),
  run: new Set([
    'base',
    'fixer-effort',
    'fixer-model',
    'head',
    'intent',
    'max-fix-rounds',
    'repo',
    'reviewer-model'
  ])
}

function parseCli(argv: string[]): { command: string; flags: CliFlags } {
  const [subcommand = 'run', ...rest] = argv
  const allowedFlags = COMMAND_FLAGS[subcommand]
  if (!allowedFlags) throw new Error(`unknown command: ${subcommand}`)
  const flags: CliFlags = {}
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const equals = arg.indexOf('=')
    const name = arg.slice(2, equals < 0 ? undefined : equals)
    const inlineValue = equals < 0 ? undefined : arg.slice(equals + 1)
    if (!allowedFlags.has(name)) throw new Error(`--${name} is not valid for ${subcommand}`)
    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== undefined) throw new Error(`--${name} does not take a value`)
      flags[name] = true
      continue
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`unknown flag: --${name}`)
    const value = inlineValue ?? rest[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
    flags[name] = value
    if (inlineValue === undefined) index += 1
  }
  return { command: subcommand, flags }
}

function stringFlag(flags: CliFlags, name: string): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

export async function main(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv.includes('--help')) {
    console.log(`Usage:
  orca-no-mistakes run --intent <text> [--repo <path>] [--base <branch>] [--head <sha>]
  orca-no-mistakes push --intent <text> [--repo <path>]
  orca-no-mistakes install [--repo <path>] [--force]

Run options:
  --reviewer-model <model>
  --fixer-model <model> --fixer-effort <level>
  --max-fix-rounds <count>`)
    return
  }
  const parsed = parseCli(argv)
  const repo = stringFlag(parsed.flags, 'repo') ?? process.cwd()
  if (parsed.command === 'install') {
    const gate = await installGitGate({
      repo,
      force: parsed.flags.force === true
    })
    console.log(`Installed git remote no-mistakes -> ${gate}`)
    console.log('Run: orca-no-mistakes push --intent "Describe this exact commit set"')
    return
  }
  if (parsed.command === 'push') {
    const intent = stringFlag(parsed.flags, 'intent')
    if (!intent) throw new Error('push requires --intent')
    await pushToGate({ repo, intent })
    console.log('Submitted to the local no-mistakes gate; check the Orca Run for the pipeline outcome')
    return
  }
  if (parsed.command !== 'run') throw new Error(`unknown command: ${parsed.command}`)
  const intent = stringFlag(parsed.flags, 'intent')
  if (!intent) throw new Error('run requires --intent')
  const git = new GitShell({
    repo,
    base: stringFlag(parsed.flags, 'base'),
    expectedHead: stringFlag(parsed.flags, 'head')
  })
  const root = (await command('git', ['-C', repo, 'rev-parse', '--show-toplevel'], repo)).stdout.trim()
  const orca = new CliOrca({
    cwd: root,
    reviewerModel: stringFlag(parsed.flags, 'reviewer-model'),
    fixerModel: stringFlag(parsed.flags, 'fixer-model'),
    fixerEffort: stringFlag(parsed.flags, 'fixer-effort')
  })
  const maxFixRoundsValue = parsed.flags['max-fix-rounds']
  if (maxFixRoundsValue === true) throw new Error('--max-fix-rounds requires a number')
  const maxFixRounds = maxFixRoundsValue === undefined ? undefined : Number(maxFixRoundsValue)
  const result = await runPipeline({ intent, maxFixRounds }, orca, git)
  console.log(JSON.stringify(result))
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
