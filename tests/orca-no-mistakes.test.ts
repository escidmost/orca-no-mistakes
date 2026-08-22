import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CliOrca,
  DomainLedger,
  GitShell,
  PIPELINE_STEPS,
  launchAgent,
  buildAttestation,
  capLog,
  main,
  parseGateResolution,
  runPipeline,
  merkleRoot,
  canonicalEntry,
  sha256,
  verifyManifest,
  type Finding,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult
} from '../scripts/orca-no-mistakes.ts'
import { buildCliCommand } from '../scripts/adapters.ts'
import { effectivePolicyHash } from '../scripts/policy.ts'

const pass = (summary = 'passed'): StageReport => ({ findings: [], summary })

class FakeGit implements GitOperations {
  readonly calls: string[] = []
  readonly baseFiles = new Map<string, string>()
  static #oid(counter: number): string {
    return counter.toString(16).padStart(40, '0')
  }
  #counter = 1
  #head = FakeGit.#oid(1)
  #baseOid = FakeGit.#oid(0)
  divergeAfterAnchor = false
  rebaseConflict = false
  #operatorDiverged = false

  async assertReady(): Promise<{ base: string; baseOid: string; branch: string; head: string; root: string }> {
    this.calls.push('assert-ready')
    return { base: 'main', baseOid: this.#baseOid, branch: 'feature', head: this.#head, root: '/repo' }
  }

  async assertClean(): Promise<void> {
    this.calls.push('assert-clean')
  }

  async head(): Promise<string> {
    return this.#operatorDiverged ? FakeGit.#oid(9_999) : this.#head
  }

  async resolveRefSha(ref: string): Promise<string | undefined> {
    return `sha-${ref.replaceAll('/', '-')}`
  }

  async showFile(ref: string, filePath: string): Promise<string | undefined> {
    return this.baseFiles.get(`${ref}:${filePath}`)
  }

  async pathExists(ref: string, filePath: string): Promise<boolean> {
    return this.baseFiles.has(`${ref}:${filePath}`)
  }

  async rebase(base: string): Promise<StageReport> {
    this.calls.push(`rebase:${base}`)
    this.#baseOid = 'b'.repeat(40)
    if (this.rebaseConflict) {
      // one-shot: the next rebase models the fixer having resolved the conflict
      this.rebaseConflict = false
      return {
        findings: [
          {
            id: 'rebase-conflict',
            severity: 'error',
            action: 'auto-fix',
            description: 'conflict; rebase aborted'
          }
        ],
        summary: 'rebase aborted'
      }
    }
    this.#head = FakeGit.#oid(++this.#counter)
    return pass('rebased')
  }

  async policySha256(): Promise<string> {
    this.calls.push('policy')
    return this.#baseOid === 'b'.repeat(40) ? 'e'.repeat(64) : 'f'.repeat(64)
  }

  async resolveBaseOid(): Promise<string> {
    this.calls.push('resolve-base')
    return this.#baseOid
  }

  async advanceIfUnchanged(fromOid: string, toOid: string): Promise<boolean> {
    this.calls.push(`ff:${fromOid}->${toOid}`)
    if ((this.#operatorDiverged ? FakeGit.#oid(9_999) : this.#head) !== fromOid) return false
    this.#head = toOid
    return true
  }

  async anchorRecoveryRef(runId: string, oid: string): Promise<void> {
    if (this.divergeAfterAnchor) this.#operatorDiverged = true
    this.calls.push(`recover:${runId}:${oid}`)
  }

  advanceHead(): void {
    this.#head = FakeGit.#oid(++this.#counter)
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

test('runs the six-stage local adversarial pipeline with fixes, gates, and isolation', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  const ledger = new DomainLedger(':memory:')
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

  const result = await runPipeline(
    { intent: 'Add the requested command without changing existing behavior.' },
    orca,
    git,
    ledger
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
  assert.equal(fixerLaunches.length, 2)
  assert.equal(fixerLaunches[0].worktree, 'current')
  assert.equal(fixerLaunches[1].terminal, 'term-fixer')
  assert.ok(
    orca.fixerDispatches.every(
      (dispatchId) => orca.calls.includes(`retain:${dispatchId}`) || orca.calls.includes(`release:${dispatchId}`)
    ),
    'every fixer dispatch is retained or eventually released'
  )
  assert.ok(
    orca.calls.includes(`release:${orca.fixerDispatches[orca.fixerDispatches.length - 1]}`),
    'the final retained fixer dispatch is released'
  )
  assert.ok(orca.calls.some((call) => call.startsWith('gate:') && call.includes('docs-1')))
  assert.equal(orca.removedWorktrees.length, orca.launches.filter((launch) => launch.worktree === 'new-child').length)
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[review check 1]'))?.spec ?? '',
    /report exactly once with worker_done/i
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[review check 1]'))?.spec ?? '',
    /Do NOT run tests during review/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[review check 1]'))?.spec ?? '',
    /unexplained relaxation of validation policy is a blocking finding/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[review check 1]'))?.spec ?? '',
    /<untrusted_instruction>/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[review check 1]'))?.spec ?? '',
    /untrusted data/
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
    orca.tasks.find((task) => task.spec.startsWith('[review fix 1]'))?.spec ?? '',
    /Null input crashes the command/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[review fix 1]'))?.spec ?? '',
    /Apply all the fixes you intend to make first/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[review fix 1]'))?.spec ?? '',
    /Do NOT modify existing test assertions/
  )
  assert.match(
    orca.tasks.find((task) => task.spec.startsWith('[lint fix 1]'))?.spec ?? '',
    /Re-run the relevant lint or format commands/
  )

  const checkpoints = ledger.listCheckpoints(result.runId)
  assert.deepEqual(
    checkpoints.map((checkpoint) => [checkpoint.stage_id, checkpoint.round_index]),
    [
      ['intent', 0],
      ['review', 1],
      ['lint', 1]
    ]
  )
  assert.equal(checkpoints[0].input_commit_oid, checkpoints[0].output_commit_oid)
  for (const checkpoint of checkpoints.slice(1)) {
    assert.notEqual(checkpoint.input_commit_oid, checkpoint.output_commit_oid)
  }
  assert.ok(result.attestation)
  verifyManifest(result.attestation)
  assert.equal(result.attestation.stageEvidence.length, 8)
  assert.ok(git.calls.some((call) => call.startsWith('recover:')))
  assert.match(result.custodyNote ?? '', /carries the terminal commit/)
  assert.equal(
    orca.calls.at(-1),
    `status:completed:no-mistakes passed all ${PIPELINE_STEPS.length} stages`
  )
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
  const ledger = new DomainLedger(':memory:')
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
    runPipeline({ intent: 'Reject unknown decisions.' }, orca, git, ledger),
    /document gate could not be resolved from: later/
  )
  assert.ok(orca.calls.some((call) => call.includes('status:in-review:no-mistakes stopped:')))
  const runs = ledger.listRuns()
  assert.equal(runs.length, 1)
  assert.equal(ledger.runStatus(runs[0].run_id), 'failed')
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

test('CLI accepts equals syntax and preserves negative numeric values', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-cli-'))
  try {
    git(temp, 'init', '-b', 'feature')
    await assert.rejects(
      main(['run', `--repo=${temp}`, '--intent=Validate parsing.', '--max-fix-rounds=-1']),
      /maxFixRounds must be a non-negative integer/
    )
    await assert.rejects(main(['install', '--repo=x']), /unknown command: install/)
    await assert.rejects(main(['push', '--intent=x']), /unknown command: push/)
    await assert.rejects(main(['run', '--force', '--intent=x']), /--force is not valid for run/)
    await assert.rejects(main(['run', '--force-lease=true', '--intent=x']), /--force-lease does not take a value/)
    await assert.rejects(main(['attestation']), /attestation requires export or verify/)
    await assert.rejects(main(['attestation', 'export']), /requires a run ID/)
  await assert.rejects(main(['run', '--intent=x', 'stray-arg']), /run does not accept positional arguments/)
  await assert.rejects(main(['prune', 'stray-arg']), /prune does not accept positional arguments/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('run starts an attached coordinator in a dedicated Orca terminal', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-detached-run-'))
  const origin = path.join(temp, 'origin.git')
  const repo = path.join(temp, 'repo')
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
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const result = args[0] === 'terminal' && args[1] === 'create'
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

    await main([
      'run',
      `--repo=${repo}`,
      '--intent=Validate detached coordination.',
      '--allow-local-config'
    ])

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const terminalCreate = calls.find((args) => args[0] === 'terminal' && args[1] === 'create')
    const terminalSend = calls.find((args) => args[0] === 'terminal' && args[1] === 'send')
    const commandText = terminalSend?.[terminalSend.indexOf('--text') + 1] ?? ''
    const worktree = terminalCreate?.[terminalCreate.indexOf('--worktree') + 1]?.replace(/^path:/, '')
    assert.equal(worktree ? await realpath(worktree) : '', await realpath(repo))
    assert.ok(commandText.includes("'--attached'"))
    assert.ok(commandText.includes("'--notify' 'originating-opencode'"))
    assert.ok(commandText.includes("'--intent' 'Validate detached coordination.'"))
    assert.ok(commandText.includes("'--allow-local-config'"))
    assert.ok(!calls.some((args) => args[0] === 'orchestration'))
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND
    else process.env.ORCA_CLI_COMMAND = previousCommand
    if (previousHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE
    else process.env.ORCA_TERMINAL_HANDLE = previousHandle
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

test('CliOrca creates a fixer once and reuses its terminal without creation flags', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-cli-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const countPath = path.join(temp, 'count')
  const startCountPath = path.join(temp, 'start-count')
  const evidence = path.join(homedir(), '.orca-no-mistakes', 'artifacts', 'adapter-test')
  const reportOne = path.join(evidence, 'one.json')
  const reportTwo = path.join(evidence, 'two.json')
  const reportThree = path.join(evidence, 'three.json')
  try {
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
if (args[0] === 'orchestration' && args[1] === 'run-create') {
  out({ run: { id: 'adapter-test' } })
} else if (args[0] === 'terminal' && args[1] === 'create') {
  out({ terminal: { handle: 'created-fixer' } })
} else if (args[0] === 'terminal' && args[1] === 'send') {
  out({ accepted: true })
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, title: 'OpenCode', preview: 'ready' } })
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  const count = fs.existsSync(${JSON.stringify(startCountPath)}) ? Number(fs.readFileSync(${JSON.stringify(startCountPath)}, 'utf8')) : 0
  fs.writeFileSync(${JSON.stringify(startCountPath)}, String(count + 1))
  out({ dispatch: { id: 'dispatch-' + (count + 1), status: 'dispatched' }, injected: true, preamble: 'authenticated' })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  const count = fs.existsSync(${JSON.stringify(countPath)}) ? Number(fs.readFileSync(${JSON.stringify(countPath)}, 'utf8')) : 0
  fs.writeFileSync(${JSON.stringify(countPath)}, String(count + 1))
  const dispatchId = 'dispatch-' + (count + 1)
  const taskId = 'task-' + (count + 1)
  const reportPath = count === 0 ? ${JSON.stringify(reportOne)} : count === 1 ? ${JSON.stringify(reportTwo)} : ${JSON.stringify(reportThree)}
  out({ deliveryId: 'delivery-' + count, messages: [{ type: 'worker_done', body: 'Fixed the issue. Verified the change. Nothing remains.', payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded', reportPath }) }] })
} else {
  out({ ok: true })
}
`
    )
    await chmod(fakeOrca, 0o755)
    const orca = new CliOrca({
      command: fakeOrca,
      cwd: temp
    })
    await orca.createRun('adapter test')

    const first = await orca.startWorker('task-1', {
      agent: { harness: 'opencode', model: 'gpt-5.6', variant: 'high' },
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
    await orca.finishWorker(second, 'retain')
    const third = await orca.startWorker('task-3', {
      name: 'third-fixer',
      prompt: 'third',
      role: 'fixer',
      stage: 'test',
      terminal: second.terminalHandle,
      worktree: 'current'
    })
    await orca.finishWorker(third, 'release')

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const starts = calls.filter((args) => args[1] === 'dispatch')
    assert.equal(starts.length, 3)
    assert.equal(first.terminalHandle, 'created-fixer')
    assert.equal(second.terminalHandle, 'created-fixer')
    assert.equal(third.terminalHandle, 'created-fixer')
    const closes = calls.filter((args) => args[0] === 'terminal' && args[1] === 'close')
    assert.equal(closes.length, 1)
    assert.ok(closes[0].includes('created-fixer'))
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
  const evidence = path.join(homedir(), '.orca-no-mistakes', 'artifacts', 'adapter-new-child')
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

test('GitShell rebases a clean feature branch, hashes trusted policy, and returns custody', async () => {
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
    assert.match(state.baseOid, /^[0-9a-f]{40}$/)
    assert.deepEqual((await shell.rebase(state.base)).findings, [])

    const policyBefore = await shell.policySha256(state.base)
    assert.match(policyBefore, /^[0-9a-f]{64}$/)
    const head = await shell.head()

    assert.equal(await shell.advanceIfUnchanged('deadbeef'.repeat(5).slice(0, 40), head), false)
    assert.equal(await shell.advanceIfUnchanged(head, head), true)
    await shell.anchorRecoveryRef('run-custody', head)
    assert.equal(git(repo, 'rev-parse', 'refs/no-mistakes/recover/run-custody'), head)
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

test('runPipeline extracts the trusted base policy and binds it into run evidence', async () => {
  const git = new FakeGit()
  git.baseFiles.set(
    'origin/main:.orca/no-mistakes.yaml',
    'stages:\n  review:\n    reviewer:\n      agent: claude\n      model: claude-opus-4\n      timeout_ms: 45000\n'
  )
  const orca = new FakeOrca(git)

  const result = await runPipeline({ intent: 'Route reviewers through native dispatch.' }, orca, git)

  assert.equal(result.policy.localBypass, false)
  assert.equal(result.policy.baseRef, 'origin/main')
  assert.equal(result.policy.baseRefSha, 'sha-origin-main')

  const reviewReviewer = orca.launches.find((launch) => launch.stage === 'review' && launch.role === 'reviewer')
  assert.equal(reviewReviewer?.agent?.harness, 'claude')
  assert.equal(reviewReviewer?.agent?.model, 'claude-opus-4')
  assert.equal(reviewReviewer?.agent?.timeoutMs, 45000)
  // Stages without configuration keep the default CLI harness.
  const lintReviewer = orca.launches.find((launch) => launch.stage === 'lint' && launch.role === 'reviewer')
  assert.equal(lintReviewer?.agent, undefined)

  const manifestPath = path.join(homedir(), '.orca-no-mistakes', 'artifacts', result.runId, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.base_ref, 'origin/main')
  assert.equal(manifest.base_ref_sha, 'sha-origin-main')
  assert.equal(manifest.local_bypass, false)
  assert.deepEqual(manifest.effective_config, {
    stages: { review: { reviewer: { agent: 'claude', model: 'claude-opus-4', timeout_ms: 45000 } } }
  })
  assert.equal(manifest.effective_policy_hash, effectivePolicyHash(manifest.effective_config))
  await rm(path.join(homedir(), '.orca-no-mistakes', 'artifacts', result.runId), { recursive: true, force: true })
})

test('local config bypass taints the run as uncertified', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'policy-bypass-run-'))
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  try {
    const configFile = path.join(temp, 'local.yaml')
    await writeFile(configFile, 'stages:\n  test:\n    reviewer:\n      agent: grok\n')

    const result = await runPipeline(
      { allowLocalConfig: true, configPath: configFile, intent: 'Iterate locally.' },
      orca,
      git
    )

    assert.equal(result.policy.localBypass, true)
    assert.equal(result.policy.baseRefSha, undefined)
    const testReviewer = orca.launches.find((launch) => launch.stage === 'test' && launch.role === 'reviewer')
    assert.equal(testReviewer?.agent?.harness, 'grok')
    assert.ok(orca.calls.some((call) => call.startsWith('status:') && call.includes('[uncertified')))
    assert.ok(orca.calls.some((call) => call.includes('status:completed:') && call.includes('[uncertified')))

    const manifestPath = path.join(homedir(), '.orca-no-mistakes', 'artifacts', result.runId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(manifest.local_bypass, true)
    assert.equal('base_ref_sha' in manifest, false)
    await rm(path.join(homedir(), '.orca-no-mistakes', 'artifacts', result.runId), { recursive: true, force: true })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('CliOrca starts native workers through orchestration worker-start', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-native-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const evidence = path.join(homedir(), '.orca-no-mistakes', 'artifacts', 'native-run')
  const reportPath = path.join(evidence, 'review.json')
  try {
    git(temp, 'init', '-b', 'feature')
    await mkdir(evidence, { recursive: true })
    await writeFile(reportPath, JSON.stringify(pass('native reviewed')))
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'orchestration' && args[1] === 'run-create') {
  out({ run: { id: 'native-run' } })
} else if (args[0] === 'orchestration' && args[1] === 'worker-start') {
  out({ terminal: { handle: 'native-worker' }, worktree: { id: 'wt-native' } })
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  out({ dispatch: { id: 'dispatch-nat', status: 'dispatched' }, injected: true, preamble: 'authenticated' })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  out({ deliveryId: 'delivery-nat', messages: [{ type: 'worker_done', body: 'Reviewed. Verified. Clear.', payload: JSON.stringify({ taskId: 'task-nat', dispatchId: 'dispatch-nat', outcome: 'succeeded', reportPath: ${JSON.stringify(reportPath)} }) }] })
} else {
  out({ ok: true })
}
`
    )
    await chmod(fakeOrca, 0o755)
    const orca = new CliOrca({ command: fakeOrca, cwd: temp })
    await orca.createRun('native test')

    const worker = await orca.startWorker('task-nat', {
      agent: { effort: 'high', harness: 'claude', model: 'claude-opus-4' },
      name: 'nm-review',
      prompt: 'review instructions',
      role: 'reviewer',
      stage: 'review',
      worktree: 'new-child'
    })

    assert.equal(worker.terminalHandle, 'native-worker')
    assert.equal(worker.worktreeId, 'wt-native')
    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const workerStart = calls.find((args) => args[1] === 'worker-start')
    assert.ok(workerStart?.includes('--agent'))
    assert.ok(workerStart?.includes('claude'))
    assert.ok(workerStart?.includes('--model'))
    assert.ok(workerStart?.includes('claude-opus-4'))
    assert.ok(workerStart?.includes('--effort'))
    assert.ok(workerStart?.includes('--worktree'))
    assert.ok(workerStart?.includes('new-child'))
    assert.ok(workerStart?.includes('--name'))
    assert.ok(workerStart?.includes('nm-review'))
    assert.ok(workerStart?.includes('--base-branch'))
    assert.ok(workerStart?.includes('feature'))
    assert.ok(workerStart?.includes('--run'))
    const dispatch = calls.find((args) => args[1] === 'dispatch')
    assert.ok(dispatch?.includes('native-worker'))
    assert.equal(reportPath && worker.report.summary, 'native reviewed')

    await orca.finishWorker(worker, 'release')
    const postReleaseCalls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    assert.ok(
      postReleaseCalls.some(
        (args) => args[0] === 'terminal' && args[1] === 'close' && args.includes('native-worker')
      ),
      'release closes the native worker terminal'
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
    await rm(evidence, { recursive: true, force: true })
  }
})

test('CliOrca reclaims residualResources reported by a failed native worker-start', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-native-residual-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  try {
    git(temp, 'init', '-b', 'feature')
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'orchestration' && args[1] === 'worker-start') {
  out({
    status: 'failed',
    failedStage: 'agent-ready',
    residualResources: [
      { kind: 'worktree', id: 'wt-residual' },
      { kind: 'terminal', handle: 'term-residual' }
    ]
  })
  process.exit(1)
} else {
  out({ ok: true })
}
`
    )
    await chmod(fakeOrca, 0o755)
    const orca = new CliOrca({ command: fakeOrca, cwd: temp })

    await assert.rejects(
      orca.startWorker('task-residual', {
        agent: { harness: 'claude' },
        name: 'nm-review',
        prompt: 'review instructions',
        role: 'reviewer',
        stage: 'review',
        worktree: 'current'
      }),
      /worker-start failed/
    )
    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    assert.ok(
      calls.some(
        (args) => args[0] === 'terminal' && args[1] === 'close' && args.includes('term-residual')
      ),
      'the residual terminal is closed'
    )
    assert.ok(
      calls.some(
        (args) => args[0] === 'worktree' && args[1] === 'rm' && args.includes('id:wt-residual')
      ),
      'the residual worktree is removed'
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('CliOrca rejects a native worker-start that exits non-zero', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-native-fail-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  try {
    git(temp, 'init', '-b', 'feature')
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'orchestration' && args[1] === 'run-create') {
  out({ run: { id: 'native-fail-run' } })
} else if (args[0] === 'orchestration' && args[1] === 'worker-start') {
  out({ status: 'outcome_unknown', failedStage: 'agent-ready', terminal: { handle: 'half-started' }, worktree: { id: 'wt-orphan' }, recovery: ['orca terminal close --terminal half-started'] })
  process.exit(1)
} else {
  out({ ok: true })
}
`
    )
    await chmod(fakeOrca, 0o755)
    const orca = new CliOrca({ command: fakeOrca, cwd: temp })
    await orca.createRun('native failure test')

    await assert.rejects(
      orca.startWorker('task-fail', {
        agent: { harness: 'claude', model: 'claude-opus-4' },
        name: 'nm-review',
        prompt: 'review instructions',
        role: 'reviewer',
        stage: 'review',
        worktree: 'current'
      }),
      /outcome_unknown/
    )
    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    assert.equal(
      calls.find((args) => args[1] === 'dispatch'),
      undefined,
      'a failed worker-start must not be dispatched into'
    )
    assert.ok(
      calls.some(
        (args) => args[0] === 'terminal' && args[1] === 'close' && args.includes('half-started')
      ),
      'the half-started terminal is closed'
    )
    assert.ok(
      calls.some((args) => args[0] === 'worktree' && args[1] === 'rm' && args.includes('id:wt-orphan')),
      'the orphaned worktree is removed'
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('CliOrca runs acp targets through the acpx runner', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-acp-'))
  const fakeAcpx = path.join(temp, 'acpx')
  const failingAcpx = path.join(temp, 'acpx-fail')
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'acp-calls.jsonl')
  const orcaCallsPath = path.join(temp, 'orca-calls.jsonl')
  const worktreePath = path.join(temp, 'acp-wt')
  try {
    git(temp, 'init', '-b', 'feature')
    await mkdir(worktreePath)
    await writeFile(
      fakeAcpx,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
if (args.at(-2) !== 'exec') {
  console.error('No acpx session found (searched up to /). Create one: acpx <agent> sessions new')
  process.exit(1)
}
// --format quiet emits the agent's final assistant message on stdout.
console.log(JSON.stringify({ findings: [], summary: 'acp done' }))
`
    )
    await chmod(fakeAcpx, 0o755)
    await writeFile(failingAcpx, '#!/usr/bin/env node\nconsole.error("target offline")\nprocess.exit(3)\n')
    await chmod(failingAcpx, 0o755)
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(orcaCallsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'worktree' && args[1] === 'create') {
  out({ worktree: { id: 'wt-acp', path: ${JSON.stringify(worktreePath)} } })
} else {
  out({ ok: true })
}
`
    )
    await chmod(fakeOrca, 0o755)

    const orca = new CliOrca({ acpxCommand: fakeAcpx, command: fakeOrca, cwd: temp })
    const worker = await orca.startWorker('task-acp', {
      agent: { harness: 'acp:gemini-dev', model: 'glm-5' },
      name: 'acp-worker',
      prompt: 'Review now.',
      role: 'reviewer',
      stage: 'review',
      worktree: 'new-child'
    })
    assert.equal(worker.report.summary, 'acp done')
    assert.match(worker.dispatchId, /^acp-/)
    assert.equal(worker.terminalHandle, undefined)
    assert.equal(worker.worktreeId, 'wt-acp')
    await orca.finishWorker(worker, 'release')

    const invocation = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])[0]
    assert.equal(invocation.at(-3), 'gemini-dev')
    assert.equal(invocation.at(-2), 'exec')
    assert.equal(invocation.at(-1), 'Review now.')
    assert.deepEqual(invocation.slice(0, -3), [
      '--format',
      'quiet',
      '--approve-all',
      '--model',
      'glm-5'
    ])
    const orcaCalls = (await readFile(orcaCallsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    assert.ok(orcaCalls.some((args) => args[0] === 'worktree' && args[1] === 'create'))

    const failing = new CliOrca({ acpxCommand: failingAcpx, command: fakeOrca, cwd: temp })
    await assert.rejects(
      failing.startWorker('task-acp', {
        agent: { harness: 'acp:gemini-dev' },
        name: 'acp-worker',
        prompt: 'Review now.',
        role: 'reviewer',
        stage: 'review',
        worktree: 'new-child'
      }),
      /acp target gemini-dev failed \(exit 3\)/
    )
    const failingCalls = (await readFile(orcaCallsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    assert.ok(
      failingCalls.some(
        (args) => args[0] === 'worktree' && args[1] === 'rm' && args.includes('id:wt-acp') && args.includes('--force')
      ),
      'a failed ACP run removes its child worktree'
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('CliOrca formats CLI harness startup lines with per-harness readiness', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-grok-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const evidence = path.join(homedir(), '.orca-no-mistakes', 'artifacts', 'grok-run')
  const reportPath = path.join(evidence, 'review.json')
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(reportPath, JSON.stringify(pass('grok reviewed')))
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'orchestration' && args[1] === 'run-create') {
  out({ run: { id: 'grok-run' } })
} else if (args[0] === 'terminal' && args[1] === 'create') {
  out({ terminal: { handle: 'grok-terminal' } })
} else if (args[0] === 'terminal' && args[1] === 'send') {
  out({ accepted: true })
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, title: 'Grok CLI', preview: 'ready' } })
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  out({ dispatch: { id: 'dispatch-grok', status: 'dispatched' }, injected: true, preamble: 'authenticated' })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  out({ deliveryId: 'delivery-grok', messages: [{ type: 'worker_done', body: 'Reviewed. Verified. Clear.', payload: JSON.stringify({ taskId: 'task-grok', dispatchId: 'dispatch-grok', outcome: 'succeeded', reportPath: ${JSON.stringify(reportPath)} }) }] })
} else {
  out({ ok: true })
}
`
    )
    await chmod(fakeOrca, 0o755)
    const orca = new CliOrca({ command: fakeOrca, cwd: temp })
    await orca.createRun('grok test')

    const worker = await orca.startWorker('task-grok', {
      agent: { harness: 'grok', model: 'grok-4' },
      name: 'grok-reviewer',
      prompt: 'instructions',
      role: 'reviewer',
      stage: 'review',
      worktree: 'current'
    })

    assert.equal(worker.terminalHandle, 'grok-terminal')
    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const send = calls.find((args) => args[0] === 'terminal' && args[1] === 'send')
    assert.equal(send?.[send.indexOf('--text') + 1], `'grok' '--model' 'grok-4'`)
  } finally {
    await rm(temp, { recursive: true, force: true })
    await rm(evidence, { recursive: true, force: true })
  }
})

test('WORKER_AGENT_READY_TIMEOUT_MS tears down an unready CLI agent terminal', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'orca-ready-timeout-'))
  const fakeOrca = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const previousTimeout = process.env.WORKER_AGENT_READY_TIMEOUT_MS
  process.env.WORKER_AGENT_READY_TIMEOUT_MS = '100'
  try {
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'terminal' && args[1] === 'create') {
  out({ terminal: { handle: 'stuck-terminal' } })
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, title: 'bash', preview: '' } })
} else {
  out({ ok: true })
}
`
    )
    await chmod(fakeOrca, 0o755)
    const orca = new CliOrca({ command: fakeOrca, cwd: temp })
    await assert.rejects(
      orca.startWorker('task-timeout', {
        name: 'slow-agent',
        prompt: 'instructions',
        role: 'reviewer',
        stage: 'lint',
        worktree: 'current'
      }),
      /opencode did not become ready before the timeout/
    )
    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
    assert.ok(calls.some((args) => args[0] === 'terminal' && args[1] === 'close' && args.includes('stuck-terminal')))
  } finally {
    if (previousTimeout === undefined) delete process.env.WORKER_AGENT_READY_TIMEOUT_MS
    else process.env.WORKER_AGENT_READY_TIMEOUT_MS = previousTimeout
    await rm(temp, { recursive: true, force: true })
  }
})

test('launchAgent carries role settings even when no agent harness is configured', () => {
  const autoFix = { enabled: true, max_rounds: 3, allow_review_autofix: false }
  assert.equal(launchAgent({ auto_fix: autoFix }), undefined)
  assert.deepEqual(launchAgent({ auto_fix: autoFix, model: 'gpt-5.6', effort: 'high' }), {
    agentArgsOverride: undefined,
    effort: 'high',
    harness: 'opencode',
    model: 'gpt-5.6',
    timeoutMs: undefined,
    variant: undefined
  })
  assert.equal(launchAgent({ auto_fix: autoFix, agent: 'claude', model: 'x' })?.harness, 'claude')
  assert.equal(
    buildCliCommand('opencode', launchAgent({ auto_fix: autoFix, model: 'gpt-5.6', effort: 'high' }) ?? {}),
    `'opencode' '--model' 'gpt-5.6' '--variant' 'high'`
  )
  assert.throws(
    () => launchAgent({ auto_fix: autoFix, agent: ['opencode', 'grok'] as never }),
    /agent fallback chains arrive in ONM-39/
  )
})

test('acp reviewers receive a prompt that replaces the worker_done delivery contract', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)

  await runPipeline(
    { intent: 'Adapt delivery for acp targets.', cliFlags: { reviewer: { agent: 'acp:gemini-dev' } } as never },
    orca,
    git
  )

  const acpLaunch = orca.launches.find((launch) => launch.role === 'reviewer')
  assert.equal(acpLaunch?.agent?.harness, 'acp:gemini-dev')
  assert.match(acpLaunch?.prompt ?? '', /Reply with exactly one JSON object as your final message/)
  assert.ok(!(acpLaunch?.prompt ?? '').includes('--report-path'))
  assert.match(acpLaunch?.prompt ?? '', /do not call worker_done/)

})

test('a held branch semantic lease fails closed and --force-lease reclaims it', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  const ledger = new DomainLedger(':memory:')
  ledger.startRun({
    baseBranch: 'main',
    branch: 'feature',
    intent: 'holder run',
    policySha256: 'f'.repeat(64),
    repoRoot: '/repo',
    runId: 'run-holder',
    submissionCommitOid: 'head-1'
  })
  ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId: 'run-holder' })

  await assert.rejects(
    runPipeline({ intent: 'Second concurrent attempt.' }, orca, git, ledger),
    /branch feature is already leased by run run-holder/
  )
  assert.equal(ledger.leaseFor('/repo', 'feature')?.run_id, 'run-holder')
  const loser = ledger.listRuns().find((run) => run.intent === 'Second concurrent attempt.')
  assert.ok(loser)
  assert.equal(ledger.runStatus(loser.run_id), 'failed')

  await runPipeline(
    { forceLease: true, intent: 'Forceful reclaim.' },
    new FakeOrca(git),
    git,
    ledger
  )
  assert.equal(ledger.leaseFor('/repo', 'feature'), undefined)
})

test('rejects multi-line intent before any side effects', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  await assert.rejects(
    runPipeline({ intent: 'line one\nline two' }, orca, git),
    /--intent must be a single line/
  )
  assert.equal(orca.tasks.length, 0)
})

test('gate approvals are audited and bound into the attestation as a waiver', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  orca.reports.set('review', [
    {
      findings: [
        { id: 'docs-1', severity: 'warning', action: 'ask-user', description: 'Needs a product decision' }
      ],
      summary: 'decision needed'
    }
  ])
  orca.gateResolution = 'approve'
  const ledger = new DomainLedger(':memory:')

  const result = await runPipeline({ intent: 'Ship the approved change.' }, orca, git, ledger)

  const audits = ledger.listGateAudit(result.runId)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].decision, 'approve')
  const waived = result.attestation?.stageEvidence.find((entry) => entry.waiverOrApproval)
  assert.equal(waived?.waiverOrApproval?.decision, 'approve')
  assert.equal(waived?.waiverOrApproval?.gateId, audits[0].gate_id)
  assert.equal(ledger.runStatus(result.runId), 'passed')

  verifyManifest(ledger.getAttestation(result.runId))
  assert.throws(() => ledger.getAttestation('no-such-ref'), /no passed attestation/)
})

test('attestation verification detects tampering', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  const result = await runPipeline({ intent: 'Produce an attestation.' }, orca, git)

  assert.ok(result.attestation)
  const tamperedEntry = structuredClone(result.attestation)
  tamperedEntry.stageEvidence[2].summary = 'tampered summary'
  assert.throws(() => verifyManifest(tamperedEntry), /(mismatch|does not match)/i)

  const tamperedIntent = structuredClone(result.attestation)
  tamperedIntent.intent = 'Rewritten after the fact'
  assert.throws(() => verifyManifest(tamperedIntent), /(intent hash|mismatch|does not match)/)

  const tamperedRoot = structuredClone(result.attestation)
  tamperedRoot.merkleRoot = '0'.repeat(64)
  assert.throws(() => verifyManifest(tamperedRoot), /(mismatch|does not match)/i)
})

test('stop resolution cancels the run and records the audit decision', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  const autoFix: Finding = {
    id: 'persistent',
    severity: 'error',
    action: 'auto-fix',
    description: 'still failing'
  }
  orca.reports.set('review', [
    { findings: [autoFix], summary: 'one defect' },
    pass('fix committed'),
    { findings: [{ ...autoFix }], summary: 'still failing' }
  ])
  orca.gateResolution = 'stop'
  const ledger = new DomainLedger(':memory:')

  await assert.rejects(
    runPipeline({ maxFixRounds: 1, intent: 'Stop early.' }, orca, git, ledger),
    /review gate stopped the pipeline: stop/
  )

  const runs = ledger.listRuns()
  assert.equal(runs.length, 1)
  const cancelledRunId = runs[0].run_id
  assert.equal(ledger.runStatus(cancelledRunId), 'cancelled')
  assert.deepEqual(
    ledger.listGateAudit(cancelledRunId).map((audit) => audit.decision),
    ['stop']
  )
  assert.equal(ledger.leaseFor('/repo', 'feature'), undefined)
})

test('custody return preserves diverged operator checkouts behind a recovery ref', async () => {
  const git = new FakeGit()
  git.divergeAfterAnchor = true
  const orca = new FakeOrca(git)
  const ledger = new DomainLedger(':memory:')

  const result = await runPipeline({ intent: 'Diverged operator checkout.' }, orca, git, ledger)

  assert.match(result.custodyNote ?? '', /diverged.*refs\/no-mistakes\/recover\//)
  assert.ok(!git.calls.some((call) => call.startsWith('ff:')))
  assert.ok(git.calls.some((call) => call.startsWith('recover:')))
  assert.equal(ledger.runStatus(result.runId), 'passed')
})

test('capLog preserves head and tail of oversized logs', () => {
  assert.equal(capLog('tiny log'), 'tiny log')
  const big = `${'a'.repeat(30_000_000)}MIDDLE${'b'.repeat(30_000_000)}`
  const capped = capLog(big)
  assert.ok(Buffer.byteLength(capped) <= 50 * 1024 * 1024 + 128)
  assert.match(capped, /\[no-mistakes: log truncated/)
  assert.ok(capped.startsWith('aaaa'))
  assert.ok(capped.endsWith('bbbb'))
  assert.ok(!capped.includes('MIDDLE'))
})

test('prune removes completed runs with their evidence while retaining in-progress runs', async () => {
  const ledger = new DomainLedger(':memory:')
  ledger.startRun({
    baseBranch: 'main',
    branch: 'feature',
    intent: 'old run',
    policySha256: 'f'.repeat(64),
    repoRoot: '/repo/old',
    runId: 'run-old',
    submissionCommitOid: 'a'.repeat(40)
  })
  ledger.recordCheckpoint({
    inputCommitOid: 'a'.repeat(40),
    outputCommitOid: 'b'.repeat(40),
    roundIndex: 1,
    runId: 'run-old',
    stageId: 'review'
  })
  ledger.finishRun('run-old', 'passed', 'b'.repeat(40))

  ledger.startRun({
    baseBranch: 'main',
    branch: 'feature',
    intent: 'live run',
    policySha256: 'f'.repeat(64),
    repoRoot: '/repo/live',
    runId: 'run-live',
    submissionCommitOid: 'c'.repeat(40)
  })

  const pruned = ledger.prune({ repoSubstring: 'old' })
  assert.deepEqual(pruned, ['run-old'])
  assert.deepEqual(ledger.listCheckpoints('run-old'), [])
  assert.equal(ledger.runStatus('run-live'), 'in-progress')

  const future = ledger.prune({ before: new Date(Date.now() + 60_000) })
  assert.deepEqual(future, [])

  assert.deepEqual(ledger.prune({ repoSubstring: 'live' }), [])
  assert.deepEqual(ledger.prune({}), [])
  assert.equal(ledger.runStatus('run-live'), 'in-progress')
})

test('re-attesting an unchanged commit replaces the stored manifest instead of failing', async () => {
  const ledger = new DomainLedger(':memory:')
  const candidate = 'b'.repeat(40)
  for (const runId of ['run-first', 'run-second']) {
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: `pass ${runId}`,
      policySha256: 'f'.repeat(64),
      repoRoot: '/repo/rerun',
      runId,
      submissionCommitOid: candidate
    })
    ledger.recordAttestation(
      buildAttestation([], {
        baseCommitOid: 'a'.repeat(40),
        candidateCommitOid: candidate,
        intent: `pass ${runId}`,
        policySha256: 'f'.repeat(64),
        runId
      })
    )
  }

  const stored = ledger.getAttestation(candidate)
  assert.equal(stored.runId, 'run-second')
  verifyManifest(stored)
  assert.equal(ledger.getAttestation('run-second').runId, 'run-second')
})

test('CLI exports, verifies, and prunes attestations through the domain ledger', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-cli-attest-'))
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  process.env.ORCA_NO_MISTAKES_HOME = temp
  try {
    const git = new FakeGit()
    const orca = new FakeOrca(git)
    const ledger = new DomainLedger()
    const result = await runPipeline({ intent: 'Attest through the CLI.' }, orca, git, ledger)
    ledger.close()

    const manifestPath = path.join(temp, 'manifest.json')
    await main(['attestation', 'export', result.runId, `--out=${manifestPath}`])
    const exported = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(exported.merkleRoot, result.attestation?.merkleRoot)

    await main(['attestation', 'verify', manifestPath])
    await main(['attestation', 'verify', result.attestation!.candidateCommitOid])

    await assert.rejects(
      main(['attestation', 'verify', manifestPath.replace('manifest', 'missing')]),
      /(ENOENT|no passed attestation)/
    )

    await main(['prune', '--before=2999-01-01'])
    const reopened = new DomainLedger()
    assert.throws(() => reopened.getAttestation(result.runId), /no passed attestation/)
    reopened.close()
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome
    await rm(temp, { recursive: true, force: true })
  }
})

test('the attestation binds the base commit fetched by the rebase stage', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  const result = await runPipeline({ intent: 'Bind the fetched base.' }, orca, git)

  assert.ok(result.attestation)
  assert.equal(result.attestation.baseCommitOid, 'b'.repeat(40))
  const byStage = (stage: string) =>
    result.attestation!.stageEvidence.filter((entry) => entry.stage === stage)
  assert.deepEqual(
    byStage('intent').map((entry) => entry.baseCommitOid),
    ['0'.repeat(40)]
  )
  for (const stage of ['rebase', 'review', 'test', 'document', 'lint']) {
    for (const entry of byStage(stage)) {
      assert.equal(entry.baseCommitOid, 'b'.repeat(40))
    }
  }
  verifyManifest(result.attestation)
})

test('the attestation keeps the policy digest captured at run start', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  const result = await runPipeline({ intent: 'Pin the policy digest.' }, orca, git)

  assert.ok(result.attestation)
  assert.equal(result.attestation.policySha256, 'f'.repeat(64))
  assert.equal(git.calls.filter((call) => call === 'policy').length, 1)
  verifyManifest(result.attestation)
})

test('a rebase conflict fixes forward and rebases evidence onto the resolved base', async () => {
  const git = new FakeGit()
  git.rebaseConflict = true
  const orca = new FakeOrca(git)
  orca.gateResolution = 'approve'

  const result = await runPipeline({ intent: 'Fix past a rebase conflict.' }, orca, git)

  assert.ok(result.attestation)
  assert.ok(
    orca.launches.some((launch) => launch.role === 'fixer' && launch.stage === 'rebase'),
    'expected a rebase fixer to run'
  )
  const failedAttempt = result.attestation.stageEvidence.find((entry) => entry.summary === 'rebase aborted')
  assert.ok(failedAttempt, 'expected the conflicted attempt in evidence')
  assert.equal(failedAttempt.baseCommitOid, '0'.repeat(40))
  const rebased = result.attestation.stageEvidence.filter(
    (entry) => entry.stage !== 'intent' && entry.summary !== 'rebase aborted'
  )
  assert.ok(rebased.length > 0)
  for (const entry of rebased) {
    assert.equal(entry.baseCommitOid, 'b'.repeat(40))
  }
  assert.equal(result.attestation.baseCommitOid, 'b'.repeat(40))
  verifyManifest(result.attestation)
})

test('verifyManifest recomputes each stage evidence hash', async () => {
  const git = new FakeGit()
  const orca = new FakeOrca(git)
  const result = await runPipeline({ intent: 'Recompute evidence hashes.' }, orca, git)

  assert.ok(result.attestation)
  const forged = structuredClone(result.attestation)
  forged.stageEvidence[3].summary = 'rewritten after the fact'
  forged.merkleRoot = merkleRoot(
    forged.stageEvidence.map((entry) => sha256(canonicalEntry(entry)))
  )
  assert.throws(() => verifyManifest(forged), /evidence hash does not match/)
})

test('forced lease takeovers are fenced by generation tokens', () => {
  const ledger = new DomainLedger(':memory:')
  try {
    for (const runId of ['run-a', 'run-b', 'run-c']) {
      ledger.startRun({
        baseBranch: 'main',
        branch: 'feature',
        intent: `Intent ${runId}`,
        policySha256: 'f'.repeat(64),
        repoRoot: '/repo',
        runId,
        submissionCommitOid: 'a'.repeat(40)
      })
    }
    const tokenA = ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId: 'run-a' })
    assert.equal(tokenA, 1)
    const tokenB = ledger.acquireLease({ branch: 'feature', force: true, repoRoot: '/repo', runId: 'run-b' })
    assert.equal(tokenB, 2)
    assert.throws(() => ledger.heartbeatLease('/repo', 'feature', 'run-a'), /lost or reclaimed/)
    const tokenC = ledger.acquireLease({ branch: 'feature', force: true, repoRoot: '/repo', runId: 'run-c' })
    assert.equal(tokenC, 3)
    assert.throws(() => ledger.heartbeatLease('/repo', 'feature', 'run-b'), /lost or reclaimed/)
  } finally {
    ledger.close()
  }
})

test('concurrent coordinators on separate connections fail closed against one lease', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-ledger-race-'))
  const dbPath = path.join(temp, 'ledger.db')
  const first = new DomainLedger(dbPath)
  const second = new DomainLedger(dbPath)
  try {
    for (const ledger of [first, second]) {
      ledger.startRun({
        baseBranch: 'main',
        branch: 'feature',
        intent: `Intent ${ledger.path}`,
        policySha256: 'f'.repeat(64),
        repoRoot: '/repo',
        runId: ledger === first ? 'run-one' : 'run-two',
        submissionCommitOid: 'a'.repeat(40)
      })
    }
    const token = first.acquireLease({ branch: 'feature', repoRoot: '/repo', runId: 'run-one' })
    assert.equal(token, 1)
    assert.throws(
      () => second.acquireLease({ branch: 'feature', repoRoot: '/repo', runId: 'run-two' }),
      /already leased by run run-one/
    )
  } finally {
    first.close()
    second.close()
    await rm(temp, { recursive: true, force: true })
  }
})

test('attestations stay resolvable per run when candidate commits repeat, and commit lookup returns the most recent', () => {
  const ledger = new DomainLedger(':memory:')
  try {
    const candidate = 'c'.repeat(40)
    for (const runId of ['run-one', 'run-two']) {
      ledger.startRun({
        baseBranch: 'main',
        branch: 'feature',
        intent: `Intent ${runId}`,
        policySha256: 'f'.repeat(64),
        repoRoot: '/repo',
        runId,
        submissionCommitOid: 'a'.repeat(40)
      })
      const manifest = {
        version: '1.0.0' as const,
        runId,
        candidateCommitOid: candidate,
        baseCommitOid: 'b'.repeat(40),
        policySha256: 'f'.repeat(64),
        intent: `Intent ${runId}`,
        intentHash: sha256(`Intent ${runId}`),
        stageEvidence: [],
        merkleRoot: sha256(''),
        coordinatorVersion: 'test',
        createdAt: new Date().toISOString()
      }
      ledger.recordAttestation(manifest)
      ledger.finishRun(runId, 'passed', candidate)
    }
    assert.equal(ledger.getAttestation('run-one').runId, 'run-one')
    assert.equal(ledger.getAttestation('run-two').runId, 'run-two')
    assert.equal(ledger.getAttestation(candidate).runId, 'run-two')
  } finally {
    ledger.close()
  }
})

test('legacy attestation ledgers are rebuilt onto the per-run key', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-ledger-legacy-'))
  const dbPath = path.join(temp, 'ledger.db')
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, branch TEXT NOT NULL,
      base_branch TEXT NOT NULL, submission_commit_oid TEXT NOT NULL, terminal_commit_oid TEXT,
      intent TEXT NOT NULL, intent_hash TEXT NOT NULL, policy_sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('in-progress','passed','failed','cancelled')),
      created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE passed_attestations (
      candidate_commit_oid TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      base_commit_oid TEXT NOT NULL, policy_sha256 TEXT NOT NULL, intent TEXT NOT NULL,
      intent_hash TEXT NOT NULL, merkle_root TEXT NOT NULL, manifest_json TEXT NOT NULL,
      coordinator_version TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO runs VALUES (
      'run-legacy', '/repo', 'feature', 'main', '${'a'.repeat(40)}', '${'c'.repeat(40)}',
      'Legacy intent', '${sha256('Legacy intent')}', '${'f'.repeat(64)}',
      'passed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z'
    );
    INSERT INTO passed_attestations VALUES (
      '${'c'.repeat(40)}', 'run-legacy', '${'a'.repeat(40)}', '${'f'.repeat(64)}',
      'Legacy intent', '${sha256('Legacy intent')}', '${'d'.repeat(64)}',
      '${JSON.stringify({ merkleRoot: 'd'.repeat(64), runId: 'run-legacy', version: '1.0.0', candidateCommitOid: 'c'.repeat(40), baseCommitOid: 'a'.repeat(40), policySha256: 'f'.repeat(64), intent: 'Legacy intent', intentHash: sha256('Legacy intent'), stageEvidence: [], coordinatorVersion: 'test', createdAt: '2026-01-01T00:00:00.000Z' })}',
      '0.1.0', '2026-01-01T00:05:00.000Z'
    );
  `)
  legacy.close()
  const reopened = new DomainLedger(dbPath)
  try {
    const shape = reopened.tableDefinition('passed_attestations')
    assert.match(shape ?? '', /run_id TEXT PRIMARY KEY/)
    const manifest = reopened.getAttestation('run-legacy')
    assert.equal(manifest.runId, 'run-legacy')
    assert.equal(reopened.getAttestation('c'.repeat(40)).runId, 'run-legacy')
  } finally {
    reopened.close()
    await rm(temp, { recursive: true, force: true })
  }
})
