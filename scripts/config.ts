import { z } from 'zod'
import YAML from 'yaml'
import { PIPELINE_STEPS, type StageName } from './orca-no-mistakes.ts'

export const ROLES = ['reviewer', 'fixer'] as const
export type RoleName = (typeof ROLES)[number]

export const AgentSpecSchema = z.strictObject({
  harness: z.string().min(1),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  variant: z.string().min(1).optional(),
  timeout_ms: z.number().int().positive().optional()
})
export type AgentSpec = z.infer<typeof AgentSpecSchema>

export const AgentEntrySchema = z.union([
  z.string().min(1),
  AgentSpecSchema
])
export type AgentEntry = z.infer<typeof AgentEntrySchema>

export const AgentConfigSchema = z.union([
  AgentEntrySchema,
  z.array(AgentEntrySchema).nonempty()
])
export type AgentConfig = z.infer<typeof AgentConfigSchema>

export const AutoFixConfigSchema = z.strictObject({
  enabled: z.boolean().optional(),
  max_rounds: z.number().int().nonnegative().optional(),
  allow_review_autofix: z.boolean().optional()
})
export type AutoFixConfig = z.infer<typeof AutoFixConfigSchema>

export const AgentArgsOverrideSchema = z.record(
  z.string(),
  z.union([
    z.array(z.string()),
    z.record(z.string(), z.string())
  ])
)
export type AgentArgsOverride = z.infer<typeof AgentArgsOverrideSchema>

export const RoleConfigSchema = z.strictObject({
  agent: AgentConfigSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  variant: z.string().min(1).optional(),
  timeout_ms: z.number().int().positive().optional(),
  agent_args_override: AgentArgsOverrideSchema.optional(),
  auto_fix: AutoFixConfigSchema.optional()
})
export type RoleConfig = z.infer<typeof RoleConfigSchema>

export const StageConfigSchema = z.strictObject({
  agent: AgentConfigSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  variant: z.string().min(1).optional(),
  timeout_ms: z.number().int().positive().optional(),
  agent_args_override: AgentArgsOverrideSchema.optional(),
  auto_fix: AutoFixConfigSchema.optional(),
  reviewer: RoleConfigSchema.optional(),
  fixer: RoleConfigSchema.optional()
})
export type StageConfig = z.infer<typeof StageConfigSchema>

export const DefaultsConfigSchema = StageConfigSchema
export type DefaultsConfig = z.infer<typeof DefaultsConfigSchema>

export const StagesConfigSchema = z.strictObject({
  intent: StageConfigSchema.optional(),
  rebase: StageConfigSchema.optional(),
  review: StageConfigSchema.optional(),
  test: StageConfigSchema.optional(),
  document: StageConfigSchema.optional(),
  lint: StageConfigSchema.optional(),
  push: StageConfigSchema.optional(),
  pr: StageConfigSchema.optional(),
  ci: StageConfigSchema.optional()
})
export type StagesConfig = z.infer<typeof StagesConfigSchema>

export const OrcaNoMistakesConfigSchema = z.strictObject({
  defaults: DefaultsConfigSchema.optional(),
  stages: StagesConfigSchema.optional(),
  auto_fix: AutoFixConfigSchema.optional(),
  agent_args_override: AgentArgsOverrideSchema.optional(),
  intent: z.string().optional()
})
export type OrcaNoMistakesConfig = z.infer<typeof OrcaNoMistakesConfigSchema>

export const CliFlagsSchema = z.strictObject({
  agent: AgentConfigSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  variant: z.string().min(1).optional(),
  timeout_ms: z.number().int().positive().optional(),
  max_fix_rounds: z.number().int().nonnegative().optional(),
  auto_fix: AutoFixConfigSchema.optional(),
  agent_args_override: AgentArgsOverrideSchema.optional(),
  intent: z.string().optional(),
  reviewer: RoleConfigSchema.optional(),
  fixer: RoleConfigSchema.optional()
})
export type CliFlags = z.infer<typeof CliFlagsSchema>

export const BASELINE_AUTO_FIX = {
  enabled: true,
  max_rounds: 3,
  allow_review_autofix: false
} as const

export function formatZodError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.join('.')
    if (issue.code === 'unrecognized_keys') {
      const keys = ((issue as unknown as { keys?: string[] }).keys ?? []).map((k: string) => `'${k}'`).join(', ')
      return path ? `Unrecognized key(s) ${keys} at '${path}'` : `Unrecognized key(s) ${keys}`
    }
    return path ? `Invalid value at '${path}': ${issue.message}` : issue.message
  })
  return `Invalid configuration: ${issues.join('; ')}`
}

export function parseConfig(input: unknown): OrcaNoMistakesConfig {
  if (input === null || input === undefined) {
    return {}
  }
  const result = OrcaNoMistakesConfigSchema.safeParse(input)
  if (!result.success) {
    throw new Error(formatZodError(result.error))
  }
  return result.data
}

export function parseConfigYaml(yamlStr: string): OrcaNoMistakesConfig {
  const trimmed = yamlStr.trim()
  if (!trimmed) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = YAML.parse(yamlStr)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`YAML parse error: ${msg}`)
  }
  return parseConfig(parsed)
}

export function deepMerge<T = unknown>(target: unknown, source: unknown): T {
  if (source === undefined) {
    return clone(target) as T
  }
  if (target === undefined) {
    return clone(source) as T
  }
  if (
    typeof target !== 'object' ||
    target === null ||
    Array.isArray(target) ||
    typeof source !== 'object' ||
    source === null ||
    Array.isArray(source)
  ) {
    return clone(source) as T
  }

  const result: Record<string, unknown> = {}
  const targetObj = target as Record<string, unknown>
  const sourceObj = source as Record<string, unknown>

  for (const key of Object.keys(targetObj)) {
    if (targetObj[key] !== undefined) {
      result[key] = clone(targetObj[key])
    }
  }

  for (const key of Object.keys(sourceObj)) {
    const sourceVal = sourceObj[key]
    if (sourceVal !== undefined) {
      if (key in result && result[key] !== undefined) {
        result[key] = deepMerge(result[key], sourceVal)
      } else {
        result[key] = clone(sourceVal)
      }
    }
  }

  return result as T
}

function clone<T>(val: T): T {
  if (val === null || typeof val !== 'object') {
    return val
  }
  if (Array.isArray(val)) {
    return val.map((item) => clone(item)) as unknown as T
  }
  const res: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (v !== undefined) {
      res[k] = clone(v)
    }
  }
  return res as unknown as T
}

function extractBaseRoleFields(config: StageConfig | DefaultsConfig | undefined): RoleConfig {
  if (!config) return {}
  const { reviewer, fixer, ...base } = config
  return base
}

export interface ResolverOptions {
  userGlobalConfig?: OrcaNoMistakesConfig
  repoGlobalConfig?: OrcaNoMistakesConfig
  cliFlags?: CliFlags
}

export interface ResolvedRoleConfig {
  agent?: AgentConfig
  model?: string
  effort?: string
  variant?: string
  timeout_ms?: number
  agent_args_override?: AgentArgsOverride
  auto_fix: {
    enabled: boolean
    max_rounds: number
    allow_review_autofix: boolean
  }
}

export function resolveRoleConfig(
  stage: StageName,
  role: RoleName,
  options: ResolverOptions = {}
): ResolvedRoleConfig {
  const { userGlobalConfig, repoGlobalConfig, cliFlags } = options

  // Baseline layer
  let resolved: RoleConfig = {
    auto_fix: { ...BASELINE_AUTO_FIX }
  }

  // Tier 5: User Global Config (~/.config/orca-no-mistakes/config.yaml)
  if (userGlobalConfig) {
    // 5a. User global defaults & top-level auto_fix / agent_args_override
    resolved = deepMerge(resolved, {
      auto_fix: userGlobalConfig.auto_fix,
      agent_args_override: userGlobalConfig.agent_args_override
    })
    resolved = deepMerge(resolved, extractBaseRoleFields(userGlobalConfig.defaults))
    // 5b. User global role-specific defaults
    if (userGlobalConfig.defaults?.[role]) {
      resolved = deepMerge(resolved, userGlobalConfig.defaults[role])
    }
    // 5c. User global stage defaults
    if (userGlobalConfig.stages?.[stage]) {
      resolved = deepMerge(resolved, extractBaseRoleFields(userGlobalConfig.stages[stage]))
      // 5d. User global stage role overrides
      if (userGlobalConfig.stages[stage]?.[role]) {
        resolved = deepMerge(resolved, userGlobalConfig.stages[stage]![role])
      }
    }
  }

  // Tier 4: Repository Global Config (.orca/no-mistakes.yaml)
  if (repoGlobalConfig) {
    // 4a. Repo global defaults & top-level auto_fix / agent_args_override
    resolved = deepMerge(resolved, {
      auto_fix: repoGlobalConfig.auto_fix,
      agent_args_override: repoGlobalConfig.agent_args_override
    })
    resolved = deepMerge(resolved, extractBaseRoleFields(repoGlobalConfig.defaults))
    // 4b. Repo global role-specific defaults
    if (repoGlobalConfig.defaults?.[role]) {
      resolved = deepMerge(resolved, repoGlobalConfig.defaults[role])
    }
  }

  // Tier 3: Stage Default Config (stages.<stage>)
  if (repoGlobalConfig?.stages?.[stage]) {
    resolved = deepMerge(resolved, extractBaseRoleFields(repoGlobalConfig.stages[stage]))
  }

  // Tier 2: Stage Role Config (stages.<stage>.<role>)
  if (repoGlobalConfig?.stages?.[stage]?.[role]) {
    resolved = deepMerge(resolved, repoGlobalConfig.stages[stage]![role])
  }

  // Tier 1: CLI Flags (Highest precedence)
  if (cliFlags) {
    const { max_fix_rounds, reviewer, fixer, ...directCli } = cliFlags
    resolved = deepMerge(resolved, directCli)
    if (max_fix_rounds !== undefined) {
      resolved = deepMerge(resolved, { auto_fix: { max_rounds: max_fix_rounds } })
    }
    const roleCli = role === 'reviewer' ? reviewer : fixer
    if (roleCli) {
      resolved = deepMerge(resolved, roleCli)
    }
  }

  return {
    agent: resolved.agent,
    model: resolved.model,
    effort: resolved.effort,
    variant: resolved.variant,
    timeout_ms: resolved.timeout_ms,
    agent_args_override: resolved.agent_args_override,
    auto_fix: {
      enabled: resolved.auto_fix?.enabled ?? BASELINE_AUTO_FIX.enabled,
      max_rounds: resolved.auto_fix?.max_rounds ?? BASELINE_AUTO_FIX.max_rounds,
      allow_review_autofix: resolved.auto_fix?.allow_review_autofix ?? BASELINE_AUTO_FIX.allow_review_autofix
    }
  }
}

export interface ResolvedPipelineConfig {
  intent?: string
  auto_fix: {
    enabled: boolean
    max_rounds: number
    allow_review_autofix: boolean
  }
  agent_args_override: AgentArgsOverride
  stages: Record<StageName, {
    reviewer: ResolvedRoleConfig
    fixer: ResolvedRoleConfig
  }>
}

export function resolvePipelineConfig(options: ResolverOptions = {}): ResolvedPipelineConfig {
  const { userGlobalConfig, repoGlobalConfig, cliFlags } = options

  let rootAutoFix: AutoFixConfig = { ...BASELINE_AUTO_FIX }
  let rootAgentArgs: AgentArgsOverride = {}

  if (userGlobalConfig?.auto_fix) {
    rootAutoFix = deepMerge(rootAutoFix, userGlobalConfig.auto_fix)
  }
  if (userGlobalConfig?.agent_args_override) {
    rootAgentArgs = deepMerge(rootAgentArgs, userGlobalConfig.agent_args_override)
  }
  if (repoGlobalConfig?.auto_fix) {
    rootAutoFix = deepMerge(rootAutoFix, repoGlobalConfig.auto_fix)
  }
  if (repoGlobalConfig?.agent_args_override) {
    rootAgentArgs = deepMerge(rootAgentArgs, repoGlobalConfig.agent_args_override)
  }
  if (cliFlags?.auto_fix) {
    rootAutoFix = deepMerge(rootAutoFix, cliFlags.auto_fix)
  }
  if (cliFlags?.max_fix_rounds !== undefined) {
    rootAutoFix = deepMerge(rootAutoFix, { max_rounds: cliFlags.max_fix_rounds })
  }
  if (cliFlags?.agent_args_override) {
    rootAgentArgs = deepMerge(rootAgentArgs, cliFlags.agent_args_override)
  }

  const intent = cliFlags?.intent ?? repoGlobalConfig?.intent ?? userGlobalConfig?.intent

  const stages = {} as Record<StageName, { reviewer: ResolvedRoleConfig; fixer: ResolvedRoleConfig }>
  for (const stage of PIPELINE_STEPS) {
    stages[stage] = {
      reviewer: resolveRoleConfig(stage, 'reviewer', options),
      fixer: resolveRoleConfig(stage, 'fixer', options)
    }
  }

  return {
    intent,
    auto_fix: {
      enabled: rootAutoFix.enabled ?? BASELINE_AUTO_FIX.enabled,
      max_rounds: rootAutoFix.max_rounds ?? BASELINE_AUTO_FIX.max_rounds,
      allow_review_autofix: rootAutoFix.allow_review_autofix ?? BASELINE_AUTO_FIX.allow_review_autofix
    },
    agent_args_override: rootAgentArgs,
    stages
  }
}

export function normalizeAgentSpec(
  agent: AgentConfig | undefined,
  fallbackDefaults?: { model?: string; effort?: string; variant?: string; timeout_ms?: number }
): AgentSpec[] {
  if (!agent) {
    return []
  }
  const entries = Array.isArray(agent) ? agent : [agent]
  return entries.map((entry) => {
    if (typeof entry === 'string') {
      const spec: AgentSpec = { harness: entry }
      if (fallbackDefaults?.model) spec.model = fallbackDefaults.model
      if (fallbackDefaults?.effort) spec.effort = fallbackDefaults.effort
      if (fallbackDefaults?.variant) spec.variant = fallbackDefaults.variant
      if (fallbackDefaults?.timeout_ms) spec.timeout_ms = fallbackDefaults.timeout_ms
      return spec
    }
    const spec: AgentSpec = {
      harness: entry.harness,
      model: entry.model ?? fallbackDefaults?.model,
      effort: entry.effort ?? fallbackDefaults?.effort,
      variant: entry.variant ?? fallbackDefaults?.variant,
      timeout_ms: entry.timeout_ms ?? fallbackDefaults?.timeout_ms
    }
    const cleanSpec: AgentSpec = { harness: spec.harness }
    if (spec.model !== undefined) cleanSpec.model = spec.model
    if (spec.effort !== undefined) cleanSpec.effort = spec.effort
    if (spec.variant !== undefined) cleanSpec.variant = spec.variant
    if (spec.timeout_ms !== undefined) cleanSpec.timeout_ms = spec.timeout_ms
    return cleanSpec
  })
}
