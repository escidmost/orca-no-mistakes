import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
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
  DEFAULT_CONFIG_TEMPLATE,
  DefaultsConfigSchema,
  OrcaNoMistakesConfigSchema,
  RoleConfigSchema,
  StageConfigSchema,
  StagesConfigSchema,
  deepMerge,
  defaultUserConfigDir,
  defaultUserConfigPath,
  formatZodError,
  installDefaultUserConfig,
  loadUserConfig,
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
    intent: 'Refactor configuration system',
    worktree_roots: {
      '/srv/repos/project': '/srv/no-mistakes/project'
    }
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

test('guardrails resolves only from trusted-base top-level auto_fix', () => {
  // Existing projects without the key stay on fail-closed enforcement.
  assert.equal(resolveRoleConfig('test', 'fixer').auto_fix.guardrails, 'strict')
  assert.equal(resolvePipelineConfig({}).auto_fix.guardrails, 'strict')

  const userGlobalConfig: OrcaNoMistakesConfig = { auto_fix: { guardrails: 'advisory' } }
  assert.equal(resolveRoleConfig('test', 'fixer', { userGlobalConfig }).auto_fix.guardrails, 'strict')
  assert.equal(resolvePipelineConfig({ userGlobalConfig }).auto_fix.guardrails, 'strict')

  const repoWithoutGuardrails: OrcaNoMistakesConfig = { auto_fix: { enabled: false } }
  assert.equal(
    resolveRoleConfig('test', 'fixer', { userGlobalConfig, repoGlobalConfig: repoWithoutGuardrails }).auto_fix.guardrails,
    'strict'
  )
  assert.equal(
    resolvePipelineConfig({ userGlobalConfig, repoGlobalConfig: repoWithoutGuardrails }).auto_fix.guardrails,
    'strict'
  )

  const repoGlobalConfig: OrcaNoMistakesConfig = { auto_fix: { guardrails: 'advisory' } }
  assert.equal(resolveRoleConfig('test', 'fixer', { repoGlobalConfig }).auto_fix.guardrails, 'advisory')
  assert.equal(resolvePipelineConfig({ repoGlobalConfig }).auto_fix.guardrails, 'advisory')
})

test('fails closed on invalid guardrails modes and on role-level guardrails keys', () => {
  assert.throws(
    () => parseConfig({ auto_fix: { guardrails: 'permissive' } }),
    /Invalid configuration/
  )
  for (const misplaced of [
    { defaults: { auto_fix: { guardrails: 'advisory' } } },
    { stages: { test: { auto_fix: { guardrails: 'advisory' } } } },
    { stages: { test: { fixer: { auto_fix: { guardrails: 'advisory' } } } } }
  ]) {
    assert.throws(
      () => parseConfig(misplaced),
      (err: Error) => {
        assert.match(err.message, /Invalid configuration/)
        assert.match(err.message, /Unrecognized key\(s\) 'guardrails'/)
        return true
      }
    )
  }
})

test('fails closed on unknown stage names in stages configuration', () => {
  assert.throws(
    () => parseConfig({ stages: { unknown_stage_name: {} } }),
    (err: Error) => {
      assert.match(err.message, /Invalid configuration/)
      assert.match(err.message, /Unrecognized key\(s\) 'unknown_stage_name' at 'stages'/)
      return true
    }
  )
})

test('deepMerge prevents prototype pollution from __proto__ and constructor payloads', () => {
  const payload = JSON.parse('{"agent_args_override":{"__proto__":{"polluted":"yes"}}}')
  const merged = deepMerge({}, payload)
  assert.equal((Object.prototype as unknown as { polluted?: string }).polluted, undefined)
  assert.equal(({} as { polluted?: string }).polluted, undefined)
})

test('deepMerge strips unsafe keys on the clone path regardless of layer order', () => {
  const payload = JSON.parse('{"agent_args_override":{"__proto__":{"polluted":"yes"}}}')

  const fresh = deepMerge<Record<string, Record<string, unknown>>>({}, payload)
  assert.equal(Object.hasOwn(fresh.agent_args_override, '__proto__'), false)

  const layered = deepMerge<Record<string, Record<string, unknown>>>(
    { agent_args_override: { existing: [] } },
    payload
  )
  assert.equal(Object.hasOwn(layered.agent_args_override, '__proto__'), false)
})

test('allow_review_autofix: true overrides baseline in resolveRoleConfig and resolvePipelineConfig', () => {
  const repoGlobalConfig: OrcaNoMistakesConfig = {
    defaults: {
      auto_fix: { allow_review_autofix: true }
    }
  }
  const role = resolveRoleConfig('review', 'reviewer', { repoGlobalConfig })
  assert.equal(role.auto_fix.allow_review_autofix, true)

  const pipeline = resolvePipelineConfig({ repoGlobalConfig })
  assert.equal(pipeline.auto_fix.allow_review_autofix, true)
  assert.equal(pipeline.stages.review.reviewer.auto_fix.allow_review_autofix, true)
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
  assert.throws(
    () => parseConfig({ worktree_roots: { relative: '/tmp/worktrees' } }),
    /repository path must be absolute/
  )
  assert.throws(
    () => parseConfig({ worktree_roots: { '/tmp/repo': 'relative' } }),
    /worktree root must be absolute/
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

test('rejects cross-layer harness/model selection', () => {
  const userGlobalConfig: OrcaNoMistakesConfig = {
    stages: {
      review: {
        reviewer: { agent: 'codex', model: 'gpt-5.6-sol' }
      }
    }
  }
  const repoGlobalConfig: OrcaNoMistakesConfig = { defaults: { agent: 'claude' } }

  assert.throws(
    () => resolveRoleConfig('review', 'reviewer', { userGlobalConfig, repoGlobalConfig }),
    /repository defaults sets agent but would inherit model from user-global stages\.review\.reviewer/
  )

  repoGlobalConfig.defaults = { agent: { harness: 'claude', model: 'claude-sonnet-4-6' } }
  assert.doesNotThrow(() => resolveRoleConfig('review', 'reviewer', { userGlobalConfig, repoGlobalConfig }))
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

test('DEFAULT_CONFIG_TEMPLATE parses cleanly into valid OrcaNoMistakesConfig', () => {
  const parsed = parseConfigYaml(DEFAULT_CONFIG_TEMPLATE)
  assert.ok(parsed)
  assert.equal(parsed.defaults?.agent, 'claude')
  assert.equal(parsed.auto_fix?.enabled, true)
  assert.equal(parsed.auto_fix?.max_rounds, 3)
  assert.equal(parsed.auto_fix?.allow_review_autofix, false)
  assert.deepEqual(parsed.worktree_roots, {})
})

test('templates/config.yaml matches DEFAULT_CONFIG_TEMPLATE and parses validly', () => {
  const templatePath = path.join(import.meta.dirname, '..', 'templates', 'config.yaml')
  assert.ok(fs.existsSync(templatePath))
  const content = fs.readFileSync(templatePath, 'utf8')
  assert.equal(content, DEFAULT_CONFIG_TEMPLATE)
  const parsed = parseConfigYaml(content)
  assert.ok(parsed)
})

test('defaultUserConfigDir and defaultUserConfigPath respect environment overrides', () => {
  const origXdg = process.env.XDG_CONFIG_HOME
  const origCustomDir = process.env.ORCA_NO_MISTAKES_CONFIG_DIR
  const origCustomFile = process.env.ORCA_NO_MISTAKES_USER_CONFIG

  try {
    delete process.env.XDG_CONFIG_HOME
    delete process.env.ORCA_NO_MISTAKES_CONFIG_DIR
    delete process.env.ORCA_NO_MISTAKES_USER_CONFIG

    assert.match(defaultUserConfigDir(), /\.config\/orca-no-mistakes$/)
    assert.match(defaultUserConfigPath(), /\.config\/orca-no-mistakes\/config\.yaml$/)

    process.env.XDG_CONFIG_HOME = '/tmp/custom-xdg'
    assert.equal(defaultUserConfigDir(), '/tmp/custom-xdg/orca-no-mistakes')
    assert.equal(defaultUserConfigPath(), '/tmp/custom-xdg/orca-no-mistakes/config.yaml')

    process.env.ORCA_NO_MISTAKES_CONFIG_DIR = '/tmp/direct-dir'
    assert.equal(defaultUserConfigDir(), '/tmp/direct-dir')
    assert.equal(defaultUserConfigPath(), '/tmp/direct-dir/config.yaml')

    process.env.ORCA_NO_MISTAKES_USER_CONFIG = '/tmp/direct-file/custom.yaml'
    assert.equal(defaultUserConfigPath(), '/tmp/direct-file/custom.yaml')
  } finally {
    if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg
    else delete process.env.XDG_CONFIG_HOME
    if (origCustomDir !== undefined) process.env.ORCA_NO_MISTAKES_CONFIG_DIR = origCustomDir
    else delete process.env.ORCA_NO_MISTAKES_CONFIG_DIR
    if (origCustomFile !== undefined) process.env.ORCA_NO_MISTAKES_USER_CONFIG = origCustomFile
    else delete process.env.ORCA_NO_MISTAKES_USER_CONFIG
  }
})

test('loadUserConfig reads the optional user configuration', () => {
  const testDir = fs.mkdtempSync(path.join(tmpdir(), 'onm-user-config-test-'))
  const configPath = path.join(testDir, 'config.yaml')

  try {
    assert.deepEqual(loadUserConfig(configPath), {})
    fs.writeFileSync(configPath, 'defaults:\n  agent: agy\n', 'utf8')
    assert.equal(loadUserConfig(configPath).defaults?.agent, 'agy')
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true })
  }
})

test('installDefaultUserConfig writes default template and does not overwrite without force', () => {
  const testDir = fs.mkdtempSync(path.join(tmpdir(), 'onm-config-test-'))
  const targetPath = path.join(testDir, 'subdir', 'config.yaml')

  try {
    const firstResult = installDefaultUserConfig({ destinationPath: targetPath })
    assert.equal(firstResult.installed, true)
    assert.equal(firstResult.reason, 'created')
    assert.equal(firstResult.path, targetPath)
    assert.ok(fs.existsSync(targetPath))
    assert.equal(fs.readFileSync(targetPath, 'utf8'), DEFAULT_CONFIG_TEMPLATE)

    // Modify file to ensure it is not overwritten on second install
    fs.writeFileSync(targetPath, 'defaults:\n  agent: custom-agent\n', 'utf8')

    const secondResult = installDefaultUserConfig({ destinationPath: targetPath })
    assert.equal(secondResult.installed, false)
    assert.equal(secondResult.reason, 'already_exists')
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'defaults:\n  agent: custom-agent\n')

    // Force overwrite
    const forcedResult = installDefaultUserConfig({ destinationPath: targetPath, force: true })
    assert.equal(forcedResult.installed, true)
    assert.equal(forcedResult.reason, 'overwritten')
    assert.equal(fs.readFileSync(targetPath, 'utf8'), DEFAULT_CONFIG_TEMPLATE)
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true })
  }
})
