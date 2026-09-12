import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DomainLedger, runPipeline, type GitOperations, type OrcaOperations, type StageReport, type WorkerLaunch } from '../scripts/orca-no-mistakes.ts'
import type { LiveValidation } from '../scripts/live-validation.ts'
import { livePass } from './live-validation-fixture.ts'

async function fixture(t: test.TestContext, initial: LiveValidation) {
  const root = await mkdtemp(path.join(tmpdir(), 'onm-live-'))
  const ledger = new DomainLedger(':memory:')
  t.after(async () => { ledger.close(); await rm(root, { recursive: true, force: true }) })
  const base = 'a'.repeat(40)
  let head = 'b'.repeat(40)
  const fixed = 'c'.repeat(40)
  const git: GitOperations = {
    assertReady: async () => ({ root, branch: 'feature', base: 'main', baseOid: base, head }),
    assertClean: async () => {},
    assertFixerChangesAllowed: async () => ({ changed: true, guardrailViolations: [] }),
    head: async () => head, headOf: async () => fixed,
    diffBase: async () => '',
    resolveRefSha: async () => base, resolveBaseOid: async () => base,
    policySha256: async () => 'f'.repeat(64),
    showFile: async (ref, file) => ref === 'origin/main' && file === '.orca/no-mistakes.yaml' ? 'test_runbook: "Start the product using the trusted command"' : undefined,
    pathExists: async () => false,
    rebase: async () => ({ findings: [], summary: 'rebased', rebaseUpstreamHead: base }),
    applyWorktreeCommits: async () => { head = fixed; return true },
    anchorRecoveryRef: async () => {}, worktreeIsReusable: async () => false,
  }
  const launches: WorkerLaunch[] = []
  const questions: string[] = []
  let index = 0
  let current = initial
  let interrupt = false
  let changeAtLint = false
  const orca: OrcaOperations = {
    createRun: async () => `live-${path.basename(root)}`,
    createTask: async () => `task-${++index}`,
    startWorker: async (taskId, launch) => {
      launches.push(launch)
      if (launch.stage === 'lint' && changeAtLint) { head = fixed; changeAtLint = false }
      const report: StageReport = { summary: `${launch.stage} checked`, findings: [] }
      if (launch.stage === 'test' && launch.role === 'reviewer') report.liveValidation = current
      if (launch.role === 'fixer') current = livePass
      return { dispatchId: `worker-${++index}`, taskId, report, worktreePath: path.join(root, 'worker') }
    },
    finishWorker: async (worker) => { worker.shutdownConfirmed = true },
    removeWorktree: async () => {}, completeTask: async () => {}, setWorktreeStatus: async () => {},
    createGate: async (_task, question) => { questions.push(question); return `gate-${++index}` },
    waitForGate: async () => { if (interrupt) throw new Error('interrupted human decision'); return 'approve' },
  }
  return { ledger, launches, questions, git, orca,
    setInterrupt: (value: boolean) => { interrupt = value },
    changeAtLint: () => { changeAtLint = true },
    runId: `live-${path.basename(root)}`,
    run: (resumeRunId?: string) => runPipeline({ intent: 'Verify live evidence', ...(resumeRunId ? { resumeRunId } : {}) }, orca, git, ledger),
  }
}

test('live failure enters repair and persists the new candidate and verdict', async (t) => {
  const f = await fixture(t, { ...livePass, verdict: 'no-go', scenarios: [{ ...livePass.scenarios[0], result: 'fail' }] })
  const result = await f.run()
  assert.equal(result.verdict, 'passed')
  assert.ok(f.launches.some((l) => l.stage === 'test' && l.role === 'fixer'))
  const evidence = f.ledger.listEvidence(result.runId).filter((e) => e.stage_id === 'test' && e.worker_identity.startsWith('reviewer:'))
  assert.equal(evidence.length, 2)
  assert.equal(evidence[0].exit_code, 1)
  assert.equal(evidence[1].exit_code, 0)
  assert.notEqual(evidence[0].candidate_commit_oid, evidence[1].candidate_commit_oid)
  const retained = JSON.parse(await readFile(evidence[1].artifact_path, 'utf8'))
  assert.deepEqual(retained.liveValidation, livePass)
  assert.equal(retained.evidenceCommitOid, evidence[1].candidate_commit_oid)
  const stage = f.ledger.listPresentationSnapshots(result.runId).at(-1)?.stages.find((s) => s.id === 'test')
  assert.deepEqual(stage?.liveValidation, livePass)
  assert.equal(stage?.evidenceCommitOid, evidence[1].candidate_commit_oid)
  const prompt = f.launches.find((l) => l.stage === 'test')!.prompt
  assert.match(prompt, /Trusted-base startup\/test runbook:\nStart the product using the trusted command/)
  assert.match(prompt, /Unit tests, mocks, recorded fixtures, and source inspection/)
  assert.match(prompt, /read-only test worker/)
})

for (const verdict of ['inconclusive', 'no-surface'] as const) {
  test(`${verdict} requires an explicit human decision`, async (t) => {
    const f = await fixture(t, { verdict, reason: 'Host unavailable or no runtime surface', scenarios: verdict === 'no-surface' ? [] : [{ name: 'Launch app', result: 'untested', live: false, evidence: [], limitation: 'Host unavailable' }] })
    const result = await f.run()
    assert.equal(result.verdict, 'passed')
    assert.equal(f.questions.length, 1)
    assert.match(f.questions[0], new RegExp(`Live validation ${verdict}`))
    assert.equal(f.launches.filter((l) => l.role === 'fixer').length, 0)
    assert.ok(f.ledger.listGateAudit(result.runId).some((g) => g.decision === 'approve'))
  })
}

test('a changed head invalidates a live pass even without an approval', async (t) => {
  const f = await fixture(t, livePass)
  f.changeAtLint()
  const result = await f.run()
  assert.equal(result.verdict, 'passed')
  const evidence = f.ledger.listEvidence(result.runId).filter((e) => e.stage_id === 'test')
  assert.equal(evidence.length, 2)
  assert.notEqual(evidence[0].candidate_commit_oid, evidence[1].candidate_commit_oid)
})

test('resume rechecks an unresolved live verdict and retains its historical evidence', async (t) => {
  const validation: LiveValidation = { verdict: 'no-surface', reason: 'No runtime surface in this change', scenarios: [] }
  const f = await fixture(t, validation)
  f.setInterrupt(true)
  await assert.rejects(f.run(), /interrupted human decision/)
  f.setInterrupt(false)
  const result = await f.run(f.runId)
  assert.equal(result.verdict, 'passed')
  assert.equal(f.launches.filter((l) => l.stage === 'test').length, 2)
  assert.equal(f.questions.length, 2)
  assert.ok(f.questions.every((q) => q.includes('Live validation no-surface')))
  const evidence = f.ledger.listEvidence(f.runId).filter((e) => e.stage_id === 'test')
  assert.equal(evidence.length, 2)
  for (const entry of evidence) {
    assert.deepEqual(JSON.parse(await readFile(entry.artifact_path, 'utf8')).liveValidation, validation)
  }
})
