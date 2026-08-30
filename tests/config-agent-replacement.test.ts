import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRoleConfig, type OrcaNoMistakesConfig } from '../scripts/config.ts'

test('structured agents replace lower-precedence agent objects', () => {
  const userGlobalConfig: OrcaNoMistakesConfig = {
    defaults: {
      agent: { harness: 'codex', model: 'gpt-5.6-sol', effort: 'high', variant: 'fast' }
    }
  }
  const repoGlobalConfig: OrcaNoMistakesConfig = {
    defaults: { agent: { harness: 'claude' } }
  }

  assert.deepEqual(
    resolveRoleConfig('review', 'reviewer', { userGlobalConfig, repoGlobalConfig }).agent,
    { harness: 'claude' }
  )
})

test('same-source structured agent overrides replace defaults', () => {
  const repoGlobalConfig: OrcaNoMistakesConfig = {
    defaults: {
      agent: { harness: 'codex', model: 'gpt-5.6-sol', effort: 'high', variant: 'fast' }
    },
    stages: {
      review: { reviewer: { agent: { harness: 'claude' } } }
    }
  }

  assert.deepEqual(resolveRoleConfig('review', 'reviewer', { repoGlobalConfig }).agent, {
    harness: 'claude'
  })
})
