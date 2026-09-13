import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { DomainLedger, runPipeline, type GitOperations, type OrcaOperations, type StageReport, type WorkerLaunch } from '../scripts/orca-no-mistakes.ts'
import { withLivePass } from './live-validation-fixture.ts'
import { repository } from './command-gates-fixture.ts'
import { commandGateStage, withCommandGates, type CommandGate } from '../scripts/config.ts'
import { LEGACY_STAGE_PLAN } from '../scripts/ledger.ts'

const pass = (summary: string): StageReport => ({ findings: [], summary })
const declaration: CommandGate = { name: 'value-check', after: 'test', command: 'node check.cjs' }

async function fixture() {
  const repo = await repository()
  const ledger = new DomainLedger(path.join(repo.directory, 'ledger.sqlite'))
  let head = repo.initial
  let declarations = [declaration]
  const launches: WorkerLaunch[] = []
  const gates: string[][] = []
  const questions: string[] = []
  const resolutions: string[] = []
  let index = 0
  let failLint = false
  let fixLint = false
  const git: GitOperations = {
    assertReady: async () => ({ base: 'main', baseOid: repo.initial, branch: 'feature', head, root: repo.root }),
    assertClean: async () => {},
    assertFixerChangesAllowed: async () => ({ changed: true, guardrailViolations: [] }),
    head: async () => head,
    headOf: async () => repo.repaired,
    diffBase: async () => '',
    resolveRefSha: async () => repo.initial,
    showFile: async () => JSON.stringify({ command_gates: declarations }),
    pathExists: async () => true,
    rebase: async () => ({ ...pass('rebased'), rebaseUpstreamHead: repo.initial }),
    policySha256: async () => 'f'.repeat(64),
    resolveBaseOid: async () => repo.initial,
    applyWorktreeCommits: async (_root, before, after) => { assert.equal(head, before); head = after; return true },
    anchorRecoveryRef: async () => {},
    worktreeIsReusable: async () => false,
  }
  const runId = `command-gate-${path.basename(repo.directory)}`
  const orca: OrcaOperations = {
    createRun: async () => runId,
    createTask: async () => `task-${++index}`,
    startWorker: async (taskId, launch) => {
      launches.push(launch)
      if (launch.stage === 'lint' && failLint) throw new Error('lint interrupted')
      const report = launch.stage === 'lint' && fixLint && launch.role === 'reviewer' && head === repo.initial
        ? { summary: 'lint needs repair', findings: [{ id: 'lint-fix', action: 'auto-fix' as const, severity: 'error' as const, description: 'repair value' }] }
        : pass(`${launch.stage} ${launch.role} completed`)
      return { taskId, dispatchId: `worker-${++index}`, report: withLivePass(launch, report), worktreePath: '/fake-command-gate-fixer', terminalHandle: `term-${index}` }
    },
    finishWorker: async () => {},
    removeWorktree: async () => {},
    createGate: async (_task, question, options) => { gates.push(options ?? []); questions.push(question); return `gate-${++index}` },
    waitForGate: async () => resolutions.shift() ?? 'stop',
    completeTask: async () => {},
    setWorktreeStatus: async () => {},
  }
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  process.env.ORCA_NO_MISTAKES_HOME = path.join(repo.directory, 'home')
  return {
    ...repo, ledger, git, orca, runId, launches, gates, questions, resolutions,
    setDeclarations: (value: CommandGate[]) => { declarations = value },
    setFailLint: (value: boolean) => { failLint = value },
    setFixLint: () => { fixLint = true },
    run: (resume = false) => runPipeline({ intent: 'Check trusted command gates', ...(resume ? { resumeRunId: runId } : {}) }, orca, git, ledger),
    cleanup: async () => {
      ledger.close()
      if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
      else process.env.ORCA_NO_MISTAKES_HOME = previousHome
      await repo.cleanup()
    },
  }
}

test('failed required command opens a decision; explicit fix commits repair and reruns to success', async () => {
  const f = await fixture()
  f.resolutions.push('fix')
  try {
    const result = await f.run()
    assert.deepEqual(f.gates, [['fix', 'stop']])
    const fixer = f.launches.filter((launch) => launch.role === 'fixer')
    assert.equal(fixer.length, 1)
    assert.equal(fixer[0].stage, 'command-value-check')
    const evidence = f.ledger.listEvidence(f.runId).filter((row) => row.stage_id === 'command-value-check' && row.worker_identity === 'coordinator')
    // The repair also invalidates the anchor's live-test evidence, so the final
    // revalidation reruns test and its command gate on the repaired candidate.
    assert.deepEqual(evidence.map((row) => [row.exit_code, row.candidate_commit_oid]), [[7, f.initial], [0, f.repaired], [0, f.repaired]])
    assert.match(await readFile(evidence[1].artifact_path, 'utf8'), /good/)
    assert.deepEqual(f.ledger.commandGates(f.runId), [declaration])
    assert.deepEqual(f.ledger.stagePlan(f.runId).map((row) => row.stage_id), withCommandGates(LEGACY_STAGE_PLAN, [declaration]))
    assert.ok(result.steps.includes('command-value-check'))
  } finally { await f.cleanup() }
})

for (const resolution of ['approve', 'skip', 'stop']) test(`required command failure cannot be certified by ${resolution}`, async () => {
  const f = await fixture()
  f.resolutions.push(resolution)
  try {
    await assert.rejects(f.run(), resolution === 'stop' ? /stopped/ : /not offered/)
    assert.deepEqual(f.gates, [['fix', 'stop']])
    assert.equal(f.launches.some((launch) => launch.role === 'fixer'), false)
    assert.notEqual(f.ledger.runStatus(f.runId), 'passed')
  } finally { await f.cleanup() }
})

test('later candidate changes invalidate a passed command and leave fresh evidence', async () => {
  const f = await fixture()
  f.setDeclarations([{ ...declaration, command: 'node -e "console.log(require(\'node:fs\').readFileSync(\'value\', \'utf8\'))"' }])
  f.setFixLint()
  try {
    await f.run()
    const evidence = f.ledger.listEvidence(f.runId).filter((row) => row.stage_id === 'command-value-check')
    assert.deepEqual(evidence.map((row) => row.candidate_commit_oid), [f.initial, f.repaired])
    assert.match(evidence[1].summary, /good/)
  } finally { await f.cleanup() }
})

for (const exitCode of [0, 7]) test(`command output secrets are redacted from persisted reports and decisions (exit ${exitCode})`, async () => {
  const f = await fixture()
  const previousSecret = process.env.ONM_TEST_SECRET
  const secret = 'command-output-test-secret-9876'
  process.env.ONM_TEST_SECRET = secret
  f.setDeclarations([{ ...declaration, command: `node -e 'console.log(process.env.ONM_TEST_SECRET); process.exit(${exitCode})'` }])
  try {
    if (exitCode === 0) await f.run()
    else await assert.rejects(f.run(), /stopped/)
    const [evidence] = f.ledger.listEvidence(f.runId).filter((row) => row.stage_id === 'command-value-check')
    assert.equal(evidence.exit_code, exitCode)
    const artifact = await readFile(evidence.artifact_path, 'utf8')
    for (const text of [evidence.summary, artifact, ...f.questions]) {
      assert.equal(text.includes(secret), false)
      assert.match(text, /\[REDACTED\]/)
    }
    const report = JSON.parse(artifact)
    assert.equal(report.findings.length, exitCode === 0 ? 0 : 1)
    if (exitCode !== 0) assert.match(report.findings[0].description, /\[REDACTED\]/)
  } finally {
    if (previousSecret === undefined) delete process.env.ONM_TEST_SECRET
    else process.env.ONM_TEST_SECRET = previousSecret
    await f.cleanup()
  }
})

test('resume retains the frozen declarations despite removal or retargeting in later policy', async () => {
  const f = await fixture()
  const original = { ...declaration, command: 'node -e "console.log(\'frozen-command\')"' }
  f.setDeclarations([original])
  f.setFailLint(true)
  try {
    await assert.rejects(f.run(), /lint interrupted/)
    f.setDeclarations([{ name: 'injected', after: 'rebase', command: 'exit 99' }])
    f.setFailLint(false)
    await f.run(true)
    assert.deepEqual(f.ledger.commandGates(f.runId), [original])
    assert.equal(f.ledger.stagePlan(f.runId).some((row) => row.stage_id === 'command-injected'), false)
    assert.equal(f.ledger.runStatus(f.runId), 'passed')
  } finally { await f.cleanup() }
})

test('ledger freezes declarations and refuses optional command plan entries', () => {
  const ledger = new DomainLedger(':memory:')
  const input = { baseBranch: 'main', branch: 'feature', intent: 'test', policySha256: 'f'.repeat(64), repoRoot: '/repo', runId: 'frozen', submissionCommitOid: 'a'.repeat(40), commandGates: [declaration] }
  try {
    assert.throws(() => ledger.startRun({ ...input, stagePlan: [{ stageId: commandGateStage(declaration.name), requirement: 'optional' }] }), /required frozen plan/)
    for (const stages of [
      ['command-value-check', ...LEGACY_STAGE_PLAN],
      [...LEGACY_STAGE_PLAN, 'command-value-check'],
      ['intent', 'rebase', 'review', 'command-value-check', 'document', 'lint'],
    ]) {
      assert.throws(() => ledger.startRun({ ...input, stagePlan: stages.map((stageId) => ({ stageId, requirement: 'required' })) }), /order must match/)
    }
    const second = { ...declaration, name: 'second' }
    assert.throws(() => ledger.startRun({ ...input, commandGates: [declaration, second], stagePlan: withCommandGates(LEGACY_STAGE_PLAN, [second, declaration]).map((stageId) => ({ stageId, requirement: 'required' })) }), /order must match/)
    ledger.startRun({ ...input, stagePlan: withCommandGates(LEGACY_STAGE_PLAN, [declaration]).map((stageId) => ({ stageId, requirement: 'required' })) })
    const copy = ledger.commandGates(input.runId)
    copy[0].command = 'exit 99'
    assert.deepEqual(ledger.commandGates(input.runId), [declaration])
  } finally { ledger.close() }
})
