import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import YAML from 'yaml'

export const PIPELINE_STEPS = ['intent', 'rebase', 'review', 'test', 'document', 'lint'] as const
export type StageName = (typeof PIPELINE_STEPS)[number]

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

export const AgentEntrySchema = z.union([z.string().min(1), AgentSpecSchema])
export type AgentEntry = z.infer<typeof AgentEntrySchema>

export const AgentConfigSchema = z.union([AgentEntrySchema, z.array(AgentEntrySchema).nonempty()])
export type AgentConfig = z.infer<typeof AgentConfigSchema>

export const AutoFixConfigSchema = z.strictObject({
  enabled: z.boolean().optional(),
  max_rounds: z.number().int().nonnegative().optional(),
  allow_review_autofix: z.boolean().optional()
})
export type AutoFixConfig = z.infer<typeof AutoFixConfigSchema>

export const AgentArgsOverrideSchema = z.record(
  z.string(),
  z.union([z.array(z.string()), z.record(z.string(), z.string())])
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

export const StageConfigSchema = RoleConfigSchema.extend({
  reviewer: RoleConfigSchema.optional(),
  fixer: RoleConfigSchema.optional()
})
export type StageConfig = z.infer<typeof StageConfigSchema>

export const DefaultsConfigSchema = StageConfigSchema
export type DefaultsConfig = z.infer<typeof DefaultsConfigSchema>

export const StagesConfigSchema = z.strictObject(
  Object.fromEntries(PIPELINE_STEPS.map((s) => [s, StageConfigSchema.optional()])) as Record<
    StageName,
    ReturnType<typeof StageConfigSchema.optional>
  >
)
export type StagesConfig = z.infer<typeof StagesConfigSchema>

export const OrcaNoMistakesConfigSchema = z.strictObject({
  defaults: DefaultsConfigSchema.optional(),
  stages: StagesConfigSchema.optional(),
  auto_fix: AutoFixConfigSchema.optional(),
  agent_args_override: AgentArgsOverrideSchema.optional(),
  intent: z.string().optional()
})
export type OrcaNoMistakesConfig = z.infer<typeof OrcaNoMistakesConfigSchema>

export const CliFlagsSchema = RoleConfigSchema.extend({
  max_fix_rounds: z.number().int().nonnegative().optional(),
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

export interface ResolvedAutoFixConfig {
  enabled: boolean
  max_rounds: number
  allow_review_autofix: boolean
}

export function formatZodError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.join('.')
    if (issue.code === 'unrecognized_keys') {
      const keys = issue.keys.map((k: string) => `'${k}'`).join(', ')
      return path ? `Unrecognized key(s) ${keys} at '${path}'` : `Unrecognized key(s) ${keys}`
    }
    return path ? `Invalid value at '${path}': ${issue.message}` : issue.message
  })
  return `Invalid configuration: ${issues.join('; ')}`
}

export function parseConfig(input: unknown): OrcaNoMistakesConfig {
  if (input === null || input === undefined) return {}
  const result = OrcaNoMistakesConfigSchema.safeParse(input)
  if (!result.success) throw new Error(formatZodError(result.error))
  return result.data
}

export function parseConfigYaml(yamlStr: string): OrcaNoMistakesConfig {
  if (!yamlStr.trim()) return {}
  try {
    return parseConfig(YAML.parse(yamlStr))
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Invalid configuration:')) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`YAML parse error: ${msg}`)
  }
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function cloneSafe<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) return value.map((item) => cloneSafe(item)) as T
  if (value === null || typeof value !== 'object') return structuredClone(value) as T
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(key)) continue
    out[key] = cloneSafe(val)
  }
  return out as T
}

export function deepMerge<T = unknown>(target: unknown, source: unknown): T {
  if (source === undefined) return target !== undefined ? cloneSafe<T>(target) : (undefined as T)
  if (
    target === undefined ||
    typeof target !== 'object' ||
    target === null ||
    Array.isArray(target) ||
    typeof source !== 'object' ||
    source === null ||
    Array.isArray(source)
  ) {
    return cloneSafe<T>(source)
  }

  const result: Record<string, unknown> = cloneSafe<Record<string, unknown>>(target)
  for (const [key, val] of Object.entries(source as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(key)) continue
    if (val !== undefined) {
      result[key] = Object.hasOwn(result, key) && result[key] !== undefined ? deepMerge(result[key], val) : cloneSafe(val)
    }
  }
  return result as T
}

function extractBase(config: StageConfig | DefaultsConfig | undefined): RoleConfig | undefined {
  if (!config) return undefined
  const { reviewer, fixer, ...base } = config
  return base
}

function withAutoFixDefaults(partial: AutoFixConfig | undefined): ResolvedAutoFixConfig {
  return {
    enabled: partial?.enabled ?? BASELINE_AUTO_FIX.enabled,
    max_rounds: partial?.max_rounds ?? BASELINE_AUTO_FIX.max_rounds,
    allow_review_autofix: partial?.allow_review_autofix ?? BASELINE_AUTO_FIX.allow_review_autofix
  }
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
  auto_fix: ResolvedAutoFixConfig
}

export function resolveRoleConfig(
  stage: StageName,
  role: RoleName,
  options: ResolverOptions = {}
): ResolvedRoleConfig {
  const { userGlobalConfig: u, repoGlobalConfig: r, cliFlags: c } = options
  const directCli = c ? { ...c, reviewer: undefined, fixer: undefined, max_fix_rounds: undefined } : undefined

  // 5-Tier precedence layers from lowest (Tier 5: User Global) to highest (Tier 1: CLI Flags)
  const layers: (RoleConfig | undefined)[] = [
    { auto_fix: { ...BASELINE_AUTO_FIX } },
    // Tier 5: User Global
    u?.auto_fix ? { auto_fix: u.auto_fix } : undefined,
    u?.agent_args_override ? { agent_args_override: u.agent_args_override } : undefined,
    extractBase(u?.defaults),
    u?.defaults?.[role],
    extractBase(u?.stages?.[stage]),
    u?.stages?.[stage]?.[role],
    // Tier 4: Repo Global
    r?.auto_fix ? { auto_fix: r.auto_fix } : undefined,
    r?.agent_args_override ? { agent_args_override: r.agent_args_override } : undefined,
    extractBase(r?.defaults),
    r?.defaults?.[role],
    // Tier 3: Stage Default
    extractBase(r?.stages?.[stage]),
    // Tier 2: Stage Role
    r?.stages?.[stage]?.[role],
    // Tier 1: CLI Flags
    directCli,
    c?.max_fix_rounds !== undefined ? { auto_fix: { max_rounds: c.max_fix_rounds } } : undefined,
    c?.[role]
  ]

  const merged = layers.reduce<RoleConfig>((acc, layer) => (layer ? deepMerge(acc, layer) : acc), {})

  return {
    agent: merged.agent,
    model: merged.model,
    effort: merged.effort,
    variant: merged.variant,
    timeout_ms: merged.timeout_ms,
    agent_args_override: merged.agent_args_override,
    auto_fix: withAutoFixDefaults(merged.auto_fix)
  }
}

export interface ResolvedPipelineConfig {
  intent?: string
  auto_fix: ResolvedAutoFixConfig
  agent_args_override: AgentArgsOverride
  stages: Record<StageName, {
    reviewer: ResolvedRoleConfig
    fixer: ResolvedRoleConfig
  }>
}

export function resolvePipelineConfig(options: ResolverOptions = {}): ResolvedPipelineConfig {
  const { userGlobalConfig: u, repoGlobalConfig: r, cliFlags: c } = options
  const autoFix = [
    { ...BASELINE_AUTO_FIX },
    u?.auto_fix,
    u?.defaults?.auto_fix,
    r?.auto_fix,
    r?.defaults?.auto_fix,
    c?.auto_fix,
    c?.max_fix_rounds !== undefined ? { max_rounds: c.max_fix_rounds } : undefined
  ].reduce<AutoFixConfig>((acc, item) => (item ? deepMerge(acc, item) : acc), {})

  const agentArgs = [
    u?.agent_args_override,
    u?.defaults?.agent_args_override,
    r?.agent_args_override,
    r?.defaults?.agent_args_override,
    c?.agent_args_override
  ].reduce<AgentArgsOverride>((acc, item) => (item ? deepMerge(acc, item) : acc), {})

  const stages = Object.fromEntries(
    PIPELINE_STEPS.map((stage) => [
      stage,
      {
        reviewer: resolveRoleConfig(stage, 'reviewer', options),
        fixer: resolveRoleConfig(stage, 'fixer', options)
      }
    ])
  ) as Record<StageName, { reviewer: ResolvedRoleConfig; fixer: ResolvedRoleConfig }>

  return {
    intent: c?.intent ?? r?.intent ?? u?.intent,
    auto_fix: withAutoFixDefaults(autoFix),
    agent_args_override: agentArgs,
    stages
  }
}

export function normalizeAgentSpec(
  agent: AgentConfig | undefined,
  fallbackDefaults?: Partial<AgentSpec>
): AgentSpec[] {
  if (!agent) return []
  const list = Array.isArray(agent) ? agent : [agent]
  return list.map((item) => {
    const base = typeof item === 'string' ? { harness: item } : item
    return Object.fromEntries(
      Object.entries({ ...fallbackDefaults, ...base }).filter(([_, v]) => v !== undefined)
    ) as unknown as AgentSpec
  })
}

export const DEFAULT_CONFIG_TEMPLATE = `# ==============================================================================
# orca-no-mistakes Configuration Template
# ==============================================================================
# Location: ~/.config/orca-no-mistakes/config.yaml (User Global)
#           .orca/no-mistakes.yaml (Repository Global)
#
# Note: The configuration uses strict schema validation (Zod). Any unrecognized
# keys will cause the runner to fail closed.
# ==============================================================================

# Optional default task intent or objective statement
# intent: "Ensure zero regressions and complete test coverage"

# ------------------------------------------------------------------------------
# Global Auto-Fix Settings
# ------------------------------------------------------------------------------
auto_fix:
  # Master toggle for automatic repair attempts across stages (default: true)
  enabled: true

  # Maximum number of fix/retry rounds before requiring human intervention (default: 3)
  max_rounds: 3

  # Whether to allow auto-fixing during the review stage (default: false)
  # Keeping this false prevents circular automated reviewer-fixer churn (ADR-0007).
  allow_review_autofix: false

# ------------------------------------------------------------------------------
# Agent CLI Arguments & Environment Overrides
# ------------------------------------------------------------------------------
# Custom flags or environment variables passed to specific agent harnesses.
# Flags no-mistakes manages itself are reserved: an \`agy\` entry supplying
# --dangerously-skip-permissions, --prompt-interactive, or -i fails the launch.
# agent_args_override:
#   opencode:
#     - "--agent"
#     - "custom-reviewer"
#   gemini:
#     TEMPERATURE: "0.2"

# ------------------------------------------------------------------------------
# Global Defaults
# ------------------------------------------------------------------------------
# These settings apply to all pipeline stages unless overridden.
defaults:
  # Default agent harness. Can be:
  # 1. Shorthand string: "claude", "opencode", "gemini"
  # 2. Structured object: { harness: "claude", model: "claude-3-7-sonnet", effort: "high" }
  # 3. Fallback chain array: ["claude", { harness: "opencode", model: "sonnet" }]
  agent: "claude"

  # Optional model override
  # model: "claude-3-7-sonnet"

  # Reasoning effort (e.g. "low", "medium", "high"). Mapped per harness:
  # claude/codex/cursor -> Orca worker-start --model/--effort,
  # grok -> --reasoning-effort, pi -> --thinking,
  # opencode -> --variant (model-scoped: needs a model, a raw model pin, or
  # an explicit variant),
  # agy -> --effort, acp:<target> -> acpx --model (effort is refused).
  # A raw agent_args_override flag that already pins a knob wins over this
  # value; overrides reach terminal-spawned CLI launches only - Orca native
  # workers and acp targets do not take them.
  # effort: "high"

  # Harness variant (optional)
  # variant: "default"

  # Execution timeout in milliseconds per stage (e.g. 120000 = 2 minutes)
  # timeout_ms: 120000

  # Role-specific default overrides across all stages
  # reviewer:
  #   agent: { harness: "opencode", model: "claude-3-7-sonnet" }
  #   effort: "high"
  #   timeout_ms: 180000

  # fixer:
  #   agent: "claude"
  #   effort: "medium"
  #   timeout_ms: 120000

# ------------------------------------------------------------------------------
# Stage-Specific Overrides
# ------------------------------------------------------------------------------
# Supported stages: intent, rebase, review, test, document, lint
# stages:
#   intent:
#     agent: "claude"
#     timeout_ms: 60000
#
#   rebase:
#     timeout_ms: 60000
#
#   review:
#     reviewer:
#       effort: "high"
#       timeout_ms: 240000
#     fixer:
#       effort: "high"
#
#   test:
#     reviewer:
#       timeout_ms: 300000
#     fixer:
#       timeout_ms: 180000
#
#   document:
#     agent: "claude"
#     effort: "medium"
#
#   lint:
#     timeout_ms: 60000
`

export function defaultUserConfigDir(): string {
  if (process.env.ORCA_NO_MISTAKES_CONFIG_DIR) {
    return process.env.ORCA_NO_MISTAKES_CONFIG_DIR
  }
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'orca-no-mistakes')
  }
  return path.join(homedir(), '.config', 'orca-no-mistakes')
}

export function defaultUserConfigPath(): string {
  if (process.env.ORCA_NO_MISTAKES_USER_CONFIG) {
    return process.env.ORCA_NO_MISTAKES_USER_CONFIG
  }
  return path.join(defaultUserConfigDir(), 'config.yaml')
}

export function loadUserConfig(configPath = defaultUserConfigPath()): OrcaNoMistakesConfig {
  if (!fs.existsSync(configPath)) return {}
  return parseConfigYaml(fs.readFileSync(configPath, 'utf8'))
}

export interface InstallConfigOptions {
  destinationPath?: string
  force?: boolean
  templateContent?: string
}

export interface InstallConfigResult {
  installed: boolean
  path: string
  reason?: 'already_exists' | 'created' | 'overwritten'
}

export function installDefaultUserConfig(options: InstallConfigOptions = {}): InstallConfigResult {
  const targetPath = options.destinationPath ?? defaultUserConfigPath()
  const content = options.templateContent ?? DEFAULT_CONFIG_TEMPLATE
  const targetDir = path.dirname(targetPath)

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  const exists = fs.existsSync(targetPath)
  if (exists && !options.force) {
    return {
      installed: false,
      path: targetPath,
      reason: 'already_exists'
    }
  }

  fs.writeFileSync(targetPath, content, 'utf8')
  return {
    installed: true,
    path: targetPath,
    reason: exists ? 'overwritten' : 'created'
  }
}
