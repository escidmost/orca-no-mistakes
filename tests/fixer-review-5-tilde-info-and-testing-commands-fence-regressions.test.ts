import assert from 'node:assert/strict'
import test from 'node:test'

import {
  capEscapedMarkdown,
  findUnclosedFence,
  pullRequestContent,
  type PullRequestReport
} from '../scripts/pull-request.ts'
import { assertStructurallyVisible } from './markdown-visibility.ts'

const OID = 'a'.repeat(40)

test('findUnclosedFence recognizes tilde fences with tildes in info string', () => {
  const content = '~~~ ~example\nunfinished'
  const unclosed = findUnclosedFence(content)
  assert.deepEqual(unclosed, { char: '~', length: 3 })

  const capped = capEscapedMarkdown(content, 1000)
  assert.equal(findUnclosedFence(capped), null)
  assert.ok(capped.endsWith('~~~'))
  assert.throws(
    () => assertStructurallyVisible(`${content}\n## Hidden`, '## Hidden'),
    /Expected "## Hidden" to be structurally visible outside any code fences/
  )
  assertStructurallyVisible(`${capped}\n## Visible`, '## Visible')
})

test('pullRequestContent balances tilde info fences across section boundaries', () => {
  const report: PullRequestReport = {
    candidateCommitOid: OID,
    pipelineSteps: [
      {
        name: 'test',
        status: 'passed'
      }
    ],
    risk: {
      level: 'low',
      rationale: 'Low risk change.'
    },
    testing: {
      artifacts: [],
      summary: 'Tests completed successfully.',
      tested: ['npm test']
    },
    whatChanged: '~~~ ~example\nunfinished what changed'
  }

  const { body } = pullRequestContent('Intent for tilde test', report)
  assertStructurallyVisible(body, '## Risk Assessment')
  assertStructurallyVisible(body, '## Testing')
  assertStructurallyVisible(body, '## Pipeline')
  assertStructurallyVisible(body, '<!-- orca-no-mistakes-pipeline-attestation:v1')
})

test('testing commands contain unclosed fences and preserve Pipeline heading when no artifacts exist', () => {
  const report: PullRequestReport = {
    candidateCommitOid: OID,
    pipelineSteps: [
      {
        name: 'test',
        status: 'passed'
      }
    ],
    risk: {
      level: 'low',
      rationale: 'Safe fix.'
    },
    testing: {
      artifacts: [],
      summary: 'Tested cleanly.',
      tested: ['npm test\n\n```sh\noutput without closing fence']
    },
    whatChanged: 'Simple changes.'
  }

  const { body } = pullRequestContent('Intent text', report)
  assertStructurallyVisible(body, '## Pipeline')
  assertStructurallyVisible(body, '<!-- orca-no-mistakes-pipeline-attestation:v1')
  assert.ok(body.includes('```sh\noutput without closing fence\n```'))
})

test('testing commands contain truncation-opened fences and honor budget', () => {
  const longCommand = `long check\n\n\`\`\`bash\n${'echo check;\n'.repeat(500)}`
  const report: PullRequestReport = {
    candidateCommitOid: OID,
    pipelineSteps: [
      {
        name: 'test',
        status: 'passed'
      }
    ],
    risk: {
      level: 'low',
      rationale: 'Safe fix.'
    },
    testing: {
      artifacts: [],
      summary: 'Tested cleanly.',
      tested: [longCommand]
    },
    whatChanged: 'Simple changes.'
  }

  const { body } = pullRequestContent('Intent text', report)
  assertStructurallyVisible(body, '## Pipeline')
  assertStructurallyVisible(body, '<!-- orca-no-mistakes-pipeline-attestation:v1')
  assert.ok(Buffer.byteLength(body) <= 63_488)
})
