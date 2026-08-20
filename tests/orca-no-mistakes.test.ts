import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CliOrca,
  GitShell,
  PIPELINE_STEPS,
  installGitGate,
  runPipeline,
  type Finding,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult
} from '../scripts/orca-no-mistakes.ts'

const pass = (summary = 'passed'): StageReport => ({ findings: [], summary })

class FakeGit implements GitOperations {
  readonly calls: string[] = []
  readonly pushReports: StageReport[] = []
  #head = 'head-1'

  async assertReady(): Promise<{ base: string; branch: string; head: string; root: string }> {
    this.calls.push('assert-ready')
    return { base: 'main', branch: 'feature', head: this.#head, root: '/repo' }
  }

  async assertClean(): Promise<void> {
    this.calls.push('assert-clean')
  }

  async head(): Promise<string> {
    return this.#head
  }

  async rebase(base: string): Promise<StageReport> {
    this.calls.push(`rebase:${base}`)
    this.#head = 'head-2'
    return pass('rebased')
  }

  async push(branch: string): Promise<StageReport> {
    this.calls.push(`push:${branch}`)
    return this.pushReports.shift() ?? pass('pushed')
  }

  advanceHead(): void {
    this.#head = `head-${Number(this.#head.split('-')[1]) + 1}`
  }
}

class FakeOrca implements OrcaOperations {
  readonly calls: string[] = []
  readonly tasks: { deps: string[]; id: string; parent?: string; spec: string }[] = []
  readonly launches: WorkerLaunch[] = []
  readonly completedStages: string[] = []
  readonly removedWorktrees: string[] = []
  readonly reports = new Map<string, StageReport[]>()
  gateResolution = 'approve'
  #taskNumber = 0
  #dispatchNumber = 0
  #git: FakeGit

  constructor(git: FakeGit) {
    this.#git = git
  }

  async createRun(objective: string): Promise<string> {
    this.calls.push(`run:${objective}`)
    return 'run-1'
  }

  async createTask(spec: string, options: { deps?: string[]; parent?: string } = {}): Promise<string> {
    const id = `task-${++this.#taskNumber}`
    this.tasks.push({ id, spec, deps: options.deps ?? [], parent: options.parent })
    return id
  }

  async startWorker(taskId: string, launch: WorkerLaunch): Promise<WorkerResult> {
    this.launches.push(launch)
    const dispatchId = `dispatch-${++this.#dispatchNumber}`
    const stage = launch.stage
    const reports = this.reports.get(stage) ?? [pass(stage)]
    const report = reports.shift() ?? pass(stage)
    this.reports.set(stage, reports)
    if (launch.role === 'fixer') {
      this.#git.advanceHead()
    }
    return {
      deliveryId: `delivery-${dispatchId}`,
      dispatchId,
      report,
      taskId,
      terminalHandle: launch.role === 'fixer' ? 'term-fixer' : `term-${dispatchId}`,
      worktreeId: launch.worktree === 'new-child' ? `repo::/${dispatchId}` : undefined
    }
  }

  async finishWorker(worker: WorkerResult, disposition: 'release' | 'retain'): Promise<void> {
    this.calls.push(`${disposition}:${worker.dispatchId}`)
  }

  async removeWorktree(worktreeId: string): Promise<void> {
    this.removedWorktrees.push(worktreeId)
  }

  async completeTask(taskId: string, report: StageReport): Promise<void> {
    const task = this.tasks.find((candidate) => candidate.id === taskId)
    assert.ok(task)
    const stage = PIPELINE_STEPS.find((candidate) => task.spec.startsWith(`[${candidate}]`))
    if (stage) {
      this.completedStages.push(stage)
    }
    this.calls.push(`complete:${taskId}:${report.summary}`)
  }

  async createGate(taskId: string, question: string): Promise<string> {
    this.calls.push(`gate:${taskId}:${question}`)
    return 'gate-1'
  }

  async waitForGate(gateId: string): Promise<string> {
    this.calls.push(`wait-gate:${gateId}`)
    return this.gateResolution
  }

  async setWorktreeStatus(comment: string, status?: string): Promise<void> {
    this.calls.push(`status:${status ?? ''}:${comment}`)
  }
}

test('runs the nine-stage adversarial pipeline with fixes, gates, and isolation', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  const autoFix: Finding = {
    id: 'review-1',
    severity: 'error',
    action: 'auto-fix',
    description: 'Null input crashes the command'
  }
  const askUser: Finding = {
    id: 'docs-1',
    severity: 'warning',
    action: 'ask-user',
    description: 'The public behavior needs a product decision'
  }
  orca.reports.set('review', [{ findings: [autoFix], summary: 'one defect' }, pass('clean rereview')])
  orca.reports.set('document', [{ findings: [askUser], summary: 'decision needed' }])
  orca.reports.set('lint', [
    {
      findings: [{ ...autoFix, id: 'lint-1', description: 'Formatting is stale' }],
      summary: 'formatting defect'
    },
    pass('lint clean')
  ])
  orca.reports.set('ci', [
    {
      findings: [{ ...autoFix, id: 'ci-1', description: 'The new behavior fails in CI' }],
      summary: 'CI defect'
    },
    pass('CI clean')
  ])

  const result = await runPipeline(
    { intent: 'Add the requested command without changing existing behavior.' },
    orca,
    git
  )

  assert.equal(result.runId, 'run-1')
  assert.deepEqual(result.steps, PIPELINE_STEPS)
  assert.deepEqual(orca.completedStages, PIPELINE_STEPS)

  const stageTasks = orca.tasks.slice(0, PIPELINE_STEPS.length)
  assert.equal(stageTasks.length, 9)
  assert.deepEqual(stageTasks[0].deps, [])
  for (let index = 1; index < stageTasks.length; index += 1) {
    assert.deepEqual(stageTasks[index].deps, [stageTasks[index - 1].id])
  }

  const reviewLaunches = orca.launches.filter(
    (launch) => launch.stage === 'review' && launch.role === 'reviewer'
  )
  assert.equal(reviewLaunches.length, 2)
  assert.ok(reviewLaunches.every((launch) => launch.role === 'reviewer'))
  assert.ok(reviewLaunches.every((launch) => launch.worktree === 'new-child'))
  assert.notEqual(reviewLaunches[0].name, reviewLaunches[1].name)

  const fixerLaunches = orca.launches.filter((launch) => launch.role === 'fixer')
  assert.equal(fixerLaunches.length, 3)
  assert.equal(fixerLaunches[0].worktree, 'current')
  assert.equal(fixerLaunches[1].terminal, 'term-fixer')
  assert.equal(fixerLaunches[2].terminal, 'term-fixer')
  assert.ok(orca.calls.some((call) => call.startsWith('gate:') && call.includes('docs-1')))
  assert.equal(orca.removedWorktrees.length, orca.launches.filter((launch) => launch.worktree === 'new-child').length)
  assert.ok(git.calls.indexOf('rebase:main') < git.calls.indexOf('push:feature'))
  assert.equal(git.calls.filter((call) => call === 'push:feature').length, 2)
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[review check 1]'))?.spec ?? '',
    /report exactly once with worker_done/i
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[review fix 1]'))?.spec ?? '',
    /Null input crashes the command/
  )
  assert.equal(orca.calls.at(-1), 'status:completed:no-mistakes passed all 9 stages')
})

test('delivery failures require a successful retry instead of approval', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  const pushFailure: StageReport = {
    findings: [
      {
        id: 'push-failed',
        severity: 'error',
        action: 'ask-user',
        description: 'Authentication failed'
      }
    ],
    summary: 'push failed'
  }
  git.pushReports.push(pushFailure, pass('retry pushed'))
  orca.gateResolution = 'retry'

  await runPipeline({ intent: 'Deliver the committed change.' }, orca, git)

  assert.equal(git.calls.filter((call) => call === 'push:feature').length, 2)
  assert.equal(orca.launches.filter((launch) => launch.role === 'fixer').length, 0)
  assert.ok(orca.calls.some((call) => call.startsWith('gate:') && call.includes('push-failed')))
})

test('malformed reviewer findings fail closed and still clean up the worker', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  orca.reports.set('review', [
    {
      findings: [
        {
          id: 'bad-severity',
          severity: 'critical',
          action: 'auto-fix',
          description: 'This report is outside the schema.'
        } as unknown as Finding
      ],
      summary: 'malformed'
    }
  ])

  await assert.rejects(
    runPipeline({ intent: 'Validate malformed reports.' }, orca, git),
    /review worker returned an invalid finding/
  )

  assert.ok(orca.calls.some((call) => call.startsWith('release:')))
  assert.equal(orca.removedWorktrees.length, 1)
})

test('install makes plain git push no-mistakes usable without an upstream branch', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-no-mistakes-'))
  const repo = path.join(temp, 'repo')
  try {
    await mkdir(repo)
    git(repo, 'init', '-b', 'feature')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await writeFile(path.join(repo, 'README.md'), 'test\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-m', 'initial')

    const gate = await installGitGate({ repo, intent: 'Test the gate.' })
    const hook = path.join(gate, 'hooks', 'post-receive')
    assert.match(await readFile(hook, 'utf8'), /unset \$\(git rev-parse --local-env-vars\)/)
    await writeFile(hook, '#!/bin/sh\nexit 0\n')
    await chmod(hook, 0o755)

    git(repo, 'push', 'no-mistakes')

    assert.equal(git(repo, 'config', '--get', 'orca-no-mistakes.intent'), 'Test the gate.')
    assert.equal(
      git(repo, `--git-dir=${gate}`, 'rev-parse', 'refs/heads/feature'),
      git(repo, 'rev-parse', 'HEAD')
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('CliOrca creates a fixer once and reuses its terminal without creation flags', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-cli-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const countPath = path.join(temp, 'count')
  const evidence = path.join(process.env.HOME!, '.orca-no-mistakes', 'evidence', 'adapter-test')
  const reportOne = path.join(evidence, 'one.json')
  const reportTwo = path.join(evidence, 'two.json')
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(reportOne, JSON.stringify(pass('first fix')))
    await writeFile(reportTwo, JSON.stringify(pass('second fix')))
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'orchestration' && args[1] === 'worker-start') {
  const reused = args.includes('--terminal')
  out({ dispatchId: reused ? 'dispatch-2' : 'dispatch-1', state: 'ready', effects: [] })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  const count = fs.existsSync(${JSON.stringify(countPath)}) ? Number(fs.readFileSync(${JSON.stringify(countPath)}, 'utf8')) : 0
  fs.writeFileSync(${JSON.stringify(countPath)}, String(count + 1))
  const dispatchId = count === 0 ? 'dispatch-1' : 'dispatch-2'
  const taskId = count === 0 ? 'task-1' : 'task-2'
  const reportPath = count === 0 ? ${JSON.stringify(reportOne)} : ${JSON.stringify(reportTwo)}
  out({ deliveryId: 'delivery-' + count, messages: [{ type: 'worker_done', body: 'Fixed the issue. Verified the change. Nothing remains.', payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded', reportPath }) }] })
} else if (args[0] === 'orchestration' && args[1] === 'worker-show') {
  out({ worker: { agent_terminal_handle: 'fixer-terminal' } })
} else {
  out({ ok: true })
}
`
    )
    await chmod(fakeOrca, 0o755)
    const orca = new CliOrca({
      command: fakeOrca,
      cwd: temp,
      fixerModel: 'gpt-5.6',
      fixerEffort: 'high'
    })

    const first = await orca.startWorker('task-1', {
      name: 'first-fixer',
      prompt: 'first',
      role: 'fixer',
      stage: 'review',
      worktree: 'current'
    })
    await orca.finishWorker(first, 'retain')
    const second = await orca.startWorker('task-2', {
      name: 'second-fixer',
      prompt: 'second',
      role: 'fixer',
      stage: 'lint',
      terminal: first.terminalHandle,
      worktree: 'current'
    })
    await orca.finishWorker(second, 'release')

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const starts = calls.filter((args) => args[1] === 'worker-start')
    assert.equal(starts.length, 2)
    assert.ok(starts[0].includes('--agent'))
    assert.ok(starts[0].includes('--model'))
    assert.ok(starts[0].includes('--effort'))
    assert.ok(!starts[0].includes('--name'))
    assert.ok(starts[1].includes('--terminal'))
    assert.ok(!starts[1].includes('--agent'))
    assert.ok(!starts[1].includes('--model'))
    assert.ok(!starts[1].includes('--effort'))
    assert.ok(!starts[1].includes('--name'))
  } finally {
    await rm(temp, { recursive: true, force: true })
    await rm(evidence, { recursive: true, force: true })
  }
})

test('GitShell rebases a clean feature branch and delivers it to origin', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-git-'))
  const origin = path.join(temp, 'origin.git')
  const repo = path.join(temp, 'repo')
  try {
    git(temp, 'init', '--bare', origin)
    git(temp, 'clone', origin, repo)
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    git(repo, 'checkout', '-b', 'main')
    await writeFile(path.join(repo, 'README.md'), 'main\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-m', 'main')
    git(repo, 'push', '-u', 'origin', 'main')
    git(temp, `--git-dir=${origin}`, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git(repo, 'fetch', 'origin')
    git(repo, 'checkout', '-b', 'feature')
    await writeFile(path.join(repo, 'feature.txt'), 'feature\n')
    git(repo, 'add', 'feature.txt')
    git(repo, 'commit', '-m', 'feature')

    const shell = new GitShell({ repo })
    const state = await shell.assertReady()
    assert.equal(state.base, 'main')
    assert.equal(state.branch, 'feature')
    assert.deepEqual((await shell.rebase(state.base)).findings, [])
    assert.deepEqual((await shell.push(state.branch)).findings, [])
    assert.equal(
      git(temp, `--git-dir=${origin}`, 'rev-parse', 'refs/heads/feature'),
      git(repo, 'rev-parse', 'HEAD')
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
