import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CliOrca,
  GitShell,
  PIPELINE_STEPS,
  installGitGate,
  main,
  parseGateResolution,
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
  branch = 'feature'
  #head = 'head-1'
  #pendingApplyFailures: StageReport[] = []

  async assertReady(): Promise<{ base: string; branch: string; head: string; root: string }> {
    this.calls.push('assert-ready')
    return { base: 'main', branch: this.branch, head: this.#head, root: '/repo' }
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

  async applyWorktreeCommits(sourcePath: string, base: string): Promise<StageReport> {
    this.calls.push(`apply:${base}:${sourcePath}`)
    const failure = this.#pendingApplyFailures.shift()
    if (failure) return failure
    this.advanceHead()
    return pass('applied fixer commits to the gate branch')
  }

  async deleteBranch(name: string): Promise<void> {
    this.calls.push(`delete-branch:${name}`)
  }

  advanceHead(): void {
    this.#head = `head-${Number(this.#head.split('-')[1]) + 1}`
  }

  failApplyOnce(report: StageReport): void {
    this.#pendingApplyFailures.push(report)
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
  failWorkerFor?: string
  #taskNumber = 0
  #dispatchNumber = 0
  #runId: string

  constructor(_git: FakeGit, runId = `test-run-${randomUUID()}`) {
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
    if (this.failWorkerFor === launch.stage) {
      throw new Error(`${launch.stage} worker was cancelled`)
    }
    const stage = launch.stage
    const reports = this.reports.get(stage) ?? [pass(stage)]
    const report = reports.shift() ?? pass(stage)
    this.reports.set(stage, reports)
    if (launch.role === 'fixer') {
      this.fixerDispatches.push(dispatchId)
    }
    return {
      deliveryId: `delivery-${dispatchId}`,
      dispatchId,
      report,
      taskId,
      terminalHandle: `term-${dispatchId}`,
      worktreeId: `repo::/${dispatchId}`,
      worktreePath: `/wt/${dispatchId}`
    }
  }

  async finishWorker(worker: WorkerResult): Promise<void> {
    this.calls.push(`release:${worker.dispatchId}`)
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
    {
      intent: 'Add the requested command without changing existing behavior.',
      gate: { branch: 'no-mistakes-gate-test', worktreeId: 'wt-gate' }
    },
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
  assert.notEqual(reviewLaunches[0].name, reviewLaunches[1].name)

  const fixerLaunches = orca.launches.filter((launch) => launch.role === 'fixer')
  assert.equal(fixerLaunches.length, 3)
  assert.ok(
    orca.fixerDispatches.every((dispatchId) => orca.calls.includes(`release:${dispatchId}`)),
    'every fixer dispatch is released after its round'
  )
  const applyCalls = git.calls.filter((call) => call.startsWith('apply:'))
  assert.equal(applyCalls.length, 3)
  assert.ok(
    orca.fixerDispatches.every((dispatchId) =>
      applyCalls.some((call) => call.endsWith(`:/wt/${dispatchId}`))
    ),
    'every fixer round applies its commits to the gate branch'
  )
  assert.ok(orca.calls.some((call) => call.startsWith('gate:') && call.includes('docs-1')))
  assert.equal(orca.removedWorktrees.length, orca.launches.length + 1)
  assert.ok(orca.removedWorktrees.includes('wt-gate'), 'the gate worktree is removed')
  assert.ok(git.calls.includes('delete-branch:no-mistakes-gate-test'), 'the gate branch is deleted')
  assert.ok(git.calls.indexOf('rebase:main') < git.calls.indexOf('push:feature'))
  assert.equal(git.calls.filter((call) => call === 'push:feature').length, 2)
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[review check 1]'))?.spec ?? '',
    /report exactly once with worker_done/i
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[review check 1]'))?.spec ?? '',
    /Do NOT run tests during review/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[test check 1]'))?.spec ?? '',
    /Do NOT run the complete repository test suite/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[document check 1]'))?.spec ?? '',
    /Find what this change made stale/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[lint check 1]'))?.spec ?? '',
    /Discover configured linters/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[pr check 1]'))?.spec ?? '',
    /conventional commit format/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[ci check 1]'))?.spec ?? '',
    /Wait for all required CI checks/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[review fix 1]'))?.spec ?? '',
    /Null input crashes the command/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[review fix 1]'))?.spec ?? '',
    /Apply all the fixes you intend to make first/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[lint fix 1]'))?.spec ?? '',
    /Re-run the relevant lint or format commands/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[ci fix 1]'))?.spec ?? '',
    /fix the test to be cross-platform/
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

test('opens an exhaustion gate when automatic fix limit is reached and stops on stop decision', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  orca.gateResolution = 'stop'
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
    /review gate stopped the pipeline: stop/
  )
  assert.ok(orca.calls.some((call) => call.includes('reached the limit of 1 fix rounds')))
  assert.ok(orca.calls.some((call) => call.includes('status:in-review:no-mistakes stopped:')))
})

test('exhaustion gate allows user to authorize another fix round', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  orca.gateResolution = 'fix: persistent: try alternative fix'
  const finding: Finding = {
    id: 'persistent',
    severity: 'error',
    action: 'auto-fix',
    description: 'The same defect remains.'
  }
  orca.reports.set('review', [
    { findings: [finding], summary: 'first failure' },
    pass('fix committed'),
    { findings: [finding], summary: 'still failing' },
    pass('clean rereview after exhaustion fix')
  ])

  const result = await runPipeline({ intent: 'Exhaustion fix test', maxFixRounds: 1 }, orca, git)
  assert.equal(result.steps.length, PIPELINE_STEPS.length)
  assert.ok(orca.calls.some((call) => call.includes('reached the limit of 1 fix rounds')))
  const postGateFixer = orca.tasks.find((task) => task.spec.startsWith('[review fix 2]'))
  assert.ok(postGateFixer, 'the gate authorized a second fix round')
  assert.match(postGateFixer.spec, /try alternative fix/)
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

test('reviewer title/message findings receive canonical descriptions and IDs', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  orca.reports.set('review', [
    {
      findings: [
        {
          severity: 'error',
          action: 'auto-fix',
          title: 'Missing canonical fields',
          message: 'This valid finding used review aliases.'
        } as unknown as Finding
      ],
      summary: 'missing ID'
    },
    pass('clean rereview')
  ])

  await runPipeline({ intent: 'Normalize reviewer IDs.' }, orca, git)

  const fixer = orca.launches.find((launch) => launch.role === 'fixer')
  assert.match(fixer?.prompt ?? '', /"id":"review-[0-9a-f]{12}"/)
  assert.match(
    fixer?.prompt ?? '',
    /"description":"Missing canonical fields: This valid finding used review aliases\."/
  )
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

test('reviewer URL references are not treated as local artifacts', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  orca.reports.set('review', [
    {
      findings: [
        {
          id: 'documented-finding',
          severity: 'error',
          action: 'auto-fix',
          description: 'The report cites external documentation.'
        }
      ],
      summary: 'external reference',
      artifacts: ['https://docs.example.com/reference']
    },
    pass('clean rereview')
  ])

  await runPipeline({ intent: 'Ignore external artifact references.' }, orca, git)

  assert.ok(orca.launches.some((launch) => launch.role === 'fixer'))
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

test('run launches the detached coordinator inside a fresh gate worktree', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-detached-run-'))
  const origin = path.join(temp, 'origin.git')
  const repo = path.join(temp, 'repo')
  const gateWt = path.join(temp, 'gate-wt')
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const previousCommand = process.env.ORCA_CLI_COMMAND
  const previousHandle = process.env.ORCA_TERMINAL_HANDLE
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
    git(repo, 'checkout', '-b', 'feature')

    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const result = args[0] === 'worktree' && args[1] === 'create'
  ? (() => {
      const name = args[args.indexOf('--name') + 1]
      const base = args[args.indexOf('--base-branch') + 1]
      execFileSync('git', ['worktree', 'add', ${JSON.stringify(gateWt)}, '-b', name, base], { cwd: ${JSON.stringify(repo)} })
      return { worktree: { id: 'wt-gate-1', path: ${JSON.stringify(gateWt)} } }
    })()
  : args[0] === 'terminal' && args[1] === 'create'
    ? { terminal: { handle: 'detached-coordinator' } }
    : args[0] === 'terminal' && args[1] === 'show'
      ? { terminal: { connected: true, preview: 'ready shell prompt' } }
      : { accepted: true }
console.log(JSON.stringify({ result }))
`
    )
    await chmod(fakeOrca, 0o755)
    process.env.ORCA_CLI_COMMAND = fakeOrca
    process.env.ORCA_TERMINAL_HANDLE = 'originating-opencode'

    const head = git(repo, 'rev-parse', 'HEAD')
    await main(['run', `--repo=${repo}`, `--head=${head}`, '--intent=Validate detached coordination.'])

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const worktreeCreate = calls.find((args) => args[0] === 'worktree' && args[1] === 'create')
    const terminalCreate = calls.find((args) => args[0] === 'terminal' && args[1] === 'create')
    const terminalSend = calls.find((args) => args[0] === 'terminal' && args[1] === 'send')
    assert.ok(worktreeCreate, 'the launcher creates the gate worktree first')
    assert.ok(terminalCreate, 'the launcher creates a coordinator terminal')
    assert.ok(calls.indexOf(worktreeCreate) < calls.indexOf(terminalCreate))
    assert.ok(worktreeCreate.includes('--base-branch'))
    assert.ok(worktreeCreate.includes('feature'))
    const parentWorktree =
      worktreeCreate[worktreeCreate.indexOf('--parent-worktree') + 1]?.replace(/^path:/, '') ?? ''
    assert.equal(await realpath(parentWorktree), await realpath(repo))
    const commandWorktree =
      terminalCreate?.[terminalCreate.indexOf('--worktree') + 1]?.replace(/^path:/, '') ?? ''
    assert.equal(await realpath(commandWorktree), await realpath(gateWt))
    assert.notEqual(await realpath(commandWorktree), await realpath(repo))
    const commandText = terminalSend?.[terminalSend.indexOf('--text') + 1] ?? ''
    assert.ok(commandText.includes("'--attached'"))
    assert.ok(commandText.includes(`'--repo' '${gateWt}'`))
    assert.ok(commandText.includes("NO_MISTAKES_DELIVERY_BRANCH='feature'"))
    assert.ok(commandText.includes("NO_MISTAKES_GATE_WORKTREE_ID='wt-gate-1'"))
    const gateBranch = worktreeCreate[worktreeCreate.indexOf('--name') + 1]
    assert.ok(commandText.includes(`NO_MISTAKES_GATE_BRANCH='${gateBranch}'`))
    assert.ok(commandText.includes(`'--head' '${git(repo, 'rev-parse', 'HEAD')}'`))
    assert.ok(commandText.includes("'--notify' 'originating-opencode'"))
    assert.ok(commandText.includes("'--intent' 'Validate detached coordination.'"))
    assert.ok(!calls.some((args) => args[0] === 'orchestration'))
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND
    else process.env.ORCA_CLI_COMMAND = previousCommand
    if (previousHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE
    else process.env.ORCA_TERMINAL_HANDLE = previousHandle
    await rm(temp, { recursive: true, force: true })
  }
})

test('an attached run removes the gate when its own pre-flight check fails', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-gate-preflight-'))
  const origin = path.join(temp, 'origin.git')
  const repo = path.join(temp, 'repo')
  const gateWt = path.join(temp, 'gate-wt')
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const previous = {
    command: process.env.ORCA_CLI_COMMAND,
    branch: process.env.NO_MISTAKES_GATE_BRANCH,
    delivery: process.env.NO_MISTAKES_DELIVERY_BRANCH,
    worktree: process.env.NO_MISTAKES_GATE_WORKTREE_ID
  }
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
    git(repo, 'checkout', '-b', 'feature')
    git(repo, 'worktree', 'add', gateWt, '-b', 'no-mistakes-gate-preflight', 'feature')
    await writeFile(path.join(gateWt, 'leftover.txt'), 'dirty\n')
    git(gateWt, 'add', 'leftover.txt')

    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
if (args[0] === 'worktree' && args[1] === 'rm') {
  execFileSync('git', ['worktree', 'remove', '--force', ${JSON.stringify(gateWt)}], { cwd: ${JSON.stringify(repo)} })
}
console.log(JSON.stringify({ result: { accepted: true } }))
`
    )
    await chmod(fakeOrca, 0o755)
    process.env.ORCA_CLI_COMMAND = fakeOrca
    process.env.NO_MISTAKES_GATE_BRANCH = 'no-mistakes-gate-preflight'
    process.env.NO_MISTAKES_DELIVERY_BRANCH = 'feature'
    process.env.NO_MISTAKES_GATE_WORKTREE_ID = 'wt-gate-1'

    await assert.rejects(
      main(['run', '--attached', `--repo=${gateWt}`, '--intent=Validate gate cleanup.'])
    )

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    assert.ok(
      calls.some(
        (args) => args[0] === 'worktree' && args[1] === 'rm' && args.includes('id:wt-gate-1')
      ),
      'the gate worktree is removed'
    )
    assert.throws(
      () => git(repo, 'rev-parse', '--verify', 'no-mistakes-gate-preflight'),
      'the gate branch is deleted'
    )
  } finally {
    for (const [name, value] of [
      ['ORCA_CLI_COMMAND', previous.command],
      ['NO_MISTAKES_GATE_BRANCH', previous.branch],
      ['NO_MISTAKES_DELIVERY_BRANCH', previous.delivery],
      ['NO_MISTAKES_GATE_WORKTREE_ID', previous.worktree]
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(temp, { recursive: true, force: true })
  }
})

async function seedOriginRepo(temp: string): Promise<string> {
  const origin = path.join(temp, 'origin.git')
  const repo = path.join(temp, 'repo')
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
  return repo
}

async function writeGateOrca(
  fakeOrca: string,
  callsPath: string,
  repo: string,
  gateWt: string,
  terminalCreateResult: string
): Promise<void> {
  await writeFile(
    fakeOrca,
    `#!/usr/bin/env node
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const result = args[0] === 'worktree' && args[1] === 'create'
  ? (() => {
      const name = args[args.indexOf('--name') + 1]
      const base = args[args.indexOf('--base-branch') + 1]
      execFileSync('git', ['worktree', 'add', ${JSON.stringify(gateWt)}, '-b', name, base], { cwd: ${JSON.stringify(repo)} })
      return { worktree: { id: 'wt-gate-1', path: ${JSON.stringify(gateWt)} } }
    })()
  : args[0] === 'worktree' && args[1] === 'rm'
    ? (() => {
        execFileSync('git', ['worktree', 'remove', '--force', ${JSON.stringify(gateWt)}], { cwd: ${JSON.stringify(repo)} })
        return { accepted: true }
      })()
    : args[0] === 'terminal' && args[1] === 'create'
      ? ${terminalCreateResult}
      : args[0] === 'terminal' && args[1] === 'show'
        ? { terminal: { connected: true, preview: 'ready shell prompt' } }
        : { accepted: true }
console.log(JSON.stringify({ result }))
`
  )
  await chmod(fakeOrca, 0o755)
}

test('the gate worktree is created against the main repository root', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-gate-root-'))
  const linked = path.join(temp, 'linked')
  const gateWt = path.join(temp, 'gate-wt')
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const previousCommand = process.env.ORCA_CLI_COMMAND
  try {
    const repo = await seedOriginRepo(temp)
    git(repo, 'worktree', 'add', linked, '-b', 'linked-feature')
    await writeGateOrca(fakeOrca, callsPath, repo, gateWt, "{ terminal: { handle: 'detached-coordinator' } }")
    process.env.ORCA_CLI_COMMAND = fakeOrca

    await main(['run', `--repo=${linked}`, '--intent=Validate gate creation from a linked worktree.'])

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const worktreeCreate = calls.find((args) => args[0] === 'worktree' && args[1] === 'create')
    assert.ok(worktreeCreate)
    const repoArg = worktreeCreate[worktreeCreate.indexOf('--repo') + 1].replace(/^path:/, '')
    const parentArg = worktreeCreate[worktreeCreate.indexOf('--parent-worktree') + 1].replace(/^path:/, '')
    assert.equal(await realpath(repoArg), await realpath(repo))
    assert.equal(await realpath(parentArg), await realpath(linked))
    assert.ok(worktreeCreate.includes('linked-feature'))
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND
    else process.env.ORCA_CLI_COMMAND = previousCommand
    await rm(temp, { recursive: true, force: true })
  }
})

test('a failed detached launch deletes the gate branch it created', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-gate-launch-fail-'))
  const gateWt = path.join(temp, 'gate-wt')
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const previousCommand = process.env.ORCA_CLI_COMMAND
  try {
    const repo = await seedOriginRepo(temp)
    git(repo, 'checkout', '-b', 'feature')
    await writeGateOrca(fakeOrca, callsPath, repo, gateWt, '{ terminal: {} }')
    process.env.ORCA_CLI_COMMAND = fakeOrca

    await assert.rejects(
      main(['run', `--repo=${repo}`, '--intent=Validate launch failure cleanup.']),
      /terminal create returned an invalid receipt/
    )

    assert.equal(git(repo, 'branch', '--list', 'no-mistakes-gate-*'), '')
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND
    else process.env.ORCA_CLI_COMMAND = previousCommand
    await rm(temp, { recursive: true, force: true })
  }
})

test('CliOrca notifies the originating terminal when a gate opens', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-gate-notify-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const previousHandle = process.env.ORCA_TERMINAL_HANDLE
  process.env.ORCA_TERMINAL_HANDLE = 'coordinator-opencode'
  try {
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const result = args[1] === 'run-create'
  ? { run: { id: 'gate-run' } }
  : args[1] === 'gate-create'
    ? { gate: { id: 'gate-review' } }
    : { message: { id: 'gate-notification' } }
console.log(JSON.stringify({ result }))
`
    )
    await chmod(fakeOrca, 0o755)
    const orca = new CliOrca({
      command: fakeOrca,
      cwd: temp,
      notifyHandle: 'originating-opencode'
    })
    await orca.createRun('gate notification')
    assert.equal(await orca.createGate('task-review', 'Choose a review action.'), 'gate-review')

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const sent = calls.find((args) => args[0] === 'orchestration' && args[1] === 'send')
    const wake = calls.find((args) => args[0] === 'terminal' && args[1] === 'send')
    assert.ok(sent?.includes('originating-opencode'))
    assert.ok(sent?.includes('gate-run'))
    assert.ok(sent?.includes('question'))
    assert.ok(sent?.includes('Choose a review action.\nGate: gate-review'))
    assert.ok(wake?.includes('originating-opencode'))
    assert.ok(wake?.includes('--enter'))
    assert.ok(wake?.some((value) => value.includes('no-mistakes gate response')))
  } finally {
    if (previousHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE
    else process.env.ORCA_TERMINAL_HANDLE = previousHandle
    await rm(temp, { recursive: true, force: true })
  }
})

test('CliOrca applies gate responses through the bound coordinator', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-gate-response-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const resolvedPath = path.join(temp, 'resolved')
  const previousHandle = process.env.ORCA_TERMINAL_HANDLE
  process.env.ORCA_TERMINAL_HANDLE = 'coordinator-opencode'
  try {
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
if (args[1] === 'run-create') {
  out({ run: { id: 'gate-run' } })
} else if (args[1] === 'gate-create') {
  out({ gate: { id: 'gate-review' } })
} else if (args[1] === 'gate-list') {
  out({ gates: [{ id: 'gate-review', status: fs.existsSync(${JSON.stringify(resolvedPath)}) ? 'resolved' : 'pending', resolution: 'fix: verified' }] })
} else if (args[1] === 'check' && args.includes('--types')) {
  out({ messages: [{ id: 'response-message', from_handle: 'originating-opencode', subject: 'no-mistakes gate response', body: JSON.stringify({ gateId: 'gate-review', resolution: 'fix: verified' }) }] })
} else if (args[1] === 'gate-resolve') {
  fs.writeFileSync(${JSON.stringify(resolvedPath)}, 'yes')
  out({ gate: { id: 'gate-review', status: 'resolved' } })
} else {
  out({ ok: true })
}
`
    )
    await chmod(fakeOrca, 0o755)
    const orca = new CliOrca({ command: fakeOrca, cwd: temp, notifyHandle: 'originating-opencode' })
    await orca.createRun('gate response')

    assert.equal(await orca.createGate('task-review', 'Choose a review action.'), 'gate-review')
    assert.equal(await orca.waitForGate('gate-review'), 'fix: verified')

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const resolved = calls.find((args) => args[1] === 'gate-resolve')
    assert.ok(resolved?.includes('fix: verified'))
    assert.ok(calls.some((args) => args[1] === 'check' && args.includes('--ack')))
  } finally {
    if (previousHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE
    else process.env.ORCA_TERMINAL_HANDLE = previousHandle
    await rm(temp, { recursive: true, force: true })
  }
})

test('CliOrca gives every fixer its own child worktree and terminal', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-cli-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const countPath = path.join(temp, 'count')
  const startCountPath = path.join(temp, 'wt-count')
  const dispatchCountPath = path.join(temp, 'dispatch-count')
  const evidence = path.join(homedir(), '.orca-no-mistakes', 'evidence', 'adapter-test')
  const reportOne = path.join(evidence, 'one.json')
  const reportTwo = path.join(evidence, 'two.json')
  const reportThree = path.join(evidence, 'three.json')
  try {
    git(temp, 'init', '-b', 'feature')
    await mkdir(evidence, { recursive: true })
    await writeFile(reportOne, JSON.stringify(pass('first fix')))
    await writeFile(reportTwo, JSON.stringify(pass('second fix')))
    await writeFile(reportThree, JSON.stringify(pass('third fix')))
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
const nextCount = (file) => {
  const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0
  fs.writeFileSync(file, String(count + 1))
  return count + 1
}
if (args[0] === 'orchestration' && args[1] === 'run-create') {
  out({ run: { id: 'adapter-test' } })
} else if (args[0] === 'worktree' && args[1] === 'create') {
  const n = nextCount(${JSON.stringify(startCountPath)})
  out({ worktree: { id: 'wt-' + n, path: '/wt-' + n } })
} else if (args[0] === 'terminal' && args[1] === 'list') {
  const n = Number(fs.readFileSync(${JSON.stringify(startCountPath)}, 'utf8'))
  out({ terminals: [{ handle: 'worker-shell-' + n, connected: true, writable: true }] })
} else if (args[0] === 'terminal' && args[1] === 'send') {
  out({ accepted: true })
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, lastOutputAt: 1, title: 'OpenCode', preview: 'ready' } })
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  const count = nextCount(${JSON.stringify(dispatchCountPath)})
  out({ dispatch: { id: 'dispatch-' + count, status: 'dispatched' }, injected: true, preamble: 'authenticated' })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  const count = nextCount(${JSON.stringify(countPath)})
  const dispatchId = 'dispatch-' + count
  const taskId = 'task-' + count
  const reportPath = count === 1 ? ${JSON.stringify(reportOne)} : count === 2 ? ${JSON.stringify(reportTwo)} : ${JSON.stringify(reportThree)}
  out({ deliveryId: 'delivery-' + count, messages: [{ type: 'worker_done', body: 'Fixed the issue. Verified the change. Nothing remains.', payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded', reportPath }) }] })
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
      stage: 'review'
    })
    await orca.finishWorker(first)
    const second = await orca.startWorker('task-2', {
      name: 'second-fixer',
      prompt: 'second',
      role: 'fixer',
      stage: 'lint'
    })
    await orca.finishWorker(second)
    const third = await orca.startWorker('task-3', {
      name: 'third-fixer',
      prompt: 'third',
      role: 'fixer',
      stage: 'test'
    })
    await orca.finishWorker(third)

    assert.equal(first.worktreeId, 'wt-1')
    assert.equal(first.worktreePath, '/wt-1')
    assert.equal(first.terminalHandle, 'worker-shell-1')
    assert.equal(second.worktreeId, 'wt-2')
    assert.equal(second.terminalHandle, 'worker-shell-2')
    assert.equal(third.worktreeId, 'wt-3')
    assert.equal(third.terminalHandle, 'worker-shell-3')
    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const starts = calls.filter((args) => args[1] === 'dispatch')
    assert.equal(starts.length, 3)
    const worktreeCreates = calls.filter((args) => args[0] === 'worktree' && args[1] === 'create')
    assert.equal(worktreeCreates.length, 3)
    for (const created of worktreeCreates) {
      assert.ok(created.includes('--base-branch'))
      assert.ok(created.includes('feature'))
      assert.ok(created.includes('--parent-worktree'))
    }
    const closes = calls.filter((args) => args[0] === 'terminal' && args[1] === 'close')
    assert.equal(closes.length, 3)
    assert.deepEqual(
      closes.map((close) => close[close.indexOf('--terminal') + 1]),
      ['worker-shell-1', 'worker-shell-2', 'worker-shell-3']
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
    await rm(evidence, { recursive: true, force: true })
  }
})

test('CliOrca boots a fresh opencode terminal before authenticated dispatch', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-cli-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const checkCountPath = path.join(temp, 'check-count')
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
  const count = fs.existsSync(${JSON.stringify(checkCountPath)}) ? Number(fs.readFileSync(${JSON.stringify(checkCountPath)}, 'utf8')) : 0
  out({ terminal: { connected: true, lastOutputAt: count, title: 'OC | OpenCode Discussion', preview: 'ready' } })
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  out({ dispatch: { id: 'dispatch-review', status: 'dispatched' }, injected: true, preamble: 'authenticated' })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  const count = fs.existsSync(${JSON.stringify(checkCountPath)}) ? Number(fs.readFileSync(${JSON.stringify(checkCountPath)}, 'utf8')) : 0
  fs.writeFileSync(${JSON.stringify(checkCountPath)}, String(count + 1))
  if (count === 0) {
    console.log(JSON.stringify({ _keepalive: true, _heartbeat: true, elapsedMs: 15000, deadlineMs: 900000 }))
    process.exitCode = 1
  } else if (count === 1) {
    out({ deliveryId: 'delivery-heartbeat', messages: [{ type: 'heartbeat', body: 'still reviewing', payload: JSON.stringify({ taskId: 'task-review', dispatchId: 'dispatch-review' }) }] })
  } else {
    out({ deliveryId: 'delivery-review', messages: [{ type: 'worker_done', body: 'Reviewed. Verified. Nothing remains.', payload: JSON.stringify({ taskId: 'task-review', dispatchId: 'dispatch-review', outcome: 'succeeded', reportPath: ${JSON.stringify(reportPath)} }) }] })
  }
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
      stage: 'review'
    })

    assert.equal(worker.worktreeId, worktreeId)
    assert.equal(worker.worktreePath, '/tmp/worker')
    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const worktreeCreate = calls.find((args) => args[0] === 'worktree' && args[1] === 'create')
    const terminalSend = calls.find((args) => args[0] === 'terminal' && args[1] === 'send')
    const dispatch = calls.find((args) => args[0] === 'orchestration' && args[1] === 'dispatch')
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
    assert.ok(dispatch?.includes('--to'))
    assert.ok(dispatch?.includes('worker-shell'))
    assert.ok(dispatch?.includes('--inject'))
    assert.ok(dispatch?.includes('--return-preamble'))
    assert.ok(!dispatch?.includes('--agent'))
    assert.ok(!dispatch?.includes('--name'))
    assert.equal(
      calls.filter(
        (args) => args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')
      ).length,
      3
    )
    assert.ok(
      calls.some(
        (args) =>
          args[0] === 'orchestration' &&
          args[1] === 'check' &&
          args.includes('--ack') &&
          args.includes('delivery-heartbeat')
      )
    )
    assert.ok(calls.filter((args) => args[0] === 'terminal' && args[1] === 'show').length >= 3)
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

    const gatePath = path.join(temp, 'gate')
    git(repo, 'worktree', 'add', gatePath, '-b', 'no-mistakes-gate-x', 'HEAD')
    const gateShell = new GitShell({ repo: gatePath })
    const gateState = await gateShell.assertReady()
    assert.equal(gateState.branch, 'no-mistakes-gate-x')
    assert.equal(gateState.base, 'main')

    const workerPath = path.join(temp, 'worker')
    git(gatePath, 'worktree', 'add', workerPath, '-b', 'no-mistakes-fixer-y', 'HEAD')
    const baseSha = git(gatePath, 'rev-parse', 'HEAD')
    await writeFile(path.join(workerPath, 'fix.txt'), 'fixed\n')
    git(workerPath, 'add', 'fix.txt')
    git(workerPath, 'commit', '-m', 'fix it')

    const applied = await gateShell.applyWorktreeCommits(workerPath, baseSha)
    assert.deepEqual(applied.findings, [])
    assert.equal(
      git(gatePath, 'rev-parse', 'HEAD^{tree}'),
      git(workerPath, 'rev-parse', 'HEAD^{tree}')
    )

    const divergedBase = git(workerPath, 'rev-parse', 'HEAD')
    await writeFile(path.join(gatePath, 'conflict.txt'), 'gate\n')
    git(gatePath, 'add', 'conflict.txt')
    git(gatePath, 'commit', '-m', 'gate change')
    const conflictedGateHead = git(gatePath, 'rev-parse', 'HEAD')
    await writeFile(path.join(workerPath, 'conflict.txt'), 'worker\n')
    git(workerPath, 'add', 'conflict.txt')
    git(workerPath, 'commit', '-m', 'worker change')

    const failedApply = await gateShell.applyWorktreeCommits(workerPath, divergedBase)
    assert.equal(failedApply.findings[0].id, 'fix-apply-failed')
    assert.equal(failedApply.findings[0].action, 'ask-user')
    assert.equal(git(gatePath, 'rev-parse', 'HEAD'), conflictedGateHead)
    await gateShell.assertClean()

    await gateShell.push(state.branch)
    assert.equal(
      git(temp, `--git-dir=${origin}`, 'rev-parse', 'refs/heads/feature'),
      git(gatePath, 'rev-parse', 'HEAD')
    )

    const workerHead = git(workerPath, 'rev-parse', 'HEAD')
    await writeFile(path.join(workerPath, 'dirty.txt'), 'uncommitted\n')
    git(workerPath, 'add', 'dirty.txt')
    const dirtyApply = await gateShell.applyWorktreeCommits(workerPath, workerHead)
    assert.equal(dirtyApply.findings[0].id, 'fix-apply-failed')
    assert.match(dirtyApply.findings[0].description, /uncommitted changes/)
    git(workerPath, 'reset', '--hard')

    const gateHeadBefore = git(gatePath, 'rev-parse', 'HEAD')
    const emptyApply = await gateShell.applyWorktreeCommits(workerPath, workerHead)
    assert.deepEqual(emptyApply.findings, [])
    assert.equal(git(gatePath, 'rev-parse', 'HEAD'), gateHeadBefore)

    git(gatePath, 'worktree', 'remove', workerPath)
    await gateShell.deleteBranch('no-mistakes-fixer-y')
    assert.throws(() => git(repo, 'rev-parse', '--verify', 'no-mistakes-fixer-y'))

    git(repo, 'worktree', 'remove', '--force', gatePath)
    await gateShell.deleteBranch('no-mistakes-gate-x')
    assert.throws(() => git(repo, 'rev-parse', '--verify', 'no-mistakes-gate-x'))
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

test('parseGateResolution parses actions, finding IDs, guidance, and JSON overrides', () => {
  const findings: Finding[] = [
    { id: 'f-1', severity: 'error', action: 'ask-user', description: 'Issue 1' },
    { id: 'f-2', severity: 'warning', action: 'ask-user', description: 'Issue 2' },
    { id: 'f-3', severity: 'info', action: 'auto-fix', description: 'Issue 3' }
  ]

  assert.deepEqual(parseGateResolution('approve', findings), {
    action: 'approve',
    guidance: '',
    selectedFindings: []
  })
  assert.deepEqual(parseGateResolution('skip', findings), {
    action: 'skip',
    guidance: '',
    selectedFindings: []
  })
  assert.deepEqual(parseGateResolution('stop', findings), {
    action: 'stop',
    guidance: '',
    selectedFindings: []
  })

  // Plain fix without IDs targets all available
  const allFix = parseGateResolution('fix', findings)
  assert.equal(allFix.action, 'fix')
  assert.equal(allFix.guidance, '')
  assert.deepEqual(allFix.selectedFindings, findings)

  // Fix with specific IDs and guidance
  const selectiveFix = parseGateResolution('fix: f-1, f-3: make it robust', findings)
  assert.equal(selectiveFix.action, 'fix')
  assert.equal(selectiveFix.guidance, 'make it robust')
  assert.deepEqual(
    selectiveFix.selectedFindings.map((f) => f.id),
    ['f-1', 'f-3']
  )

  // Fix with single ID in brackets
  const bracketFix = parseGateResolution('fix [f-2] - please fix this specific issue', findings)
  assert.equal(bracketFix.action, 'fix')
  assert.equal(bracketFix.guidance, 'please fix this specific issue')
  assert.deepEqual(
    bracketFix.selectedFindings.map((f) => f.id),
    ['f-2']
  )

  // JSON resolution with per-finding instructions
  const jsonFix = parseGateResolution(
    JSON.stringify({
      action: 'fix',
      findingIds: ['f-2'],
      instructions: { 'f-2': 'add input validation' },
      guidance: 'overall context'
    }),
    findings
  )
  assert.equal(jsonFix.action, 'fix')
  assert.equal(jsonFix.guidance, 'overall context')
  assert.equal(jsonFix.selectedFindings.length, 1)
  assert.equal(jsonFix.selectedFindings[0].id, 'f-2')
  assert.match(jsonFix.selectedFindings[0].description, /add input validation/)

  // Fail-closed test cases
  assert.deepEqual(parseGateResolution('', findings), {
    action: 'unknown',
    guidance: '',
    selectedFindings: []
  })
  assert.deepEqual(parseGateResolution('invalid-decision', findings), {
    action: 'unknown',
    guidance: 'invalid-decision',
    selectedFindings: []
  })
  assert.deepEqual(parseGateResolution(JSON.stringify({ guidance: 'missing action' }), findings), {
    action: 'unknown',
    guidance: '',
    selectedFindings: []
  })
  assert.deepEqual(parseGateResolution(JSON.stringify({ action: 'invalid' }), findings), {
    action: 'unknown',
    guidance: '',
    selectedFindings: []
  })
  assert.deepEqual(
    parseGateResolution(JSON.stringify({ action: 'fix', findingIds: ['nonexistent'] }), findings),
    {
      action: 'fix',
      guidance: '',
      selectedFindings: []
    }
  )
  assert.deepEqual(parseGateResolution('fix [nonexistent] - some text', findings), {
    action: 'fix',
    guidance: 'some text',
    selectedFindings: []
  })
  assert.deepEqual(
    parseGateResolution(JSON.stringify({ action: 'fix', findingIds: 'f-1' }), findings),
    { action: 'fix', guidance: '', selectedFindings: [] }
  )
  assert.deepEqual(parseGateResolution('fix: f-9: some text', findings), {
    action: 'fix',
    guidance: 'f-9: some text',
    selectedFindings: []
  })
  assert.deepEqual(parseGateResolution('fix urgently', findings), {
    action: 'fix',
    guidance: 'urgently',
    selectedFindings: []
  })
  assert.deepEqual(parseGateResolution('fix [] - urgently', findings), {
    action: 'fix',
    guidance: 'urgently',
    selectedFindings: []
  })

  // Free-text guidance with no ID list targets every available finding
  const guidedFix = parseGateResolution('fix please handle the null case first', findings)
  assert.equal(guidedFix.action, 'fix')
  assert.equal(guidedFix.guidance, 'please handle the null case first')
  assert.deepEqual(guidedFix.selectedFindings, findings)
})

test('fails closed when fix gate resolution selects zero valid findings', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  const finding: Finding = {
    id: 'review-1',
    severity: 'error',
    action: 'ask-user',
    description: 'First issue'
  }
  orca.gateResolution = 'fix [nonexistent-id]'
  orca.reports.set('review', [{ findings: [finding], summary: 'found 1 issue' }])

  await assert.rejects(
    runPipeline({ intent: 'Fail closed test' }, orca, git),
    /review fix gate resolved with no matching findings/
  )
})

test('runs selective fix on human gate and sends only chosen findings to fixer', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  const finding1: Finding = {
    id: 'review-1',
    severity: 'error',
    action: 'ask-user',
    description: 'First issue'
  }
  const finding2: Finding = {
    id: 'review-2',
    severity: 'warning',
    action: 'ask-user',
    description: 'Second issue'
  }

  orca.gateResolution = 'fix: review-2: handle edge case'
  orca.reports.set('review', [
    { findings: [finding1, finding2], summary: 'found 2 issues' },
    pass('clean rereview')
  ])

  const result = await runPipeline({ intent: 'Selective fix test' }, orca, git)
  assert.equal(result.steps.length, PIPELINE_STEPS.length)

  // The fixer task should only contain review-2
  const fixerTask = orca.tasks.find((task) => task.spec.startsWith('[review fix 1]'))
  assert.ok(fixerTask)
  assert.match(fixerTask.spec, /review-2/)
  assert.match(fixerTask.spec, /handle edge case/)
  assert.ok(!fixerTask.spec.includes('"id":"review-1"'))
})

test('CliOrca creates gate successfully even if advisory notification fails', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-gate-error-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  try {
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
if (args[1] === 'run-create') {
  console.log(JSON.stringify({ result: { run: { id: 'gate-run' } } }))
} else if (args[1] === 'gate-create') {
  console.log(JSON.stringify({ result: { gate: { id: 'gate-review' } } }))
} else if (args[0] === 'orchestration' && args[1] === 'send') {
  console.error('terminal offline')
  process.exit(1)
} else {
  console.log(JSON.stringify({ result: { ok: true } }))
}
`
    )
    await chmod(fakeOrca, 0o755)
    const orca = new CliOrca({
      command: fakeOrca,
      cwd: temp,
      notifyHandle: 'disconnected-terminal'
    })
    await orca.createRun('gate notification error')
    assert.equal(await orca.createGate('task-review', 'Choose a review action.'), 'gate-review')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('runs sequential fixer rounds from fresh child worktrees before re-review', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  orca.reports.set('review', [
    {
      findings: [
        { id: 'review-a', severity: 'error', action: 'auto-fix', description: 'First defect remains.' }
      ],
      summary: 'first failure'
    },
    pass('first fix committed'),
    {
      findings: [
        { id: 'review-b', severity: 'error', action: 'auto-fix', description: 'Second defect remains.' }
      ],
      summary: 'second failure'
    },
    pass('second fix committed'),
    pass('clean rereview after two rounds')
  ])

  const result = await runPipeline(
    { intent: 'Multiple fixer rounds.', gate: { branch: 'no-mistakes-gate-mr', worktreeId: 'wt-gate-mr' } },
    orca,
    git
  )

  assert.equal(result.steps.length, PIPELINE_STEPS.length)
  const fixerLaunches = orca.launches.filter((launch) => launch.role === 'fixer')
  assert.deepEqual(
    fixerLaunches.map((launch) => launch.name),
    ['no-mistakes-fixer-review-1', 'no-mistakes-fixer-review-2']
  )
  const firstFixTask = orca.tasks.find((task) => task.spec.startsWith('[review fix 1]'))
  const secondFixTask = orca.tasks.find((task) => task.spec.startsWith('[review fix 2]'))
  assert.match(firstFixTask?.spec ?? '', /First defect remains\./)
  assert.ok(!firstFixTask?.spec.includes('Second defect'))
  assert.match(secondFixTask?.spec ?? '', /Second defect remains\./)
  const applyCalls = git.calls.filter((call) => call.startsWith('apply:'))
  assert.equal(applyCalls.length, 2)
  for (const dispatchId of orca.fixerDispatches) {
    assert.ok(applyCalls.some((call) => call.endsWith(`:/wt/${dispatchId}`)))
    assert.ok(orca.calls.includes(`release:${dispatchId}`))
    assert.ok(orca.removedWorktrees.includes(`repo::/${dispatchId}`))
  }
})

test('reviewer prompts name the delivery branch, not the gate branch', async () => {
  const git = new FakeGit()
  git.branch = 'no-mistakes-gate-prompt'
  const orca = new FakeOrca(git)

  await runPipeline(
    {
      intent: 'Everything passes.',
      deliveryBranch: 'feature',
      gate: { branch: 'no-mistakes-gate-prompt', worktreeId: 'wt-gate' }
    },
    orca,
    git
  )

  const reviewers = orca.launches.filter((launch) => launch.role === 'reviewer')
  assert.ok(reviewers.length > 0)
  for (const launch of reviewers) {
    assert.match(launch.prompt, /^Branch: feature$/m)
    assert.ok(!launch.prompt.includes('no-mistakes-gate-prompt'), launch.name)
  }
})

test('a reviewer-only pass launches no fixers and opens no gates', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)

  const result = await runPipeline({ intent: 'Everything passes.' }, orca, git)

  assert.equal(result.steps.length, PIPELINE_STEPS.length)
  assert.equal(orca.launches.filter((launch) => launch.role === 'fixer').length, 0)
  assert.equal(git.calls.filter((call) => call.startsWith('apply:')).length, 0)
  assert.equal(orca.gates.length, 0)
  const workerStages = PIPELINE_STEPS.filter(
    (stage) => stage !== 'intent' && stage !== 'rebase' && stage !== 'push'
  )
  for (const stage of workerStages) {
    assert.equal(orca.launches.filter((launch) => launch.stage === stage).length, 1, stage)
  }
})

test('reviewer worktrees are removed even when releasing the worker fails', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  orca.finishWorker = async (worker) => {
    orca.calls.push(`release-failed:${worker.dispatchId}`)
    throw new Error('terminal release failed')
  }

  const result = await runPipeline(
    {
      intent: 'Everything passes.',
      gate: { branch: 'no-mistakes-gate-release', worktreeId: 'wt-gate' }
    },
    orca,
    git
  )

  assert.equal(result.steps.length, PIPELINE_STEPS.length)
  assert.ok(orca.launches.length > 0)
  assert.equal(orca.removedWorktrees.length, orca.launches.length + 1)
})

test('worker cancellation cleans up the gate worktree and branch', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  orca.failWorkerFor = 'review'

  await assert.rejects(
    runPipeline(
      { intent: 'Cancelled mid-flight.', gate: { branch: 'no-mistakes-gate-cx', worktreeId: 'wt-gate-cx' } },
      orca,
      git
    ),
    /review worker was cancelled/
  )
  assert.ok(orca.removedWorktrees.includes('wt-gate-cx'))
  assert.ok(git.calls.includes('delete-branch:no-mistakes-gate-cx'))
  assert.ok(orca.calls.some((call) => call.includes('status:in-review:no-mistakes stopped:')))
})

test('failed commit application stops the pipeline and cleans up the fixer', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  git.failApplyOnce({
    findings: [
      {
        id: 'fix-apply-failed',
        severity: 'error',
        action: 'ask-user',
        description: 'CONFLICT content conflict in fix.txt'
      }
    ],
    summary: 'cherry-pick failed'
  })
  orca.reports.set('review', [
    {
      findings: [
        { id: 'review-c', severity: 'error', action: 'auto-fix', description: 'Needs a fix.' }
      ],
      summary: 'failure'
    },
    pass('never reached')
  ])

  await assert.rejects(
    runPipeline(
      { intent: 'Apply conflict.', gate: { branch: 'no-mistakes-gate-ca', worktreeId: 'wt-gate-ca' } },
      orca,
      git
    ),
    /review fixer commits could not be applied to the gate branch/
  )
  const [fixerDispatch] = orca.fixerDispatches
  assert.ok(fixerDispatch)
  assert.ok(orca.calls.includes(`release:${fixerDispatch}`))
  assert.ok(orca.removedWorktrees.includes(`repo::/${fixerDispatch}`))
  assert.ok(orca.removedWorktrees.includes('wt-gate-ca'))
  assert.ok(git.calls.includes('delete-branch:no-mistakes-gate-ca'))
})

test('a fixer that rewrites or merges history still lands on the gate branch', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-rebase-harvest-'))
  try {
    const repo = await seedOriginRepo(temp)
    git(repo, 'checkout', '-b', 'feature')
    await writeFile(path.join(repo, 'feature.txt'), 'feature\n')
    git(repo, 'add', 'feature.txt')
    git(repo, 'commit', '-m', 'feature')

    git(repo, 'checkout', 'main')
    await writeFile(path.join(repo, 'upstream.txt'), 'upstream\n')
    git(repo, 'add', 'upstream.txt')
    git(repo, 'commit', '-m', 'upstream')
    git(repo, 'push', 'origin', 'main')
    git(repo, 'checkout', 'feature')

    const gatePath = path.join(temp, 'gate')
    git(repo, 'worktree', 'add', gatePath, '-b', 'no-mistakes-gate-harvest', 'feature')
    const gateShell = new GitShell({ repo: gatePath })
    await gateShell.assertReady()
    const base = git(gatePath, 'rev-parse', 'HEAD')

    const rebaseWorker = path.join(temp, 'worker-rebase')
    git(gatePath, 'worktree', 'add', rebaseWorker, '-b', 'no-mistakes-fixer-rebase', base)
    git(rebaseWorker, 'rebase', 'origin/main')
    const rebasedHead = git(rebaseWorker, 'rev-parse', 'HEAD')
    assert.notEqual(rebasedHead, base)

    const rebaseApplied = await gateShell.applyWorktreeCommits(rebaseWorker, base)
    assert.deepEqual(rebaseApplied.findings, [])
    assert.equal(git(gatePath, 'rev-parse', 'HEAD'), rebasedHead)
    assert.equal(git(gatePath, 'rev-list', '--count', 'origin/main..HEAD'), '1')
    await gateShell.assertClean()

    git(repo, 'checkout', 'main')
    await writeFile(path.join(repo, 'upstream-2.txt'), 'upstream 2\n')
    git(repo, 'add', 'upstream-2.txt')
    git(repo, 'commit', '-m', 'upstream 2')
    git(repo, 'push', 'origin', 'main')
    git(repo, 'checkout', 'feature')

    const mergeBase = git(gatePath, 'rev-parse', 'HEAD')
    const mergeWorker = path.join(temp, 'worker-merge')
    git(gatePath, 'worktree', 'add', mergeWorker, '-b', 'no-mistakes-fixer-ci', mergeBase)
    git(mergeWorker, 'fetch', 'origin', 'main')
    git(mergeWorker, 'merge', '--no-ff', '--no-edit', 'origin/main')
    const mergedHead = git(mergeWorker, 'rev-parse', 'HEAD')
    assert.equal(git(mergeWorker, 'rev-list', '--count', '--merges', `${mergeBase}..HEAD`), '1')

    const mergeApplied = await gateShell.applyWorktreeCommits(mergeWorker, mergeBase)
    assert.deepEqual(mergeApplied.findings, [])
    assert.equal(git(gatePath, 'rev-parse', 'HEAD'), mergedHead)
    await gateShell.assertClean()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('run status is reported on the initiating worktree, not the gate', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-status-target-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const operatorWorktree = path.join(temp, 'operator')
  try {
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
console.log(JSON.stringify({ result: { worktree: { id: 'wt-operator' } } }))
`
    )
    await chmod(fakeOrca, 0o755)
    const orca = new CliOrca({
      command: fakeOrca,
      cwd: temp,
      statusWorktree: operatorWorktree
    })
    await orca.setWorktreeStatus('no-mistakes review (1/9)', 'in-progress')

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const set = calls.find((args) => args[0] === 'worktree' && args[1] === 'set')
    assert.ok(set)
    assert.equal(set[set.indexOf('--worktree') + 1], `path:${operatorWorktree}`)
    assert.ok(set.includes('no-mistakes review (1/9)'))
    assert.ok(set.includes('in-progress'))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
