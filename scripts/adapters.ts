import type { AgentArgsOverride } from './config.ts'

export type LaunchMode = 'acp' | 'cli' | 'native'

export const NATIVE_HARNESSES = ['cursor'] as const
export const CLI_HARNESSES = ['claude', 'codex', 'gemini', 'grok', 'kimi', 'opencode'] as const
const KNOWN_HARNESSES = new Set<string>([
  ...NATIVE_HARNESSES,
  ...CLI_HARNESSES,
  'agy',
  'pi'
])

const INTERRUPT_MARKER = 'esc interrupt'
const ACP_TARGET_PATTERN = /^acp:([a-zA-Z0-9_-]+)$/i

function normalizeKnownHarness(harness: string): string {
  const normalized = harness.toLowerCase()
  return KNOWN_HARNESSES.has(normalized) ? normalized : harness
}

export function classifyHarness(harness: string): LaunchMode {
  const normalized = harness.toLowerCase()
  if (normalized.startsWith('acp:')) return 'acp'
  if ((NATIVE_HARNESSES as readonly string[]).includes(normalized)) return 'native'
  return 'cli'
}

export function parseAcpTarget(harness: string): string {
  const match = ACP_TARGET_PATTERN.exec(harness)
  if (!match) throw new Error(`invalid ACP harness '${harness}': expected acp:<target>`)
  return match[1]
}

export type NativeWorkerStartOptions = {
  agent: string
  baseBranch?: string
  effort?: string
  model?: string
  name?: string
  repoRoot?: string
  runId?: string
  taskId: string
  timeoutMs?: number
  worktree?: 'current' | 'new-child'
}

export function nativeWorkerStartArgs(options: NativeWorkerStartOptions): string[] {
  const agent = normalizeKnownHarness(options.agent)
  // Orca rejects creation flags (--name/--repo/--base-branch) for current/existing worktrees.
  const createsWorktree = options.worktree === 'new-child'
  const args = [
    'orchestration',
    'worker-start',
    '--task',
    options.taskId,
    '--agent',
    agent,
    '--worktree',
    options.worktree ?? 'new-child'
  ]
  if (options.effort && !options.model) {
    throw new Error(
      `agent ${agent}: effort requires a model; set a model alongside effort or drop the effort setting`
    )
  }
  if (options.model) args.push('--model', options.model)
  if (options.effort) args.push('--effort', options.effort)
  if (options.timeoutMs !== undefined) args.push('--timeout-ms', String(options.timeoutMs))
  if (createsWorktree && options.name) args.push('--name', options.name)
  if (createsWorktree && options.repoRoot) args.push('--repo', `path:${options.repoRoot}`)
  if (createsWorktree && options.baseBranch) args.push('--base-branch', options.baseBranch)
  if (options.runId) args.push('--run', options.runId)
  args.push('--json')
  return args
}

// Harness-neutral model/reasoning-effort selection: what an operator asked
// for once, before it is mapped down to whatever mechanism a harness uses.
export type AgentProfile = {
  effort?: string
  model?: string
}

// One table: how each terminal-launched harness expresses reasoning effort,
// and which harnesses expose no mechanism at all. OpenCode's variant is mapped
// to inline agent config below because its interactive TUI has no --variant.
// Model is uniformly --model where a harness accepts it. Native harnesses (cursor) bypass
// this table: Orca worker-start owns their per-harness flags; acp:<target>
// rides acpx's own --model and exposes no effort surface.
const EFFORT_KNOBS: Record<string, { flag: string; requiresModel?: boolean }> = {
  agy: { flag: '--effort' },
  claude: { flag: '--effort' },
  codex: { flag: '-c' },
  grok: { flag: '--reasoning-effort' },
  opencode: { flag: '--variant', requiresModel: true },
  pi: { flag: '--thinking' },
}

// A knob already pinned through a raw agent_args_override flag wins, so the
// mapped value is not emitted and no harness receives one knob twice.
const MODEL_PIN_FLAGS = ['-m', '--model']
const EFFORT_PIN_FLAGS = ['--effort', '--reasoning-effort', '--thinking']

// A reserved flag stays reserved when joined to its value as --flag=value.
function flagName(arg: string): string {
  const equals = arg.indexOf('=')
  if (equals >= 0) return arg.slice(0, equals)
  return /^-[A-Za-z].+/.test(arg) && !arg.startsWith('--') ? arg.slice(0, 2) : arg
}

function flagValue(args: string[], flags: string[]): string | undefined {
  let found: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') break
    for (const flag of flags) {
      let value: string | undefined | null = null
      if (arg.startsWith(`${flag}=`)) {
        value = arg.slice(flag.length + 1)
      } else if (flag.length === 2 && arg.startsWith(flag) && arg.length > 2) {
        value = arg.slice(2).replace(/^=/, '')
      } else if (arg === flag) {
        value = args[++i]
      }
      if (value === null) continue
      if (!value || value.startsWith('-')) throw new Error(`argument ${flag} requires a value`)
      if (found !== undefined) throw new Error(`argument ${flag} may only be specified once`)
      found = value
      break
    }
  }
  return found
}

function pinsAnyFlag(args: string[], flags: string[]): boolean {
  return flagValue(args, flags) !== undefined
}

function withoutFlag(args: string[], flag: string): string[] {
  const filtered: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') return [...filtered, ...args.slice(i)]
    if (arg === flag) {
      if (args[i + 1] && !args[i + 1].startsWith('-')) i += 1
      continue
    }
    if (arg.startsWith(`${flag}=`)) continue
    filtered.push(arg)
  }
  return filtered
}

function opencodeConfigContent(
  existing: string | undefined,
  agent: string,
  model: string | undefined,
  variant: string,
): string {
  let config: Record<string, unknown> = {}
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      config = parsed as Record<string, unknown>
    } catch {
      throw new Error('agent opencode: OPENCODE_CONFIG_CONTENT must be a JSON object')
    }
  }
  const agents =
    config.agent && typeof config.agent === 'object' && !Array.isArray(config.agent)
      ? (config.agent as Record<string, unknown>)
      : {}
  const current =
    agents[agent] && typeof agents[agent] === 'object' && !Array.isArray(agents[agent])
      ? (agents[agent] as Record<string, unknown>)
      : {}
  return JSON.stringify({
    ...config,
    agent: {
      ...agents,
      [agent]: { ...current, ...(model ? { model } : {}), variant },
    },
  })
}

function pinsConfigKey(args: string[], key: string): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') break
    const config = configOverride(args, i)
    if (config?.key !== key) continue
    const value = config.value
    if (!value || value === '""' || value === "''") {
      throw new Error(`agent codex: config override ${key} requires a nonempty value`)
    }
    return true
  }
  return false
}

function configOverride(
  args: string[],
  index: number
): { key: string; value: string } | undefined {
  const arg = args[index]
  const assignment =
    arg === '-c' || arg === '--config'
    ? args[index + 1]
    : arg.startsWith('-c') && arg.length > 2
      ? arg.slice(2).replace(/^=/, '')
      : arg.startsWith('--config=')
        ? arg.slice(9)
        : undefined
  const equals = assignment?.indexOf('=') ?? -1
  if (!assignment || equals < 0) return undefined
  return {
    key: assignment.slice(0, equals).trim(),
    value: assignment.slice(equals + 1).trim(),
  }
}

// Flags no-mistakes manages itself for a harness. agent_args_override entries
// may not supply them; always-present flags are appended after override args so
// they cannot be dropped or reordered away.
const RESERVED_HARNESS_ARGS: Record<string, ReadonlySet<string>> = {
  agy: new Set([
    '--continue',
    '--conversation',
    '--dangerously-skip-permissions',
    '--print',
    '--prompt',
    '--prompt-interactive',
    '--sandbox',
    '-c',
    '-i',
    '-p',
  ]),
  claude: new Set([
    '--allow-dangerously-skip-permissions',
    '--dangerously-skip-permissions',
    '--permission-mode',
  ]),
  codex: new Set([
    '--ask-for-approval',
    '--dangerously-bypass-approvals-and-sandbox',
    '--profile',
    '--sandbox',
    '-a',
    '-p',
    '-s',
  ]),
  kimi: new Set(['--auto', '--plan', '--prompt', '--yolo', '-p']),
  pi: new Set([
    '--continue',
    '--export',
    '--fork',
    '--list-models',
    '--mode',
    '--no-session',
    '--print',
    '--resume',
    '--session',
    '--session-dir',
    '--session-id',
    '-c',
    '-p',
    '-r',
  ]),
}
const RESERVED_CONFIG_KEYS: Record<string, ReadonlySet<string>> = {
  codex: new Set(['approval_policy', 'sandbox_mode', 'sandbox_permissions']),
}
const REQUIRED_HARNESS_ARGS: Record<string, readonly string[]> = {
  agy: ['--dangerously-skip-permissions'],
  claude: ['--dangerously-skip-permissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox'],
  kimi: ['--auto'],
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export type CliAgentCommandOptions = AgentProfile & {
  agentArgsOverride?: AgentArgsOverride
  variant?: string
}

function agentArgsOverrideForHarness(
  overrides: AgentArgsOverride | undefined,
  harness: string
): AgentArgsOverride[string] | undefined {
  let match: AgentArgsOverride[string] | undefined
  const keys = new Map<string, string>()
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const normalizedKey = key.toLowerCase()
    const existing = keys.get(normalizedKey)
    if (existing) {
      throw new Error(
        `agent_args_override contains duplicate harness keys '${existing}' and '${key}'`
      )
    }
    keys.set(normalizedKey, key)
    if (normalizedKey === harness.toLowerCase()) match = value
  }
  return match
}

export function buildCliCommand(harness: string, options: CliAgentCommandOptions = {}): string {
  const normalizedHarness = normalizeKnownHarness(harness)
  const env: string[] = []
  const parts: string[] = [normalizedHarness]
  const override = agentArgsOverrideForHarness(options.agentArgsOverride, normalizedHarness)
  const overrideEnv = override && !Array.isArray(override) ? override : undefined
  if (override && !Array.isArray(override)) {
    for (const [key, value] of Object.entries(override)) {
      if (!ENV_NAME_PATTERN.test(key)) {
        throw new Error(
          `agent ${normalizedHarness}: invalid environment variable name '${key}' in agent_args_override`
        )
      }
      if (normalizedHarness === 'pi' && key === 'PI_CODING_AGENT_SESSION_DIR') {
        throw new Error(`agent pi: reserved environment variable '${key}' cannot be overridden`)
      }
      env.push(`${key}=${shellQuote(value)}`)
    }
  }
  let raw = Array.isArray(override) ? override : []
  if (normalizedHarness === 'agy' && raw.includes('--')) {
    throw new Error(
      `agent ${normalizedHarness}: option terminator '--' cannot precede the managed prompt carrier`
    )
  }
  const effortKnob = EFFORT_KNOBS[normalizedHarness]
  const modelPinned =
    pinsAnyFlag(raw, MODEL_PIN_FLAGS) ||
    (normalizedHarness === 'codex' && pinsConfigKey(raw, 'model'))
  const effortPinned =
    normalizedHarness === 'codex'
      ? pinsConfigKey(raw, 'model_reasoning_effort')
      : pinsAnyFlag(raw, EFFORT_PIN_FLAGS)
  if (options.effort && !effortKnob) {
    throw new Error(
      `agent ${normalizedHarness}: cannot express effort; no verified reasoning-effort flag exists for it (use agent_args_override.${normalizedHarness} if your build accepts one)`
    )
  }
  // Model-scoped effort carriers (--variant) need their model, supplied either
  // as an option or as a raw agent_args_override pin; an explicit variant
  // option supersedes the effort knob by one declared precedence rule.
  if (
    options.effort &&
    effortKnob?.requiresModel &&
    !options.model &&
    !modelPinned &&
    !options.variant
  ) {
    throw new Error(
      `agent ${normalizedHarness}: cannot express effort without a model; ${effortKnob.flag} selects a model-scoped variant`
    )
  }
  if (options.model && !modelPinned) parts.push('--model', options.model)
  if (normalizedHarness === 'opencode') {
    const model = flagValue(raw, MODEL_PIN_FLAGS) ?? options.model
    if (model !== undefined && !/^[^/\s]+(?:\/[^/\s]+)+$/.test(model)) {
      throw new Error(
        `agent opencode: invalid model '${model}'; expected provider/model (for example openai/gpt-6-astra). Specify the provider explicitly; no provider is selected automatically`,
      )
    }
    const variant = flagValue(raw, ['--variant']) ?? options.variant ?? options.effort
    if (variant) {
      const agent = flagValue(raw, ['--agent']) ?? 'build'
      const existingConfig = overrideEnv?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT
      const existingConfigIndex = env.findIndex((entry) =>
        entry.startsWith('OPENCODE_CONFIG_CONTENT='),
      )
      if (existingConfigIndex >= 0) env.splice(existingConfigIndex, 1)
      env.push(
        `OPENCODE_CONFIG_CONTENT=${shellQuote(opencodeConfigContent(existingConfig, agent, model, variant))}`,
      )
      if (!flagValue(raw, ['--agent'])) parts.push('--agent', agent)
      raw = withoutFlag(raw, '--variant')
    }
  } else if (effortKnob?.requiresModel) {
    const variant = options.variant ?? options.effort
    if (variant && !pinsAnyFlag(raw, [effortKnob.flag])) parts.push(effortKnob.flag, variant)
  } else if (effortKnob && options.effort && !effortPinned) {
    const effort =
      normalizedHarness === 'codex'
        ? `model_reasoning_effort=${JSON.stringify(options.effort)}`
        : options.effort
    parts.push(effortKnob.flag, effort)
  }
  const reserved = RESERVED_HARNESS_ARGS[normalizedHarness]
  const reservedConfig = RESERVED_CONFIG_KEYS[normalizedHarness]
  if (reserved) {
    for (let index = 0; index < raw.length; index++) {
      const arg = raw[index]
      if (arg === '--') break
      if (reserved.has(flagName(arg))) {
        throw new Error(`agent ${normalizedHarness}: reserved argument '${arg}' cannot be overridden`)
      }
      const config = configOverride(raw, index)
      const configKey = config?.key
      if (configKey && reservedConfig?.has(configKey)) {
        throw new Error(
          `agent ${normalizedHarness}: reserved config '${configKey}' cannot be overridden`
        )
      }
    }
  }
  parts.push(...(REQUIRED_HARNESS_ARGS[normalizedHarness] ?? []))
  parts.push(...raw)
  // Environment assignments stay unquoted as a prefix; arguments are shell-quoted individually.
  return [...env, ...parts.map(shellQuote)].join(' ')
}

export type TerminalView = { preview?: string | null; title?: string | null }

export function harnessTitleMatcher(harness: string): (title?: string | null) => boolean {
  const normalizedHarness = harness.toLowerCase()
  if (normalizedHarness === 'opencode') {
    return (title) => title === 'OpenCode' || title?.startsWith('OC |') === true
  }
  if (normalizedHarness === 'agy') {
    return (title) => /\b(?:agy|antigravity)\b/i.test(title ?? '')
  }
  if (normalizedHarness === 'pi') {
    return (title) => title?.startsWith('π - ') === true || /\bpi\b/i.test(title ?? '')
  }
  const pattern = new RegExp(`\\b${escapeRegExp(harness)}\\b`, 'i')
  return (title) => pattern.test(title ?? '')
}

export function readinessMatcher(
  harness: string
): (terminal: TerminalView) => boolean {
  const normalizedHarness = harness.toLowerCase()
  const titleTaken = harnessTitleMatcher(harness)
  return ({ preview, title }) => {
    const output = preview ?? ''
    const codexActive =
      normalizedHarness === 'codex' &&
      /\bWorking\s*\(\s*\d+\s*s\b/.test(output) &&
      /›[\s\S]{0,500}\s[^\s·]+\s+(?:minimal|low|medium|high|xhigh|max|ultra)\s*(?:·|$)/i.test(output)
    return (titleTaken(title) || codexActive) && !output.includes(INTERRUPT_MARKER)
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function workerAgentReadyTimeoutMs(): number {
  const raw = Number(process.env.WORKER_AGENT_READY_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000
}

export type AcpRunnerInvocation = { args: string[] }

// Grounded against `acpx --help`: agents are positional subcommands and
// --format/--approve-all/--model/--timeout are global options the subcommand parser does not accept,
// so they precede the target. `exec` is the one-shot sub-subcommand; the default action instead
// resolves a persistent cwd-keyed session and throws when none exists. `--format json` is an NDJSON
// event stream; `quiet` emits the final assistant message on stdout, which is the single JSON report
// the worker prompt asks for. The prompt itself rides stdin via `exec --file -`: a full worker
// prompt in argv can exceed OS argument-size limits, and stdin delivery lets a failed write
// surface the child's own stderr instead of a bare EOF.
export function acpRunnerInvocation(options: {
  effort?: string
  model?: string
  target: string
  timeoutMs?: number
}): AcpRunnerInvocation {
  // acpx exposes --model but no reasoning-effort surface; refuse rather than
  // silently drop the knob.
  if (options.effort) {
    throw new Error(
      `agent acp:${options.target}: cannot express effort; acpx exposes a model surface but no reasoning-effort control`
    )
  }
  const args = ['--format', 'quiet', '--approve-all']
  if (options.model) args.push('--model', options.model)
  if (options.timeoutMs !== undefined) {
    args.push('--timeout', String(Math.max(1, Math.ceil(options.timeoutMs / 1000))))
  }
  args.push(options.target, 'exec', '--file', '-')
  return { args }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export type ResidualResources = { terminalHandles: string[]; worktreeIds: string[] }

export type PreflightFailureClass =
  | 'auth'
  | 'binary-missing'
  | 'quota'
  | 'readiness-timeout'
  | 'unclassified'

// Thrown only for failures that happen before a candidate accepts the task
// (launch, startup readiness, initial dispatch). Execution-phase task errors
// stay plain Errors so they never advance a fallback chain.
export class PreflightError extends Error {
  readonly failureClass: PreflightFailureClass

  constructor(failureClass: PreflightFailureClass, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PreflightError'
    this.failureClass = failureClass
  }
}

const BINARY_MISSING_PATTERN = /\bENOENT\b|command not found/i

// Startup readiness observers see shell/terminal text, so a missing harness
// binary surfaces as printed output rather than a spawn error. Only a line that
// names the harness itself counts: shell rc noise and agent banners routinely
// report other missing binaries, and treating those as a failed launch would
// abort a healthy harness under the wrong failure class. fish spells it
// `fish: Unknown command: <name>`, so that wording requires the harness name
// immediately after the phrase — a CLI's own `<name>: unknown command '<sub>'`
// usage error names itself first and must not read as a missing binary.
export function isBinaryMissingOutput(text: string, harness: string): boolean {
  const name = escapeRegExp(harness)
  const named = new RegExp(`\\b${name}\\b`, 'i')
  const unknownCommand = new RegExp(`unknown command:?\\s*['"\`]?${name}\\b`, 'i')
  return text
    .split('\n')
    .some(
      (line) => unknownCommand.test(line) || (BINARY_MISSING_PATTERN.test(line) && named.test(line))
    )
}

const PREFLIGHT_PATTERNS: [RegExp, PreflightFailureClass][] = [
  [BINARY_MISSING_PATTERN, 'binary-missing'],
  [/\b429\b|rate.?limit|quota|resource.?exhausted/i, 'quota'],
  [/unauthorized|authentication|credential|not logged in|api key|login required|permission denied/i, 'auth'],
]

export function classifyPreflightFailure(message: string): PreflightFailureClass {
  const normalized = message.toLowerCase()
  if (/did not become ready|terminal exited during startup|terminal disconnected during startup|startup readiness/.test(normalized)) {
    return 'readiness-timeout'
  }
  for (const [pattern, failureClass] of PREFLIGHT_PATTERNS) {
    if (pattern.test(message)) return failureClass
  }
  return 'unclassified'
}

// worker-start failure receipts report leaked resources under `residualResources`; the shape is not
// pinned by the CLI contract, so match both keyed fields and kind/type-tagged entries.
export function collectResidualResources(value: unknown): ResidualResources {
  const terminalHandles = new Set<string>()
  const worktreeIds = new Set<string>()
  const visit = (node: unknown, kind?: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, kind)
      return
    }
    if (node === null || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    const tag =
      typeof record.kind === 'string' ? record.kind : typeof record.type === 'string' ? record.type : kind
    if (typeof record.terminalHandle === 'string' && record.terminalHandle) {
      terminalHandles.add(record.terminalHandle)
    }
    if (typeof record.worktreeId === 'string' && record.worktreeId) worktreeIds.add(record.worktreeId)
    const identifier =
      typeof record.handle === 'string' ? record.handle : typeof record.id === 'string' ? record.id : undefined
    if (identifier && tag) {
      if (tag.toLowerCase().includes('terminal')) terminalHandles.add(identifier)
      if (tag.toLowerCase().includes('worktree')) worktreeIds.add(identifier)
    }
    for (const [key, child] of Object.entries(record)) {
      if (child === null || typeof child !== 'object') continue
      const lowered = key.toLowerCase()
      visit(
        child,
        lowered.includes('terminal') ? 'terminal' : lowered.includes('worktree') ? 'worktree' : undefined
      )
    }
  }
  visit(value)
  return { terminalHandles: [...terminalHandles], worktreeIds: [...worktreeIds] }
}

export type AgyStreamUsage = {
  cacheCreationReported?: boolean
  cacheCreationTokens?: number
  cacheReadTokens?: number
  inputTokens?: number
  outputTokens?: number
  reasoningReported?: boolean
  reasoningTokens?: number
}

export type AgyStreamResult = { error?: string; text: string; usage: AgyStreamUsage }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function applyAgyUsagePatch(usage: AgyStreamUsage, patch: Record<string, unknown>): void {
  const numeric = (key: string): number | undefined => {
    const value = patch[key]
    return typeof value === 'number' ? value : undefined
  }
  const inputTokens = numeric('input_tokens')
  if (inputTokens !== undefined) usage.inputTokens = inputTokens
  const outputTokens = numeric('output_tokens')
  if (outputTokens !== undefined) usage.outputTokens = outputTokens
  const cacheReadTokens = numeric('cache_read_tokens')
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
  const cacheCreationTokens = numeric('cache_creation_tokens')
  if (cacheCreationTokens !== undefined) {
    usage.cacheCreationTokens = cacheCreationTokens
    usage.cacheCreationReported = true
  }
  // Presence, not the value, marks reasoning as reported so a genuine zero
  // stays distinguishable from a harness that never exposes the field.
  if ('thinking_tokens' in patch) {
    usage.reasoningReported = true
    const thinkingTokens = numeric('thinking_tokens')
    if (thinkingTokens !== undefined) usage.reasoningTokens = thinkingTokens
  }
}

// Parses the NDJSON emitted by `agy --output-format stream-json`. Each line is
// an event record dispatched on its top-level `event` field: `step_update`
// streams text deltas and per-step usage; `result` carries the terminal status,
// authoritative usage, optional `response`, and optional `structured_output`.
// Malformed or unrecognized lines are skipped. Final text precedence is
// structured_output > response > accumulated deltas.
export function parseAgyStream(jsonl: string): AgyStreamResult {
  let streamText = ''
  let response = ''
  let structured = ''
  let error: string | undefined
  const usage: AgyStreamUsage = {}
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event: Record<string, unknown> | undefined
    try {
      event = asRecord(JSON.parse(trimmed))
    } catch {
      continue
    }
    if (!event) continue
    if (event.event === 'step_update') {
      const payload = asRecord(event.step_update)
      if (!payload) continue
      if (typeof payload.text_delta === 'string') streamText += payload.text_delta
      const stepUsage = asRecord(payload.usage)
      if (stepUsage) applyAgyUsagePatch(usage, stepUsage)
    } else if (event.event === 'result') {
      const payload = asRecord(event.result)
      if (!payload) continue
      if (payload.status === 'ERROR') {
        error =
          typeof payload.error === 'string' && payload.error.trim()
            ? payload.error
            : 'unknown error'
      }
      if (typeof payload.response === 'string' && payload.response) response = payload.response
      const resultUsage = asRecord(payload.usage)
      if (resultUsage) applyAgyUsagePatch(usage, resultUsage)
      if (payload.structured_output !== undefined && payload.structured_output !== null) {
        structured = JSON.stringify(payload.structured_output)
      }
    }
  }
  const text = [structured, response, streamText].find((value) => value !== '') ?? ''
  return { error, text: text.trim(), usage }
}

type FenceCandidates = { closed: string[]; open: string[] }

// Scans ```json fences anywhere in the text, including glued to preceding
// content on the same line. Only a bare ``` closes a block; a marker carrying
// an info string is an opener, so prose that quotes ```json cannot swallow the
// real block that follows it — the later opener restarts the span instead.
// Closed-fence bodies are collected separately from unclosed tails running to
// end-of-text.
function fencedJsonCandidates(text: string): FenceCandidates {
  const closed: string[] = []
  const open: string[] = []
  const marker = /```([A-Za-z0-9_-]*)/g
  let contentStart = -1
  for (let match = marker.exec(text); match; match = marker.exec(text)) {
    const info = match[1].toLowerCase()
    if (info) {
      contentStart = info === 'json' ? match.index + match[0].length : -1
      continue
    }
    if (contentStart >= 0) {
      closed.push(text.slice(contentStart, match.index))
      contentStart = -1
    }
  }
  if (contentStart >= 0) open.push(text.slice(contentStart))
  return { closed, open }
}

function lastBareJsonObject(
  text: string,
  accept?: (value: unknown) => boolean
): unknown | undefined {
  let best: unknown
  const seen = new Set<string>()
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === '}') {
      if (depth > 0) {
        depth -= 1
        if (depth === 0 && start >= 0) {
          try {
            const parsed: unknown = JSON.parse(text.slice(start, index + 1))
            if (parsed && typeof parsed === 'object' && accept?.(parsed) !== false) {
              seen.add(JSON.stringify(parsed))
              best = parsed
            }
          } catch {}
          start = -1
        }
      }
    }
  }
  return seen.size > 1 ? undefined : best
}

// Extracts a structured result from agent text: direct JSON first, then closed
// JSON fences, then unclosed tails, then the last bare JSON object. Candidates
// that disagree are ambiguous at every layer and yield undefined rather than a
// guess; repeated identical values are not a disagreement. When `accept` is
// given, only candidates it approves count toward ambiguity: a thinking model
// whose stream interleaves reasoning that quotes JSON (schema fragments,
// examples) before the real payload still yields that payload, while two
// approved-but-different values keep failing closed.
export function extractStructuredJson(
  text: string,
  accept?: (value: unknown) => boolean
): unknown | undefined {
  try {
    return JSON.parse(text.trim())
  } catch {}
  const { closed, open } = fencedJsonCandidates(text)
  for (const candidates of [closed, open]) {
    const distinct = new Map<string, unknown>()
    for (const candidate of candidates) {
      try {
        const value: unknown = JSON.parse(candidate.trim())
        if (accept?.(value) !== false) distinct.set(JSON.stringify(value), value)
      } catch {}
    }
    if (distinct.size > 1) return undefined
    if (distinct.size === 1) return [...distinct.values()][0]
  }
  return lastBareJsonObject(text, accept)
}
