import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pullRequestContent } from '../scripts/pull-request.ts'

const OID = 'a'.repeat(40)

test('pullRequestContent publishes the complete pipeline report in the original PR body', () => {
  const giantIntent = 'feat: add a very large pipeline feature\n' + 'x'.repeat(120_000)
  const result = pullRequestContent(giantIntent, {
    candidateCommitOid: OID,
    pipelineSteps: [{ details: 'Reviewed the branch-wide behavior.', name: 'review', status: 'success' }],
    risk: { level: 'low', rationale: 'The final review found no material issues.' },
    testing: {
      artifacts: [{ content: '<html><body>Rendered UI</body></html>', name: 'rendered-ui.html' }],
      summary: 'Exercised the changed UI end to end.',
      tested: ['`node --test tests/ui.test.ts`']
    },
    whatChanged: '- Reworked the complete branch behavior.\n- Added focused regression coverage.'
  })

  assert.equal(result.title, 'feat: add a very large pipeline feature')
  assert.ok(Buffer.byteLength(result.body) <= 63_488)
  assert.ok(result.body.startsWith('## Intent\n\n'))
  assert.match(result.body, /## What Changed\n\n- Reworked the complete branch behavior\./)
  assert.match(result.body, /## Risk Assessment\n\n✅ Low - The final review found no material issues\./)
  assert.match(result.body, /## Testing\n\nExercised the changed UI end to end\./)
  assert.match(result.body, /<summary>rendered-ui\.html<\/summary>/)
  assert.match(result.body, /## Pipeline\n\nUpdates from \[git push orca-no-mistakes\]/)
  assert.match(result.body, /<!-- orca-no-mistakes-pipeline-attestation:v1 \{"head_sha":"a{40}","steps":\[\{"step":"review","status":"success"\}\]\} -->/)
})

test('pullRequestContent bounds escaped evidence and tiny remaining detail budgets', () => {
  const result = pullRequestContent('test: escaped evidence budgets', {
    candidateCommitOid: OID,
    pipelineSteps: [
      { details: 'a'.repeat(4090), name: '<'.repeat(200), status: '>'.repeat(200) },
      ...Array.from({ length: 3 }, (_, index) => ({ details: String(index).repeat(4096), name: `step-${index}`, status: 'success' })),
      { details: 'final detail', name: 'final', status: 'success' }
    ],
    risk: { level: 'low', rationale: 'Escaping is bounded before publication.' },
    testing: {
      artifacts: [{ content: '<'.repeat(20_000), name: '<artifact>.html' }],
      summary: 'Exercised escaped evidence.',
      tested: []
    },
    whatChanged: 'Bound rendered evidence by emitted UTF-8 bytes.'
  })

  assert.ok(Buffer.byteLength(result.body) <= 63_488)
  assert.match(result.body, /<summary>&lt;artifact&gt;\.html<\/summary>/)
  assert.doesNotMatch(result.body, /<pre><+/)
  assert.match(result.body, /<summary>&lt;&lt;/)
})
