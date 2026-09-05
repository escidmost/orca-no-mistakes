import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pullRequestPipelineRounds, type StageReport } from '../scripts/orca-no-mistakes.ts'
import { pullRequestContent } from '../scripts/pull-request.ts'

test('informational no-op notes in a clean re-check are not published as still-open findings', () => {
  const reports: StageReport[] = [
    {
      findings: [
        { action: 'auto-fix', description: 'real defect', id: 'defect', severity: 'error' }
      ],
      summary: 'analysis 1'
    },
    {
      findings: [
        { action: 'no-op', description: 'validation-policy note', id: 'note', severity: 'info' }
      ],
      summary: 'analysis 2'
    }
  ]
  const rounds = pullRequestPipelineRounds(reports, [{ analysis: 1, summary: 'fixed defect' }], [
    { description: 'real defect', disposition: 'fixed', id: 'defect', severity: 'error' }
  ])
  assert.equal(rounds[0].findings.length, 1)
  assert.deepEqual(rounds[1].findings, [])

  const content = pullRequestContent('fix: noop recheck', {
    candidateCommitOid: '1'.repeat(40),
    pipelineSteps: [{ name: 'review', rounds, status: 'completed' }],
    risk: { level: 'low', rationale: 'none' },
    testing: { artifacts: [], summary: 'passed', tested: [] },
    whatChanged: 'noop recheck'
  })
  assert.match(content.body, /✅ Re-checked - no issues remain\./)
  assert.doesNotMatch(content.body, /still open/)
})
