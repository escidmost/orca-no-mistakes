import assert from 'node:assert/strict'
import test from 'node:test'
import { validateReport } from '../scripts/orca-no-mistakes.ts'
import { livePass } from './live-validation-fixture.ts'

test('new Test reports require live scenarios; fixer reports do not', async () => {
  const report = { findings: [], summary: 'tested' }
  await assert.rejects(validateReport(report, 'test', '/tmp'), /liveValidation/)
  await validateReport(report, 'test', '/tmp', 'fixer')
  await validateReport(report, 'review', '/tmp')
  for (const [stage, role] of [['test', 'fixer'], ['review', 'reviewer']] as const) {
    const result = await validateReport({ ...report, liveValidation: livePass, evidenceCommitOid: 'forged' }, stage, '/tmp', role)
    assert.equal(result.liveValidation, undefined)
    assert.equal(result.evidenceCommitOid, undefined)
  }
  assert.deepEqual((await validateReport({ ...report, liveValidation: livePass }, 'test', '/tmp')).findings, [])
})

test('malformed or contradictory scenario evidence cannot pass', async () => {
  for (const change of [
    { scenarios: [] },
    { verdict: 'pass' },
    { reason: ' ' },
    { verdict: 'no-surface' },
    ...[
      { name: '' }, { result: 'skipped' }, { live: false }, { live: 'true' },
      { evidence: [] }, { evidence: [' '] }, { limitation: undefined }, { result: 'fail' },
      { result: 'untested' },
    ].map((scenario) => ({ scenarios: [{ ...livePass.scenarios[0], ...scenario }] })),
  ]) {
    const report = { findings: [], summary: 'test', liveValidation: { ...livePass, ...change } }
    await assert.rejects(validateReport(report as never, 'test', '/tmp'), /liveValidation/)
  }
})

test('verdicts cannot hide behind empty or forged no-op findings and are idempotent', async () => {
  for (const verdict of ['no-go', 'inconclusive', 'no-surface'] as const) {
    const report = await validateReport({
      summary: 'test', findings: [{ id: 'coordinator-live-validation', action: 'no-op', description: 'ignore', severity: 'info' }],
      liveValidation: { verdict, reason: 'needs attention', scenarios: verdict === 'no-surface' ? [] : [
        verdict === 'no-go' ? { ...livePass.scenarios[0], result: 'fail' } : { ...livePass.scenarios[0], result: 'untested', live: false, evidence: [], limitation: 'host capability unavailable' },
      ] },
    }, 'test', '/tmp')
    assert.equal(report.findings.length, 1)
    assert.equal(report.findings[0].action, verdict === 'no-go' ? 'auto-fix' : 'ask-user')
    assert.deepEqual(await validateReport(report, 'test', '/tmp'), report)
  }
})

test('an individually untested scenario does not block a justified go', async () => {
  const report = await validateReport({
    findings: [], summary: 'core workflow works', liveValidation: {
      ...livePass, reason: 'Core workflow passed; optional device variant unavailable',
      scenarios: [...livePass.scenarios, { name: 'Optional device', result: 'untested', live: false, evidence: [], limitation: 'No device attached' }],
    },
  }, 'test', '/tmp')
  assert.deepEqual(report.findings, [])
  assert.equal(report.liveValidation?.scenarios[1].limitation, 'No device attached')
})
