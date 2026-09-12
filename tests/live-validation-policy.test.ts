import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { DEFAULT_CONFIG_TEMPLATE, parseConfig, parseConfigYaml, resolvePipelineConfig } from '../scripts/config.ts'
import { extractTrustedBaseConfig, effectivePolicyHash } from '../scripts/policy.ts'

test('runbook is validated and resolved only from hashed trusted repository policy', async () => {
  assert.throws(() => parseConfig({ test_runbook: [] }), /Invalid configuration/)
  assert.equal(resolvePipelineConfig({ userGlobalConfig: { test_runbook: 'skip testing' } }).test_runbook, undefined)
  const result = await extractTrustedBaseConfig({
    resolveRefSha: async () => 'a'.repeat(40),
    showFile: async (ref, name) => {
      assert.equal(ref, 'origin/main')
      assert.equal(name, '.orca/no-mistakes.yaml')
      return 'test_runbook: "Start with npm start; exercise the CLI"'
    },
    pathExists: async () => true,
  }, 'main')
  assert.equal(resolvePipelineConfig({ repoGlobalConfig: result.config }).test_runbook, 'Start with npm start; exercise the CLI')
  assert.equal(result.provenance.effectivePolicyHash, effectivePolicyHash(result.config))
  assert.notEqual(result.provenance.effectivePolicyHash, effectivePolicyHash({ test_runbook: 'skip testing' }))
  const template = await readFile(new URL('../templates/config.yaml', import.meta.url), 'utf8')
  assert.equal(parseConfigYaml(template).test_runbook, '')
  assert.equal(parseConfigYaml(DEFAULT_CONFIG_TEMPLATE).test_runbook, '')
})
