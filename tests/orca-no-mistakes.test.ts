import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CliOrca,
  GitShell,
  PIPELINE_STEPS,
  installGitGate,
  main,
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
  readonly fixerDispatches: string[] = []
  readonly gates: { options: string[]; question: string }[] = []
  readonly completedStages: string[] = []
  readonly removedWorktrees: string[] = []
  readonly reports = new Map<string, StageReport[]>()
  gateResolution = 'approve'
  #taskNumber = 0
  #dispatchNumber = 0
  #git: FakeGit
  #runId: string

  constructor(git: FakeGit, runId = `test-run-${randomUUID()}`) {
    this.#git = git
    this.#runId = runId
  }

  async createRun(objective: string): Promise<string> {
    this.calls.push(`run:${objective}`)
    return this.#runId
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
      this.fixerDispatches.push(dispatchId)
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

  async createGate(taskId: string, question: string, options: string[]): Promise<string> {
    this.gates.push({ options, question })
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

  assert.match(result.runId, /^test-run-/)
  assert.deepEqual(result.steps, PIPELINE_STEPS)
  assert.deepEqual(orca.completedStages, PIPELINE_STEPS)

  const stageTasks = orca.tasks.slice(0, PIPELINE_STEPS.length)
  assert.equal(stageTasks.length, PIPELINE_STEPS.length)
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
  assert.ok(
    orca.fixerDispatches.every((dispatchId) => orca.calls.includes(`release:${dispatchId}`)),
    'every retained fixer dispatch is eventually released'
  )
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
  assert.equal(
    orca.calls.at(-1),
    `status:completed:no-mistakes passed all ${PIPELINE_STEPS.length} stages`
  )
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
  assert.deepEqual(orca.gates[0].options, ['retry', 'stop'])
  assert.doesNotMatch(orca.gates[0].question, /approve|skip|fix/)
})

test('fails after the configured fix-round limit', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  const finding: Finding = {
    id: 'persistent',
    severity: 'error',
    action: 'auto-fix',
    description: 'The same defect remains.'
  }
  orca.reports.set('review', [
    { findings: [finding], summary: 'first failure' },
    pass('fix committed'),
    { findings: [finding], summary: 'still failing' }
  ])

  await assert.rejects(
    runPipeline({ intent: 'Bound automatic repairs.', maxFixRounds: 1 }, orca, git),
    /review still has findings after 1 fix rounds: still failing/
  )
  assert.ok(orca.calls.some((call) => call.includes('status:in-review:no-mistakes stopped:')))
})

test('unknown gate decisions stop the pipeline and update worktree status', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  orca.gateResolution = 'later'
  orca.reports.set('document', [
    {
      findings: [
        {
          id: 'docs-choice',
          severity: 'warning',
          action: 'ask-user',
          description: 'Documentation ownership is unclear.'
        }
      ],
      summary: 'decision needed'
    }
  ])

  await assert.rejects(
    runPipeline({ intent: 'Reject unknown decisions.' }, orca, git),
    /document gate stopped the pipeline: later/
  )
  assert.ok(orca.calls.some((call) => call.includes('status:in-review:no-mistakes stopped:')))
})

test('unsafe Orca Run IDs cannot escape the evidence directory', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git, '../outside-evidence')
  await assert.rejects(
    runPipeline({ intent: 'Confine Run evidence.' }, orca, git),
    /Orca returned an unsafe Run ID/
  )
  assert.equal(orca.tasks.length, 0)
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

test('reviewer artifacts must exist under the run evidence directory', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  orca.reports.set('review', [
    { findings: [], summary: 'unsafe evidence', artifacts: ['/tmp/outside-evidence.log'] }
  ])

  await assert.rejects(
    runPipeline({ intent: 'Confine reviewer evidence.' }, orca, git),
    /review worker returned an unsafe artifact path/
  )
  assert.ok(orca.calls.some((call) => call.startsWith('release:')))
  assert.equal(orca.removedWorktrees.length, 1)

  const missingOrca = new FakeOrca(git)
  missingOrca.reports.set('review', [
    { findings: [], summary: 'missing evidence', artifacts: ['missing.log'] }
  ])
  await assert.rejects(
    runPipeline({ intent: 'Require reviewer evidence.' }, missingOrca, git),
    /review worker returned a missing artifact/
  )
  assert.ok(missingOrca.calls.some((call) => call.startsWith('release:')))
  assert.equal(missingOrca.removedWorktrees.length, 1)
})

test('install requires per-push intent without persisting a fallback', async () => {
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
    git(repo, 'config', 'orca-no-mistakes.intent', 'stale intent')

    const gate = await installGitGate({ repo })
    const hooks = path.join(gate, 'hooks')
    const preReceive = path.join(hooks, 'pre-receive')
    const postReceive = path.join(hooks, 'post-receive')
    const hookSource = await readFile(postReceive, 'utf8')
    assert.match(hookSource, /GIT_PUSH_OPTION_COUNT/)
    assert.doesNotMatch(hookSource, /ORCA_NO_MISTAKES_INTENT|orca-no-mistakes\.intent/)
    assert.match(await readFile(preReceive, 'utf8'), /per-push intent is required/)
    assert.equal(git(repo, `--git-dir=${gate}`, 'config', '--get', 'core.hooksPath'), hooks)
    assert.equal(git(repo, `--git-dir=${gate}`, 'config', '--get', 'receive.advertisePushOptions'), 'true')
    assert.throws(() => git(repo, 'config', '--get', 'orca-no-mistakes.intent'))
    await writeFile(postReceive, '#!/bin/sh\nexit 0\n')
    await chmod(postReceive, 0o755)

    assert.throws(() => git(repo, 'push', 'orca-no-mistakes'))
    git(repo, 'push', '--push-option=no-mistakes.intent=Test this commit set.', 'orca-no-mistakes')

    assert.equal(
      git(repo, `--git-dir=${gate}`, 'rev-parse', 'refs/heads/feature'),
      git(repo, 'rev-parse', 'HEAD')
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('push sends intent through Git push options', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-push-intent-'))
  const repo = path.join(temp, 'repo')
  const receivedIntent = path.join(temp, 'received-intent')
  try {
    await mkdir(repo)
    git(repo, 'init', '-b', 'feature')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await writeFile(path.join(repo, 'README.md'), 'test\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-m', 'initial')

    const gate = await installGitGate({ repo })
    const hook = path.join(gate, 'hooks', 'post-receive')
    await writeFile(hook, `#!/bin/sh\nprintf '%s' "$GIT_PUSH_OPTION_0" > '${receivedIntent}'\n`)
    await chmod(hook, 0o755)

    await main(['push', `--repo=${repo}`, '--intent=Explain this exact commit set.'])

    assert.equal(await readFile(receivedIntent, 'utf8'), 'no-mistakes.intent=Explain this exact commit set.')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('CLI accepts equals syntax and preserves negative numeric values', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-cli-'))
  try {
    git(temp, 'init', '-b', 'feature')
    await assert.rejects(
      main(['run', `--repo=${temp}`, '--intent=Validate parsing.', '--max-fix-rounds=-1']),
      /maxFixRounds must be a non-negative integer/
    )
    await assert.rejects(main(['install', '--repo']), /--repo requires a value/)
    await assert.rejects(main(['install', '--intent=x']), /--intent is not valid for install/)
    await assert.rejects(main(['run', '--force', '--intent=x']), /--force is not valid for run/)
    await assert.rejects(main(['install', '--base=main']), /--base is not valid for install/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('CliOrca creates a fixer once and reuses its terminal without creation flags', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-cli-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const countPath = path.join(temp, 'count')
  const startCountPath = path.join(temp, 'start-count')
  const evidence = path.join(homedir(), '.orca-no-mistakes', 'evidence', 'adapter-test')
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
if (args[0] === 'orchestration' && args[1] === 'run-create') {
  out({ run: { id: 'adapter-test' } })
} else if (args[0] === 'terminal' && args[1] === 'create') {
  out({ terminal: { handle: 'created-fixer' } })
} else if (args[0] === 'terminal' && args[1] === 'send') {
  out({ accepted: true })
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, title: 'OC | OpenCode Discussion', preview: 'ready' } })
} else if (args[0] === 'orchestration' && args[1] === 'worker-start') {
  const count = fs.existsSync(${JSON.stringify(startCountPath)}) ? Number(fs.readFileSync(${JSON.stringify(startCountPath)}, 'utf8')) : 0
  fs.writeFileSync(${JSON.stringify(startCountPath)}, String(count + 1))
  out({ dispatchId: 'dispatch-' + (count + 1), state: 'ready', effects: [] })
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
    await orca.createRun('adapter test')

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
    assert.ok(starts[0].includes('--terminal'))
    assert.ok(!starts[0].includes('--agent'))
    assert.ok(!starts[0].includes('--model'))
    assert.ok(!starts[0].includes('--effort'))
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

test('CliOrca boots a fresh opencode terminal before worker-start', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-cli-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const evidence = path.join(homedir(), '.orca-no-mistakes', 'evidence', 'adapter-new-child')
  const reportPath = path.join(evidence, 'review.json')
  const worktreeId = 'repo-id::/tmp/worker'
  try {
    git(temp, 'init', '-b', 'feature')
    await mkdir(evidence, { recursive: true })
    await writeFile(reportPath, JSON.stringify(pass('reviewed')))
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'orchestration' && args[1] === 'run-create') {
  out({ run: { id: 'adapter-new-child' } })
} else if (args[0] === 'worktree' && args[1] === 'create') {
  out({ worktree: { id: ${JSON.stringify(worktreeId)}, path: '/tmp/worker' } })
} else if (args[0] === 'terminal' && args[1] === 'list') {
  out({ terminals: [{ handle: 'worker-shell', connected: true, writable: true }] })
} else if (args[0] === 'terminal' && args[1] === 'send') {
  out({ accepted: true })
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, title: 'OC | OpenCode Discussion', preview: 'ready' } })
} else if (args[0] === 'orchestration' && args[1] === 'worker-start') {
  out({ dispatchId: 'dispatch-review', state: 'ready', effects: [] })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  out({ deliveryId: 'delivery-review', messages: [{ type: 'worker_done', body: 'Reviewed. Verified. Nothing remains.', payload: JSON.stringify({ taskId: 'task-review', dispatchId: 'dispatch-review', outcome: 'succeeded', reportPath: ${JSON.stringify(reportPath)} }) }] })
} else if (args[0] === 'orchestration' && args[1] === 'worker-show') {
  out({ worker: { agent_terminal_handle: 'worker-shell' } })
} else {
  out({ ok: true })
}
`
    )
    await chmod(fakeOrca, 0o755)
    const orca = new CliOrca({ command: fakeOrca, cwd: temp })
    await orca.createRun('adapter test')

    const worker = await orca.startWorker('task-review', {
      name: 'fresh-reviewer',
      prompt: 'contains ) and shell syntax',
      role: 'reviewer',
      stage: 'review',
      worktree: 'new-child'
    })

    assert.equal(worker.worktreeId, worktreeId)
    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const worktreeCreate = calls.find((args) => args[0] === 'worktree' && args[1] === 'create')
    const terminalSend = calls.find((args) => args[0] === 'terminal' && args[1] === 'send')
    const workerStart = calls.find((args) => args[0] === 'orchestration' && args[1] === 'worker-start')
    assert.ok(worktreeCreate?.includes('--base-branch'))
    assert.ok(worktreeCreate?.includes('feature'))
    assert.deepEqual(terminalSend?.slice(0, 6), [
      'terminal',
      'send',
      '--terminal',
      'worker-shell',
      '--text',
      "'opencode'"
    ])
    assert.ok(workerStart?.includes('--terminal'))
    assert.ok(!workerStart?.includes('--agent'))
    assert.ok(!workerStart?.includes('--name'))
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

test('bundled skill never collides with the no-mistakes skill name', async () => {
  const skills = await readdir(new URL('../skills', import.meta.url), 'utf8')
  assert.ok(skills.includes('orca-no-mistakes'))
  assert.ok(!skills.includes('no-mistakes'))
})
