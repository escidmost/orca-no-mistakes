import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import { pullRequestContent } from '../scripts/pull-request.ts'
import { pullRequestPipelineRounds } from '../scripts/orca-no-mistakes.ts'
import { PresentationPublisher } from '../scripts/presentation.ts'
import { RailTuiRenderer } from '../scripts/tui.ts'
import { livePass } from './live-validation-fixture.ts'
import { liveValidationFinding } from '../scripts/live-validation.ts'

test('rounds omit only duplicate synthetic findings when structured live evidence is present', () => {
  for (const verdict of ['no-go', 'inconclusive', 'no-surface'] as const) {
    const liveValidation = { verdict, reason: 'Needs attention', scenarios: verdict === 'no-surface' ? [] : [{ name: 'Unavailable host', result: 'untested' as const, live: false, evidence: [], limitation: 'Host unavailable' }] }
    const other = { id: 'other', action: 'ask-user' as const, severity: 'warning' as const, description: 'Separate finding' }
    const findings = [...liveValidationFinding(liveValidation), other]
    const report = { summary: 'Needs attention', findings, liveValidation, evidenceCommitOid: 'a'.repeat(40) }
    const [round] = pullRequestPipelineRounds([report], [], [])
    assert.deepEqual(round.findings, [{ description: other.description, severity: other.severity }])
    assert.deepEqual(round.liveValidation, liveValidation)
    assert.equal(round.evidenceCommitOid, report.evidenceCommitOid)
    assert.equal(pullRequestPipelineRounds([{ summary: report.summary, findings }], [], [])[0].findings.length, 2)
    assert.equal(report.findings.length, 2)
  }
})

test('managed report includes candidate-bound live scenarios in testing and stage details', () => {
  const candidate = 'a'.repeat(40)
  const report = { summary: 'verified', findings: [], liveValidation: livePass, evidenceCommitOid: candidate }
  const rounds = pullRequestPipelineRounds([report], [], [])
  const { body } = pullRequestContent('Exercise product', {
    candidateCommitOid: candidate, whatChanged: 'Structured evidence', risk: { level: 'low', rationale: 'focused' },
    pipelineSteps: [{ name: 'test', status: 'completed', rounds }],
    testing: { ...report, artifacts: [], tested: [] },
  })
  for (const section of body.split('## Pipeline')) {
    assert.match(section, /Live validation: go/)
    assert.ok(section.includes(candidate))
    assert.match(section, /Simulated end-user workflow: pass; live: true/)
    assert.match(section, /Evidence: Simulated product output/)
    assert.match(section, /Limitation: none/)
  }
})

test('pre-contract reports remain renderable and do not claim structured live evidence', () => {
  const { body } = pullRequestContent('Legacy run', {
    candidateCommitOid: 'a'.repeat(40), whatChanged: 'Legacy', risk: { level: 'low', rationale: 'legacy' },
    pipelineSteps: [], testing: { summary: 'Old evidence', artifacts: [], tested: ['old check'] },
  })
  assert.match(body, /pre-contract or absent Test evidence/)
  assert.doesNotMatch(body, /Live validation: go/)
})

test('Test details retain live evidence, while inconclusive and no-surface gates never auto-resolve', async () => {
  for (const verdict of ['no-go', 'inconclusive', 'no-surface'] as const) {
    const publisher = new PresentationPublisher({ listPresentationSnapshots: () => [], recordPresentationSnapshot: () => true }, `live-${verdict}`)
    const validation = { ...livePass, verdict, scenarios: verdict === 'no-surface' ? [] : livePass.scenarios }
    publisher.publish('test', { kind: 'stage-started', stage: 'test' })
    publisher.publish('findings', {
      kind: 'findings-recorded', stage: 'test', round: 0, actionable: 1, total: 1,
      liveValidation: validation, evidenceCommitOid: 'a'.repeat(40),
    })
    const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 140, rows: 50, write: (chunk: string) => { screen += chunk; return true } })
    let screen = ''
    const input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, isPaused: () => false, pause() { return this }, resume() { return this }, setRawMode() { return this } })
    const resolutions: string[] = []
    const renderer = new RailTuiRenderer(input, output, '/unused', new Map(), async (_id, result) => { resolutions.push(result) }, undefined, undefined, undefined, undefined, true)
    try {
      renderer.render(publisher.current)
      await setImmediate()
      assert.match(stripVTControlCharacters(screen), new RegExp(`Live validation: ${verdict}`))
      publisher.publish('gate', { kind: 'gate-opened', stage: 'test', round: 0, gateId: 'gate', gateKind: 'finding', options: ['approve', 'fix', 'stop'], question: 'Choose a verdict disposition' })
      renderer.render(publisher.current)
      await setImmediate()
      assert.deepEqual(resolutions, verdict === 'no-go' ? ['fix'] : [])
      publisher.publish('reopen', { kind: 'stage-reopened', stage: 'test' })
      assert.equal(publisher.current.stages.find((s) => s.id === 'test')?.liveValidation, undefined)
    } finally { renderer.close() }
  }
})
