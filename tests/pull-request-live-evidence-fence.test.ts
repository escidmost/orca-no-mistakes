import assert from 'node:assert/strict'
import test from 'node:test'

import { pullRequestContent } from '../scripts/pull-request.ts'

const OID = 'a'.repeat(40)

test('live-validation evidence truncation closes an open fence before later sections', () => {
  const transcript = `transcript:\n\`\`\`\n${'$ no-mistakes axi run\nok\n'.repeat(400)}\`\`\``
  const result = pullRequestContent('feat: fenced live evidence', {
    candidateCommitOid: OID,
    pipelineSteps: [{ name: 'check', status: 'pass' }],
    risk: { level: 'low', rationale: 'Low risk.' },
    testing: {
      artifacts: [],
      liveValidation: {
        verdict: 'go',
        reason: 'Scenario passed live.',
        scenarios: [{ name: 'cli-run', result: 'pass', live: true, evidence: [transcript], limitation: '' }]
      },
      summary: 'Live run.',
      tested: ['npm test']
    },
    whatChanged: 'Fence-safe evidence.'
  })

  const testing = result.body.slice(result.body.indexOf('## Testing'))
  const fences = testing.match(/^```/gmu) ?? []
  assert.ok(fences.length > 0)
  assert.equal(fences.length % 2, 0)
  assert.match(testing, /_\[truncated to fit GitHub PR body limits\]_\n```/)
  assert.match(testing, /Commands and checks:\n- npm test/)
})
