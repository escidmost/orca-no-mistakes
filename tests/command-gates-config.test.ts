import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { CommandGatesSchema, DEFAULT_CONFIG_TEMPLATE, PIPELINE_STEPS, parseConfig, parseConfigYaml, resolvePipelineConfig, withCommandGates } from '../scripts/config.ts'
import { extractTrustedBaseConfig, trustedRepoPolicyConfig } from '../scripts/policy.ts'

const gate = { name: 'architecture', after: 'test', command: 'node check.js' } as const

test('command gate declarations are bounded and strict, including required-only semantics', () => {
  assert.deepEqual(parseConfig({ command_gates: [gate] }).command_gates, [gate])
  for (const name of ['', '-a', 'a-', 'a--b', 'A', '../x', 'a b', 'a'.repeat(41), ...PIPELINE_STEPS]) {
    assert.throws(() => parseConfig({ command_gates: [{ ...gate, name }] }), /Invalid configuration/)
  }
  assert.equal(CommandGatesSchema.parse([{ ...gate, name: 'a'.repeat(40) }]).length, 1)
  for (const after of ['intent', 'push', 'pr', 'ci', 'unknown']) {
    assert.throws(() => parseConfig({ command_gates: [{ ...gate, after }] }))
  }
  for (const extra of [{ command: '' }, { command: ' \n ' }, { agent: 'claude' }, { optional: true }, { skip: true }, { requirement: 'optional' }]) {
    assert.throws(() => parseConfig({ command_gates: [{ ...gate, ...extra }] }))
  }
  assert.throws(() => parseConfig({ command_gates: [gate, gate] }), /duplicate/)
  const many = Array.from({ length: 16 }, (_, index) => ({ ...gate, name: `gate-${index}` }))
  assert.equal(CommandGatesSchema.parse(many).length, 16)
  assert.throws(() => CommandGatesSchema.parse([...many, { ...gate, name: 'extra' }]))
})

test('trusted base alone supplies declarations, while templates agree on empty defaults', async () => {
  const reads: string[] = []
  const { config, provenance } = await extractTrustedBaseConfig({
    resolveRefSha: async () => 'a'.repeat(40),
    showFile: async (ref) => { reads.push(ref); return JSON.stringify({ command_gates: [gate] }) },
    pathExists: async () => true,
  }, 'main')
  assert.deepEqual(reads, ['origin/main'])
  assert.deepEqual(resolvePipelineConfig({ repoGlobalConfig: trustedRepoPolicyConfig(config, provenance), userGlobalConfig: { command_gates: [{ ...gate, name: 'untrusted' }] } }).command_gates, [gate])
  assert.deepEqual(resolvePipelineConfig({ userGlobalConfig: config }).command_gates, [])
  assert.deepEqual(resolvePipelineConfig({ repoGlobalConfig: trustedRepoPolicyConfig(config, { ...provenance, localBypass: true }) }).command_gates, [])
  const file = readFileSync(new URL('../templates/config.yaml', import.meta.url), 'utf8')
  assert.equal(DEFAULT_CONFIG_TEMPLATE, file)
  assert.deepEqual(parseConfigYaml(file).command_gates, [])
})

test('anchoring preserves core order and declaration order before publication', () => {
  const gates = [{ ...gate, name: 'second', after: 'lint' as const }, gate, { ...gate, name: 'third' }]
  const plan = withCommandGates(PIPELINE_STEPS, gates)
  assert.deepEqual(plan, ['intent', 'rebase', 'review', 'test', 'command-architecture', 'command-third', 'document', 'lint', 'command-second', 'push', 'pr', 'ci'])
})
