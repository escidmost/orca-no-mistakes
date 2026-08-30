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

export const GuardrailModeSchema = z.enum(['strict', 'advisory'])
export type GuardrailMode = z.infer<typeof GuardrailModeSchema>

const autoFixShape = {
  enabled: z.boolean().optional(),
  max_rounds: z.number().int().nonnegative().optional(),
  allow_review_autofix: z.boolean().optional()
}
// Guardrail mode is a run-wide trusted-policy decision, so the key exists only
// on the top-level auto_fix block; a role-level `guardrails` fails closed as
// an unrecognized key instead of being silently ignored.
export const AutoFixConfigSchema = z.strictObject({
  ...autoFixShape,
  guardrails: GuardrailModeSchema.optional()
})
export type AutoFixConfig = z.infer<typeof AutoFixConfigSchema>

const RoleAutoFixConfigSchema = z.strictObject(autoFixShape)

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
  auto_fix: RoleAutoFixConfigSchema.optional()
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
  intent: z.string().optional(),
  worktree_roots: z.record(z.string(), z.string()).superRefine((roots, context) => {
    for (const [checkout, root] of Object.entries(roots)) {
      if (!path.isAbsolute(checkout)) {
        context.addIssue({
          code: 'custom',
          message: 'repository path must be absolute',
          path: [checkout]
        })
      }
      if (!path.isAbsolute(root)) {
        context.addIssue({
          code: 'custom',
          message: 'worktree root must be absolute',
          path: [checkout]
        })
      }
    }
  }).optional()
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
  allow_review_autofix: false,
  guardrails: 'strict'
} as const

export interface ResolvedAutoFixConfig {
  enabled: boolean
  max_rounds: number
  allow_review_autofix: boolean
  guardrails: GuardrailMode
}

/**
 * Formats Zod validation issues as a concise configuration error message.
 *
 * @param error - The Zod validation error to format
 * @returns A formatted message describing the invalid configuration
 */
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

/**
 * Completes partial auto-fix settings with baseline defaults.
 *
 * @param partial - Optional auto-fix settings that override the baseline values
 * @returns Complete auto-fix settings with enabled, round limit, review auto-fix, and guardrail values
 */
function withAutoFixDefaults(partial: AutoFixConfig | undefined): ResolvedAutoFixConfig {
  return {
    enabled: partial?.enabled ?? BASELINE_AUTO_FIX.enabled,
    max_rounds: partial?.max_rounds ?? BASELINE_AUTO_FIX.max_rounds,
    allow_review_autofix: partial?.allow_review_autofix ?? BASELINE_AUTO_FIX.allow_review_autofix,
    guardrails: partial?.guardrails ?? BASELINE_AUTO_FIX.guardrails
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

/**
 * Resolves the effective configuration for a pipeline stage and role.
 *
 * Configuration layers are applied from baseline through user, repository, stage, and CLI settings, with higher-precedence values overriding lower-precedence values. Guardrail mode is taken from the repository-level auto-fix configuration or the strict baseline.
 *
 * @param stage - The pipeline stage to resolve.
 * @param role - The role whose configuration is resolved.
 * @param options - Optional user, repository, and CLI configuration sources.
 * @returns The resolved agent, execution, argument override, and auto-fix settings.
 */
export function resolveRoleConfig(
  stage: StageName,
  role: RoleName,
  options: ResolverOptions = {}
): ResolvedRoleConfig {
  const { userGlobalConfig: u, repoGlobalConfig: r, cliFlags: c } = options
  const directCli = c ? { ...c, reviewer: undefined, fixer: undefined, max_fix_rounds: undefined } : undefined

  // 5-Tier precedence layers from lowest (Tier 5: User Global) to highest (Tier 1: CLI Flags)
  const layers: [RoleConfig | undefined, string?, string?][] = [
    [{ auto_fix: { ...BASELINE_AUTO_FIX } }],
    // Tier 5: User Global
    [u?.auto_fix ? { auto_fix: u.auto_fix } : undefined],
    [u?.agent_args_override ? { agent_args_override: u.agent_args_override } : undefined],
    [extractBase(u?.defaults), 'user-global defaults', 'user-global'],
    [u?.defaults?.[role], `user-global defaults.${role}`, 'user-global'],
    [extractBase(u?.stages?.[stage]), `user-global stages.${stage}`, 'user-global'],
    [u?.stages?.[stage]?.[role], `user-global stages.${stage}.${role}`, 'user-global'],
    // Tier 4: Repo Global
    [r?.auto_fix ? { auto_fix: r.auto_fix } : undefined],
    [r?.agent_args_override ? { agent_args_override: r.agent_args_override } : undefined],
    [extractBase(r?.defaults), 'repository defaults', 'repository'],
    [r?.defaults?.[role], `repository defaults.${role}`, 'repository'],
    // Tier 3: Stage Default
    [extractBase(r?.stages?.[stage]), `repository stages.${stage}`, 'repository'],
    // Tier 2: Stage Role
    [r?.stages?.[stage]?.[role], `repository stages.${stage}.${role}`, 'repository'],
    // Tier 1: CLI Flags
    [directCli, 'CLI flags', 'CLI'],
    [c?.max_fix_rounds !== undefined ? { auto_fix: { max_rounds: c.max_fix_rounds } } : undefined],
    [c?.[role], `CLI ${role}`, 'CLI']
  ]

  const selectionKeys = ['model', 'effort', 'variant'] as const
  const selectionOrigins: Partial<
    Record<(typeof selectionKeys)[number], { name: string; source: string }>
  > = {}
  let merged: RoleConfig = {}
  for (const [config, name, source] of layers) {
    if (!config) continue
    if (config.agent !== undefined && name && source) {
      const agents = Array.isArray(config.agent) ? config.agent : [config.agent]
      const conflicts: string[] = []
      for (const key of selectionKeys) {
        const origin = selectionOrigins[key]
        const usesFallback = agents.some((agent) => typeof agent === 'string' || agent[key] === undefined)
        if (config[key] !== undefined || !usesFallback || merged[key] === undefined) continue
        if (origin?.source !== source) conflicts.push(`${key} from ${origin?.name ?? 'a lower layer'}`)
        else delete merged[key]
      }
      if (conflicts.length > 0) {
        throw new Error(`Configuration conflict: ${name} sets agent but would inherit ${conflicts.join(', ')}`)
      }
    }
    merged = deepMerge(merged, config)
    for (const key of selectionKeys) {
      if (config[key] !== undefined && name && source) selectionOrigins[key] = { name, source }
    }
  }

  return {
    agent: merged.agent,
    model: merged.model,
    effort: merged.effort,
    variant: merged.variant,
    timeout_ms: merged.timeout_ms,
    agent_args_override: merged.agent_args_override,
    auto_fix: {
      ...withAutoFixDefaults(merged.auto_fix),
      guardrails: r?.auto_fix?.guardrails ?? BASELINE_AUTO_FIX.guardrails
    }
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

/**
 * Resolves the complete pipeline configuration from user, repository, and CLI settings.
 *
 * CLI settings take precedence over repository and user settings where applicable. Auto-fix
 * guardrails are resolved from the repository configuration or the strict baseline.
 *
 * @param options - Configuration sources used to resolve pipeline settings
 * @returns The resolved intent, auto-fix policy, agent argument overrides, and per-stage role configurations
 */
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
    auto_fix: {
      ...withAutoFixDefaults(autoFix),
      guardrails: r?.auto_fix?.guardrails ?? BASELINE_AUTO_FIX.guardrails
    },
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

# Optional user-global placement for coordinator run worktrees. Keys are
# absolute registered checkout paths and values are absolute operator-owned
# directories. Repository-local config cannot choose operator placement.
worktree_roots: {}

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

  # Fixer guardrail mode: strict (default) rejects fixer commits that touch
  # protected validation policy, pre-existing tests, or test assertions;
  # advisory keeps the fixer prompt warnings and records detected changes in
  # the run evidence, gate audit, and attestation without blocking custody.
  # Run-wide and resolved from the trusted base policy; the key is rejected on
  # per-stage or per-role auto_fix blocks.
  # guardrails: strict

# ------------------------------------------------------------------------------
# Agent CLI Arguments & Environment Overrides
# ------------------------------------------------------------------------------
# Custom flags or environment variables passed to specific agent harnesses.
# Flags no-mistakes manages itself are reserved. This includes \`agy\` permission,
# prompt, print, and conversation controls, plus \`pi\` one-shot, mode, and session
# controls (including \`PI_CODING_AGENT_SESSION_DIR\`); supplying one fails the launch.
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
  # cursor -> Orca worker-start --model/--effort,
  # codex -> -c model_reasoning_effort=...,
  # claude/agy -> --effort,
  # grok -> --reasoning-effort, pi -> --thinking,
  # opencode -> inline agent variant config (model-scoped: needs a model, a raw
  # model pin, or an explicit variant),
  # acp:<target> -> acpx --model (effort is refused).
  # A raw agent_args_override flag that already pins a knob wins over this
  # value; overrides reach terminal-spawned CLI launches only - Orca native
  # workers and acp targets do not take them.
  # effort: "high"

  # Harness variant (optional)
  # variant: "default"

  # Execution timeout in milliseconds per agent invocation -- each reviewer
  # or fixer attempt is bounded independently, not the run as a whole
  # (e.g. 120000 = 2 minutes).
  # Defaults to 1800000 (30 minutes) when unset, so a stalled worker fails
  # its stage instead of hanging the run.
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
