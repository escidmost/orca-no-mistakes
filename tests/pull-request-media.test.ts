import assert from 'node:assert/strict'
import test from 'node:test'
import { pullRequestContent, type PullRequestArtifact } from '../scripts/pull-request.ts'
import { parseConfig, resolvePipelineConfig, DEFAULT_CONFIG_TEMPLATE, parseConfigYaml } from '../scripts/config.ts'

test('media configuration is opt-in and exact digest approvals survive trusted resolution', () => {
  assert.deepEqual(resolvePipelineConfig().media_publication, { enabled: false, approved_sha256: [] })
  assert.equal(parseConfigYaml(DEFAULT_CONFIG_TEMPLATE).media_publication?.enabled, false)
  const approved = 'a'.repeat(64)
  assert.deepEqual(resolvePipelineConfig({ userGlobalConfig: parseConfig({ media_publication: { enabled: true, approved_sha256: [approved] } }) }).media_publication, { enabled: true, approved_sha256: [approved] })
  assert.equal(resolvePipelineConfig({ userGlobalConfig: { media_publication: { enabled: true } }, repoGlobalConfig: { media_publication: { enabled: false } } }).media_publication.enabled, false)
  assert.throws(() => parseConfig({ media_publication: { enabled: true, approved_sha256: ['*'] } }))
})

test('image embeds, recording links and escaped text coexist within the body budget', () => {
  const url = 'https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const artifacts: PullRequestArtifact[] = [
    { name: 'Screenshot <test>', content: 'SHA-256: approved', media: { kind: 'image', url } },
    { name: 'Recording', content: 'Candidate: tested', media: { kind: 'video', url } },
    { name: 'Text', content: '<script>not executable</script>' },
    { name: 'Invalid link', content: 'retained', media: { kind: 'image', url: 'https://evil.example/injected' } },
    ...Array.from({ length: 50 }, () => ({ name: 'large', content: '<'.repeat(20_000) }))
  ]
  const { body } = pullRequestContent('ONM-99: media', { candidateCommitOid: 'a'.repeat(40), pipelineSteps: [], risk: { level: 'low', rationale: 'test' }, testing: { artifacts, summary: 'test', tested: [] }, whatChanged: 'media' })
  assert.ok(body.includes(`![Evidence image](${url})`))
  assert.ok(body.includes(`[View recording](${url})`))
  assert.match(body, /&lt;script&gt;/)
  assert.doesNotMatch(body, /evil\.example/)
  assert.ok(Buffer.byteLength(body) <= 63_488)
})
