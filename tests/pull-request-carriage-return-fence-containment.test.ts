import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capEscapedMarkdown, escapeUntrustedMarkdown, findUnclosedFence, pullRequestContent } from '../scripts/pull-request.ts'

test('lone carriage returns are treated as Markdown line endings for fence containment', () => {
  assert.deepEqual(findUnclosedFence('```\rhidden'), { char: '`', length: 3 })
  assert.equal(findUnclosedFence('```\rhidden\r```'), null)
  assert.equal(escapeUntrustedMarkdown('a\rb\r\nc\nd'), 'a\nb\nc\nd')
  assert.equal(findUnclosedFence(capEscapedMarkdown('```\rhidden', 2048)), null)

  const content = pullRequestContent('fix: cr fence', {
    candidateCommitOid: '1'.repeat(40),
    pipelineSteps: [{ name: 'review', status: 'completed' }],
    risk: { level: 'low', rationale: 'none' },
    testing: { artifacts: [], summary: '```\rhidden', tested: [] },
    whatChanged: 'prose\r```\rhidden'
  })
  assert.doesNotMatch(content.body, /\r/u)
  assert.equal(findUnclosedFence(content.body), null)
  const testingIndex = content.body.indexOf('## Testing')
  assert.ok(testingIndex > 0)
  assert.equal(findUnclosedFence(content.body.slice(0, testingIndex)), null)
})
