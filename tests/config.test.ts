import assert from 'node:assert/strict'
import test from 'node:test'
import { PIPELINE_STEPS } from '../scripts/orca-no-mistakes.ts'
import {
  AgentArgsOverrideSchema,
  AgentConfigSchema,
  AgentSpecSchema,
  AutoFixConfigSchema,
  BASELINE_AUTO_FIX,
  CliFlagsSchema,
  DefaultsConfigSchema,
  OrcaNoMistakesConfigSchema,
  RoleConfigSchema,
  StageConfigSchema,
  StagesConfigSchema,
  deepMerge,
  formatZodError,
  normalizeAgentSpec,
  parseConfig,
  parseConfigYaml,
  resolvePipelineConfig,
  resolveRoleConfig,
  type OrcaNoMistakesConfig
} from '../scripts/config.ts'

test('validates strict schema and parses valid configurations', () => {
  const valid = {
    defaults: {
      agent: 'claude',
      model: 'claude-3-7-sonnet',
      effort: 'high',
      timeout_ms: 60000,
      reviewer: {
        agent: { harness: 'opencode', model: 'sonnet' },
        effort: 'medium'
      },
      fixer: {
        agent: ['claude', 'codex']
      }
    },
    stages: {
      review: {
        model: 'claude-3-5-sonnet',
        reviewer: {
          effort: 'high'
        }
      },
      lint: {
        fixer: {
          agent: 'grok'
        }
      }
    },
    auto_fix: {
      enabled: true,
      max_rounds: 5,
      allow_review_autofix: false
    },
    agent_args_override: {
      opencode: ['--agent', 'review-bot'],
      gemini: { TEMPERATURE: '0.2' }
    },
    intent: 'Refactor configuration system'
  }

  const parsed = parseConfig(valid)
  assert.deepEqual(parsed, valid)
})

test('parses YAML configuration files accurately', () => {
  const yamlContent = `
defaults:
  agent: claude
  model: claude-3-7-sonnet
stages:
  review:
    reviewer:
      effort: high
      timeout_ms: 120000
auto_fix:
  enabled: true
  max_rounds: 4
agent_args_override:
  opencode:
    - "--custom-flag"
`
  const parsed = parseConfigYaml(yamlContent)
  assert.equal(parsed.defaults?.agent, 'claude')
  assert.equal(parsed.defaults?.model, 'claude-3-7-sonnet')
  assert.equal(parsed.stages?.review?.reviewer?.effort, 'high')
  assert.equal(parsed.stages?.review?.reviewer?.timeout_ms, 120000)
  assert.equal(parsed.auto_fix?.max_rounds, 4)
  assert.deepEqual(parsed.agent_args_override?.opencode, ['--custom-flag'])
})

test('empty or whitespace input to parseConfig and parseConfigYaml returns empty object', () => {
  assert.deepEqual(parseConfig(null), {})
  assert.deepEqual(parseConfig(undefined), {})
  assert.deepEqual(parseConfig({}), {})
  assert.deepEqual(parseConfigYaml(''), {})
  assert.deepEqual(parseConfigYaml('   \n  \n'), {})
})

test('fails closed with descriptive errors on invalid YAML syntax', () => {
  assert.throws(
    () => parseConfigYaml('bad: yaml: : 123'),
    /YAML parse error/
  )
})

test('fails closed on unknown root keys', () => {
  assert.throws(
    () => parseConfig({ unknown_key: 'value' }),
    (err: Error) => {
      assert.match(err.message, /Invalid configuration/)
      assert.match(err.message, /Unrecognized key\(s\) 'unknown_key'/)
      return true
    }
  )
})

test('fails closed on unknown keys in defaults', () => {
  assert.throws(
    () => parseConfig({ defaults: { invalid_field: 'test' } }),
    (err: Error) => {
      assert.match(err.message, /Invalid configuration/)
      assert.match(err.message, /Unrecognized key\(s\) 'invalid_field' at 'defaults'/)
      return true
    }
  )
})

test('fails closed on unknown keys in stage configurations', () => {
  assert.throws(
    () => parseConfig({ stages: { review: { invalid_stage_prop: 123 } } }),
    (err: Error) => {
      assert.match(err.message, /Invalid configuration/)
      assert.match(err.message, /Unrecognized key\(s\) 'invalid_stage_prop' at 'stages\.review'/)
      return true
    }
  )
})

test('fails closed on unknown keys in stage role overrides', () => {
  assert.throws(
    () => parseConfig({ stages: { review: { reviewer: { unknown_role_prop: true } } } }),
    (err: Error) => {
      assert.match(err.message, /Invalid configuration/)
      assert.match(err.message, /Unrecognized key\(s\) 'unknown_role_prop' at 'stages\.review\.reviewer'/)
      return true
    }
  )
})

test('fails closed on unknown keys in auto_fix configuration', () => {
  assert.throws(
    () => parseConfig({ auto_fix: { unknown_autofix: true } }),
    (err: Error) => {
      assert.match(err.message, /Invalid configuration/)
      assert.match(err.message, /Unrecognized key\(s\) 'unknown_autofix' at 'auto_fix'/)
      return true
    }
  )
})

test('fails closed on invalid types for configuration fields', () => {
  assert.throws(
    () => parseConfig({ auto_fix: { max_rounds: -1 } }),
    /Invalid configuration/
  )
  assert.throws(
    () => parseConfig({ defaults: { timeout_ms: 0 } }),
    /Invalid configuration/
  )
  assert.throws(
    () => parseConfig({ defaults: { agent: [] } }),
    /Invalid configuration/
  )
})

test('deepMerge recursively merges nested objects and scalar-replaces arrays and primitives', () => {
  const target = {
    a: 1,
    b: 'initial',
    nested: {
      foo: 'bar',
      keep: true
    },
    arr: ['first', 'second'],
    agent_args: {
      opencode: ['--initial'],
      custom: { K1: 'V1' }
    }
  }

  const source = {
    b: 'overridden',
    c: 'new',
    nested: {
      foo: 'updated'
    },
    arr: ['replacement'],
    agent_args: {
      opencode: ['--replacement'],
      custom: { K2: 'V2' }
    }
  }

  const merged = deepMerge(target, source)
  assert.deepEqual(merged, {
    a: 1,
    b: 'overridden',
    c: 'new',
    nested: {
      foo: 'updated',
      keep: true
    },
    arr: ['replacement'],
    agent_args: {
      opencode: ['--replacement'],
      custom: { K1: 'V1', K2: 'V2' }
    }
  })

  // Verify target and source are not mutated
  assert.equal(target.b, 'initial')
  assert.deepEqual(target.arr, ['first', 'second'])
})

test('5-tier precedence hierarchy resolves in exact order: CLI > Stage Role > Stage Default > Repo Global > User Global', () => {
  // Tier 5: User Global Config (~/.config/orca-no-mistakes/config.yaml)
  const userGlobalConfig: OrcaNoMistakesConfig = {
    defaults: {
      agent: 'claude',
      model: 'tier5-user-model',
      effort: 'low',
      timeout_ms: 10000,
      agent_args_override: {
        common: ['--user-global'],
        user_only: ['--user-specific']
      }
    },
    auto_fix: {
      enabled: true,
      max_rounds: 1,
      allow_review_autofix: false
    }
  }

  // Tier 4: Repository Global Config (.orca/no-mistakes.yaml)
  const repoGlobalConfig: OrcaNoMistakesConfig = {
    defaults: {
      model: 'tier4-repo-model',
      effort: 'medium',
      timeout_ms: 20000,
      agent_args_override: {
        common: ['--repo-global'],
        repo_only: { R1: 'V1' }
      }
    },
    auto_fix: {
      max_rounds: 2
    },
    stages: {
      // Tier 3: Stage Default Config
      review: {
        model: 'tier3-stage-model',
        effort: 'high',
        // Tier 2: Stage Role Config
        reviewer: {
          effort: 'tier2-reviewer-effort',
          agent: ['tier2-reviewer-agent1', 'tier2-reviewer-agent2']
        },
        fixer: {
          effort: 'tier2-fixer-effort',
          agent: 'tier2-fixer-agent'
        }
      }
    }
  }

  // Tier 1: CLI Flags
  const cliFlags = {
    model: 'tier1-cli-model',
    reviewer: {
      timeout_ms: 99999
    }
  }

  // Resolve reviewer for review stage
  const reviewerConfig = resolveRoleConfig('review', 'reviewer', {
    userGlobalConfig,
    repoGlobalConfig,
    cliFlags
  })

  // 1. model: CLI flag (Tier 1) wins over Tier 2, 3, 4, 5
  assert.equal(reviewerConfig.model, 'tier1-cli-model')
  // 2. effort: Stage Role Config (Tier 2) wins over Tier 3, 4, 5
  assert.equal(reviewerConfig.effort, 'tier2-reviewer-effort')
  // 3. agent: Stage Role Config (Tier 2) array replacement wins over Tier 5
  assert.deepEqual(reviewerConfig.agent, ['tier2-reviewer-agent1', 'tier2-reviewer-agent2'])
  // 4. timeout_ms: CLI reviewer flag (Tier 1) wins over Tier 4 (20000) and Tier 5 (10000)
  assert.equal(reviewerConfig.timeout_ms, 99999)
  // 5. agent_args_override: deep merged across tiers, array replaced for common
  assert.deepEqual(reviewerConfig.agent_args_override, {
    common: ['--repo-global'],
    user_only: ['--user-specific'],
    repo_only: { R1: 'V1' }
  })
  // 6. auto_fix: max_rounds from Tier 4 (2) overrides Tier 5 (1)
  assert.equal(reviewerConfig.auto_fix.max_rounds, 2)
  assert.equal(reviewerConfig.auto_fix.enabled, true)
  assert.equal(reviewerConfig.auto_fix.allow_review_autofix, false)

  // Resolve fixer for review stage (no CLI fixer overrides)
  const fixerConfig = resolveRoleConfig('review', 'fixer', {
    userGlobalConfig,
    repoGlobalConfig,
    cliFlags: { model: 'tier1-cli-model' }
  })

  assert.equal(fixerConfig.model, 'tier1-cli-model')
  assert.equal(fixerConfig.effort, 'tier2-fixer-effort')
  assert.equal(fixerConfig.agent, 'tier2-fixer-agent')
  assert.equal(fixerConfig.timeout_ms, 20000) // From Tier 4 repo defaults
})

test('stage defaults apply when stage role override is not specified', () => {
  const repoGlobalConfig: OrcaNoMistakesConfig = {
    stages: {
      lint: {
        model: 'stage-lint-model',
        effort: 'low',
        timeout_ms: 15000
      }
    }
  }

  const reviewer = resolveRoleConfig('lint', 'reviewer', { repoGlobalConfig })
  const fixer = resolveRoleConfig('lint', 'fixer', { repoGlobalConfig })

  assert.equal(reviewer.model, 'stage-lint-model')
  assert.equal(reviewer.effort, 'low')
  assert.equal(reviewer.timeout_ms, 15000)

  assert.equal(fixer.model, 'stage-lint-model')
  assert.equal(fixer.effort, 'low')
  assert.equal(fixer.timeout_ms, 15000)
})

test('CLI max-fix-rounds overrides all configuration layers for auto_fix', () => {
  const userGlobalConfig: OrcaNoMistakesConfig = { auto_fix: { max_rounds: 1 } }
  const repoGlobalConfig: OrcaNoMistakesConfig = { auto_fix: { max_rounds: 2 } }
  const cliFlags = { max_fix_rounds: 10 }

  const resolved = resolveRoleConfig('test', 'reviewer', {
    userGlobalConfig,
    repoGlobalConfig,
    cliFlags
  })
  assert.equal(resolved.auto_fix.max_rounds, 10)
})

test('normalizeAgentSpec normalizes strings, objects, and fallback chains with defaults', () => {
  const fallbackDefaults = {
    model: 'default-model',
    effort: 'default-effort',
    timeout_ms: 30000
  }

  // 1. Single string
  assert.deepEqual(normalizeAgentSpec('claude', fallbackDefaults), [
    { harness: 'claude', model: 'default-model', effort: 'default-effort', timeout_ms: 30000 }
  ])

  // 2. Structured AgentSpec object overriding model
  assert.deepEqual(
    normalizeAgentSpec(
      { harness: 'opencode', model: 'custom-model', variant: 'variant-a' },
      fallbackDefaults
    ),
    [
      {
        harness: 'opencode',
        model: 'custom-model',
        effort: 'default-effort',
        variant: 'variant-a',
        timeout_ms: 30000
      }
    ]
  )

  // 3. Fallback chain array
  assert.deepEqual(
    normalizeAgentSpec(
      [
        'claude',
        { harness: 'acp:gemini', model: 'gemini-2.5-pro', timeout_ms: 60000 }
      ],
      fallbackDefaults
    ),
    [
      { harness: 'claude', model: 'default-model', effort: 'default-effort', timeout_ms: 30000 },
      { harness: 'acp:gemini', model: 'gemini-2.5-pro', effort: 'default-effort', timeout_ms: 60000 }
    ]
  )

  // 4. Undefined agent
  assert.deepEqual(normalizeAgentSpec(undefined, fallbackDefaults), [])
})

test('resolvePipelineConfig builds resolved configurations for all pipeline steps', () => {
  const repoGlobalConfig: OrcaNoMistakesConfig = {
    defaults: {
      agent: 'claude',
      model: 'sonnet'
    },
    stages: {
      review: {
        reviewer: { effort: 'high' }
      }
    },
    auto_fix: {
      max_rounds: 4
    }
  }

  const pipeline = resolvePipelineConfig({
    repoGlobalConfig,
    cliFlags: { intent: 'Test intent' }
  })

  assert.equal(pipeline.intent, 'Test intent')
  assert.equal(pipeline.auto_fix.max_rounds, 4)
  assert.equal(pipeline.auto_fix.enabled, true)
  assert.equal(pipeline.auto_fix.allow_review_autofix, false)

  for (const step of PIPELINE_STEPS) {
    assert.ok(pipeline.stages[step])
    assert.ok(pipeline.stages[step].reviewer)
    assert.ok(pipeline.stages[step].fixer)
    assert.equal(pipeline.stages[step].reviewer.model, 'sonnet')
    assert.equal(pipeline.stages[step].fixer.model, 'sonnet')
  }

  assert.equal(pipeline.stages.review.reviewer.effort, 'high')
  assert.equal(pipeline.stages.review.fixer.effort, undefined)
})
