import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { initializeLocalGate } from '../scripts/admission.ts'
import { PIPELINE_STEPS, type StageName } from '../scripts/config.ts'
import { DomainLedger } from '../scripts/ledger.ts'
import {
  runPipeline,
  type FixerChangesVerdict,
  type GitOperations,
  type OrcaOperations,
  type PresentationSnapshot,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult
} from '../scripts/orca-no-mistakes.ts'
import { RailTuiRenderer } from '../scripts/tui.ts'

const gitCli = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

class FakeInput extends EventEmitter {
  isRaw = false
  isTTY = true
  paused = true

  isPaused(): boolean {
    return this.paused
  }

  pause(): this {
    this.paused = true
    return this
  }

  resume(): this {
    this.paused = false
    return this
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode
    return this
  }
}

class FakeOutput extends EventEmitter {
  columns = 120
  isTTY = true
  rows = 24
  readonly writes: string[] = []

  write(chunk: string): boolean {
    this.writes.push(chunk)
    return true
  }
}

function cleanScreen(screen: string): string {
  return screen
    .replaceAll(new RegExp('\\x1b\\[[0-?]*[ -/]*[@-~]', 'gu'), '')
    .replaceAll('\r', '')
    .replaceAll('\u0007', '')
}

function nextDraw(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

function snapshot(stage: StageName, sequence: number): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: stage,
    mode: { autoFix: true },
    runId: 'run-tui-test',
    sequence,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      id,
      round: 1,
      status: id === stage ? 'active' : 'pending',
      totalFindings: 0
    })),
    status: 'in-progress',
    transition: { kind: 'stage-started', stage },
    updatedAt: new Date(0).toISOString(),
    version: 1
  }
}

function pass(stage: string): StageReport {
  return {
    findings: [],
    summary: `${stage} passed`
  }
}

class FakeGit implements GitOperations {
  readonly calls: string[] = []
  static #oid(counter: number): string {
    return counter.toString(16).padStart(40, '0')
  }
  #counter = 1
  #head = FakeGit.#oid(1)
  #baseOid = FakeGit.#oid(0)
  failOnNextHead = false
  policyDigest?: string
  readonly #branch: string
  readonly #root: string

  constructor(root = '/repo', branch = 'feature') {
    this.#root = root
    this.#branch = branch
  }

  async assertReady(): Promise<{
    base: string
    baseOid: string
    branch: string
    head: string
    root: string
  }> {
    this.calls.push('assert-ready')
    return {
      base: 'main',
      baseOid: this.#baseOid,
      branch: this.#branch,
      head: this.#head,
      root: this.#root
    }
  }

  async assertClean(): Promise<void> {
    this.calls.push('assert-clean')
  }

  async assertFixerChangesAllowed(): Promise<FixerChangesVerdict> {
    return { changed: true, guardrailViolations: [] }
  }

  async head(): Promise<string> {
    if (this.failOnNextHead) {
      this.failOnNextHead = false
      throw new Error('transient git.head failure after review fix')
    }
    return this.#head
  }

  async diffBase(base: string): Promise<string> {
    this.calls.push(`diff:${base}`)
    return ''
  }

  async headOf(): Promise<string> {
    return FakeGit.#oid(++this.#counter)
  }

  async worktreeIsReusable(): Promise<boolean> {
    return false
  }

  async resolveRefSha(ref: string): Promise<string | undefined> {
    return `sha-${ref.replaceAll('/', '-')}`
  }

  async showFile(_ref: string, file: string): Promise<string | undefined> {
    if (file === '.orca/no-mistakes.yaml') {
      return 'auto_fix:\n  allow_review_autofix: true\n  guardrails: strict\n'
    }
    return undefined
  }

  async pathExists(_ref: string, file: string): Promise<boolean> {
    return file === '.orca/no-mistakes.yaml'
  }

  async rebase(base: string): Promise<StageReport> {
    this.calls.push(`rebase:${base}`)
    return {
      findings: [],
      rebaseUpstreamHead: this.#baseOid,
      summary: 'rebased'
    }
  }

  async policySha256(): Promise<string> {
    return this.policyDigest ?? 'f'.repeat(64)
  }

  async resolveBaseOid(): Promise<string> {
    return this.#baseOid
  }

  async applyWorktreeCommits(
    _sourcePath: string,
    _expectedHead: string,
    expectedSourceHead: string
  ): Promise<boolean> {
    this.#head = expectedSourceHead
    return true
  }

  async anchorRecoveryRef(): Promise<void> {}
}

class FakeOrca implements OrcaOperations {
  readonly calls: string[] = []
  readonly tasks: {
    deps: string[]
    id: string
    parent?: string
    spec: string
  }[] = []
  readonly reports = new Map<string, StageReport[]>()
  gateResolution = 'approve'
  #taskNumber = 0
  #dispatchNumber = 0
  readonly #runId: string

  constructor(runId = 'test-run') {
    this.#runId = runId
  }

  async createRun(objective: string): Promise<string> {
    this.calls.push(`run:${objective}`)
    return this.#runId
  }

  async createTask(
    spec: string,
    options: { deps?: string[]; parent?: string } = {}
  ): Promise<string> {
    const id = `task-${++this.#taskNumber}`
    this.tasks.push({
      deps: options.deps ?? [],
      id,
      parent: options.parent,
      spec
    })
    return id
  }

  onStartWorker?: (launch: WorkerLaunch) => void

  async startWorker(
    taskId: string,
    launch: WorkerLaunch
  ): Promise<WorkerResult> {
    this.onStartWorker?.(launch)
    const dispatchId = `dispatch-${++this.#dispatchNumber}`
    const stage = launch.stage
    const reports = this.reports.get(stage) ?? [pass(stage)]
    const report = reports.shift() ?? pass(stage)
    this.reports.set(stage, reports)
    return {
      deliveryId: `delivery-${dispatchId}`,
      dispatchId,
      report,
      taskId,
      terminalHandle: `term-${dispatchId}`,
      worktreeId:
        launch.worktree === 'new-child' ? `repo::/${dispatchId}` : undefined,
      worktreePath:
        launch.worktree === 'new-child'
          ? `/worktrees/${dispatchId}`
          : undefined
    }
  }

  async setWorktreeStatus(_comment: string, _status?: string): Promise<void> {}

  async finishWorker(
    worker: WorkerResult,
    disposition: 'release' | 'retain'
  ): Promise<void> {
    this.calls.push(`${disposition}:${worker.dispatchId}`)
    if (disposition === 'release') worker.shutdownConfirmed = true
  }

  async removeWorktree(): Promise<void> {}

  async completeTask(taskId: string, report: StageReport): Promise<void> {
    this.calls.push(`complete:${taskId}:${report.summary}`)
  }

  async createGate(_taskId?: string, _question?: string, options?: readonly string[]): Promise<string> {
    return options?.includes('resume') ? 'gate-resume' : 'gate-1'
  }

  async waitForGate(): Promise<string> {
    return this.gateResolution
  }
}

test('TUI records decision on gate-resolved fix without fabricating Review fix 1', async () => {
  const input = new FakeInput()
  const output = new FakeOutput()
  const renderer = new RailTuiRenderer(input, output, '/unused')

  const base = snapshot('review', 1)
  renderer.render({
    ...base,
    transition: { kind: 'round-started', role: 'reviewer', round: 0, stage: 'review' }
  })
  renderer.render({
    ...base,
    transition: {
      actionable: 1,
      kind: 'findings-recorded',
      round: 0,
      stage: 'review',
      total: 1
    }
  })
  renderer.render({
    ...base,
    transition: {
      gateId: 'g1',
      kind: 'gate-opened',
      options: ['approve', 'fix'],
      question: 'Review decision needed',
      round: 0,
      stage: 'review'
    }
  })
  await nextDraw()
  let screen = cleanScreen(output.writes.at(-1) ?? '')
  assert.match(screen, /Review decision needed/u)

  // Gate resolved with decision "fix"
  renderer.render({
    ...base,
    transition: {
      decision: 'fix',
      gateId: 'g1',
      kind: 'gate-resolved',
      round: 0,
      stage: 'review'
    }
  })
  await nextDraw()
  screen = cleanScreen(output.writes.at(-1) ?? '')
  assert.match(screen, /Review fix/u)
  assert.doesNotMatch(screen, /Review fix 1/u)

  // Next round starts as re-analysis (reviewer) without fixer start
  renderer.render({
    ...base,
    transition: {
      kind: 'round-started',
      role: 'reviewer',
      round: 1,
      stage: 'review'
    }
  })
  await nextDraw()
  screen = cleanScreen(output.writes.at(-1) ?? '')
  assert.match(screen, /Review fix/u)
  assert.match(screen, /Review analysis 2/u)
  assert.doesNotMatch(screen, /Review fix 1/u)
  renderer.close()
})

test('initializeLocalGate preserves durable hook executable when initialized from linked worktree', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-hook-preserve-'))
  const origin = path.join(temp, 'origin.git')
  const repo = path.join(temp, 'repo')
  const linked = path.join(temp, 'linked')
  try {
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
    gitCli(repo, 'config', 'user.email', 'test@example.com')
    gitCli(repo, 'config', 'user.name', 'Test User')
    await writeFile(path.join(repo, 'file.txt'), 'content\n')
    gitCli(repo, 'add', 'file.txt')
    gitCli(repo, 'commit', '-m', 'initial')
    gitCli(repo, 'remote', 'add', 'origin', origin)
    gitCli(repo, 'push', '-q', 'origin', 'main')

    const durableExec = path.join(repo, 'bin', 'orca-no-mistakes')
    await mkdir(path.dirname(durableExec), { recursive: true })
    await writeFile(durableExec, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    const initial = await initializeLocalGate(await realpath(repo), durableExec)
    const hookPath = path.join(initial.gatePath, 'hooks', 'pre-receive')
    const initialHook = await readFile(hookPath, 'utf8')
    assert.ok(initialHook.includes(durableExec), 'hook references durable repo executable')

    gitCli(repo, 'worktree', 'add', '-b', 'linked-branch', linked, 'main')
    const linkedExec = path.join(linked, 'bin', 'orca-no-mistakes')
    await mkdir(path.dirname(linkedExec), { recursive: true })
    await writeFile(linkedExec, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    // Re-initialize from linked worktree: hook must preserve durableExec
    await initializeLocalGate(await realpath(linked), linkedExec, { allowLinkedWorktree: true })
    const preservedHook = await readFile(hookPath, 'utf8')
    assert.ok(
      preservedHook.includes(durableExec),
      'hook should preserve durable executable'
    )
    assert.ok(
      !preservedHook.includes(linkedExec),
      'hook should not be overwritten with linked worktree executable'
    )

    // Delete linked worktree and verify hook executable still exists
    gitCli(repo, 'worktree', 'remove', '--force', linked)
    await rm(linked, { force: true, recursive: true })
    assert.equal(existsSync(linkedExec), false)
    assert.equal(existsSync(durableExec), true)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('resume reconciles findings from authoritative evidence when restored.findings was already defined', async () => {
  const git = new FakeGit()
  git.policyDigest = 'f'.repeat(64)
  const runId = 'resume-stale-findings-test'
  const ledger = new DomainLedger(':memory:')

  let reviewDispatches = 0
  const interrupted = new FakeOrca(runId)
  interrupted.onStartWorker = (launch) => {
    if (launch.stage === 'review' && launch.role === 'reviewer') {
      reviewDispatches += 1
      if (reviewDispatches === 2) {
        git.failOnNextHead = true
      }
    }
  }
  interrupted.reports.set('review', [
    {
      findings: [
        {
          action: 'auto-fix',
          description: 'Initial review finding requiring fix.',
          id: 'finding-1',
          severity: 'error'
        }
      ],
      summary: 'review round 0 found issue'
    },
    {
      findings: [],
      summary: 'review round 1 revalidation clean'
    }
  ])

  try {
    await assert.rejects(
      runPipeline(
        { intent: 'Verify resume reconciles stale findings' },
        interrupted,
        git,
        ledger
      ),
      /transient git.head failure after review fix/
    )

    const evidence = ledger.listEvidence(runId)
    const reviewR1Evidence = evidence.find(
      (e) => e.stage_id === 'review' && e.round_index === 1
    )
    assert.ok(reviewR1Evidence, 'review round 1 evidence recorded in ledger')
    assert.equal(reviewR1Evidence.findings_json, '[]')

    // Resuming pipeline
    const resumed = new FakeOrca(runId)
    resumed.reports.set('test', [pass('test')])
    resumed.reports.set('document', [pass('document')])
    resumed.reports.set('push', [pass('push')])

    const snapshots: PresentationSnapshot[] = []
    const result = await runPipeline(
      {
        intent: 'Verify resume reconciles stale findings',
        rendererFactory: () => ({
          close() {},
          render(s) {
            snapshots.push(s)
          }
        }),
        resumeRunId: runId
      },
      resumed,
      git,
      ledger
    )

    assert.equal(result.verdict, 'passed')

    // Find latest review stage in snapshots after resume reconciliation
    const finalSnapshot = snapshots.at(-1)
    const reviewStage = finalSnapshot?.stages.find((s) => s.id === 'review')
    assert.ok(reviewStage, 'review stage present in snapshot')
    assert.equal(reviewStage.actionableFindings, 0, 'actionable findings must be reconciled to 0')
    assert.equal(reviewStage.openFindings, 0, 'open findings must be reconciled to 0')
    const finding1 = reviewStage.findings?.find((f) => f.id === 'finding-1')
    assert.ok(finding1, 'prior finding present')
    assert.equal(finding1.disposition, 'fixed', 'prior open finding must be reconciled to fixed')
  } finally {
    ledger.close()
  }
})
