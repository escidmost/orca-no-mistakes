import type { AgentArgsOverride } from './config.ts'

export type LaunchMode = 'acp' | 'cli' | 'native'

export const NATIVE_HARNESSES = ['claude', 'codex', 'cursor'] as const
export const CLI_HARNESSES = ['gemini', 'grok', 'opencode'] as const

const INTERRUPT_MARKER = 'esc interrupt'
const ACP_TARGET_PATTERN = /^acp:([a-zA-Z0-9_-]+)$/

export function classifyHarness(harness: string): LaunchMode {
  if (harness.startsWith('acp:')) return 'acp'
  if ((NATIVE_HARNESSES as readonly string[]).includes(harness)) return 'native'
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
  // Orca rejects creation flags (--name/--repo/--base-branch) for current/existing worktrees.
  const createsWorktree = options.worktree === 'new-child'
  const args = [
    'orchestration',
    'worker-start',
    '--task',
    options.taskId,
    '--agent',
    options.agent,
    '--worktree',
    options.worktree ?? 'new-child'
  ]
  if (options.effort && !options.model) {
    throw new Error(
      `agent ${options.agent}: effort requires a model; set a model alongside effort or drop the effort setting`
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
// and which harnesses expose no mechanism at all. Model is uniformly --model
// where a harness accepts it. Native harnesses (claude/codex/cursor) bypass
// this table: Orca worker-start owns their per-harness flags; acp:<target>
// rides acpx's own --model and exposes no effort surface.
const EFFORT_KNOBS: Record<string, { flag: string; requiresModel?: boolean }> = {
  agy: { flag: '--effort' },
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
  return equals < 0 ? arg : arg.slice(0, equals)
}

function pinsAnyFlag(args: string[], flags: string[]): boolean {
  return args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))
}

// Flags no-mistakes manages itself for a harness. agent_args_override entries
// may not supply them; always-present flags are appended after override args so
// they cannot be dropped or reordered away.
const RESERVED_HARNESS_ARGS: Record<string, ReadonlySet<string>> = {
  agy: new Set(['--dangerously-skip-permissions', '--prompt-interactive', '-i']),
}
const REQUIRED_HARNESS_ARGS: Record<string, readonly string[]> = {
  agy: ['--dangerously-skip-permissions'],
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export type CliAgentCommandOptions = AgentProfile & {
  agentArgsOverride?: AgentArgsOverride
  variant?: string
}

export function buildCliCommand(harness: string, options: CliAgentCommandOptions = {}): string {
  const env: string[] = []
  const parts: string[] = [harness]
  const override = options.agentArgsOverride?.[harness]
  if (override && !Array.isArray(override)) {
    for (const [key, value] of Object.entries(override)) {
      if (!ENV_NAME_PATTERN.test(key)) {
        throw new Error(
          `agent ${harness}: invalid environment variable name '${key}' in agent_args_override`
        )
      }
      env.push(`${key}=${shellQuote(value)}`)
    }
  }
  const raw = Array.isArray(override) ? override : []
  const effortKnob = EFFORT_KNOBS[harness]
  if (options.effort && !effortKnob) {
    throw new Error(
      `agent ${harness}: cannot express effort; no verified reasoning-effort flag exists for it (use agent_args_override.${harness} if your build accepts one)`
    )
  }
  // Model-scoped effort carriers (--variant) need their model; an explicit
  // variant option supersedes the effort knob by one declared precedence rule.
  if (options.effort && effortKnob?.requiresModel && !options.model && !options.variant) {
    throw new Error(
      `agent ${harness}: cannot express effort without a model; ${effortKnob.flag} selects a model-scoped variant`
    )
  }
  if (options.model && !pinsAnyFlag(raw, MODEL_PIN_FLAGS)) parts.push('--model', options.model)
  if (effortKnob?.requiresModel) {
    const variant = options.variant ?? options.effort
    if (variant && !pinsAnyFlag(raw, [effortKnob.flag])) parts.push(effortKnob.flag, variant)
  } else if (effortKnob && options.effort && !pinsAnyFlag(raw, EFFORT_PIN_FLAGS)) {
    parts.push(effortKnob.flag, options.effort)
  }
  const reserved = RESERVED_HARNESS_ARGS[harness]
  if (reserved) {
    for (const arg of raw) {
      if (reserved.has(flagName(arg))) {
        throw new Error(`agent ${harness}: reserved argument '${arg}' cannot be overridden`)
      }
    }
  }
  parts.push(...raw)
  parts.push(...(REQUIRED_HARNESS_ARGS[harness] ?? []))
  // Environment assignments stay unquoted as a prefix; arguments are shell-quoted individually.
  return [...env, ...parts.map(shellQuote)].join(' ')
}

export type TerminalView = { preview?: string | null; title?: string | null }

export function readinessMatcher(
  harness: string
): (terminal: TerminalView) => boolean {
  const normalizedHarness = harness.toLowerCase()
  if (normalizedHarness === 'opencode') {
    return ({ preview, title }) =>
      (title === 'OpenCode' || title?.startsWith('OC |') === true) &&
      !(preview ?? '').includes(INTERRUPT_MARKER)
  }
  if (normalizedHarness === 'agy') {
    return ({ preview, title }) =>
      /\b(?:agy|antigravity)\b/i.test(title ?? '') && !(preview ?? '').includes(INTERRUPT_MARKER)
  }
  const pattern = new RegExp(`\\b${escapeRegExp(harness)}\\b`, 'i')
  return ({ preview, title }) => pattern.test(title ?? '') && !(preview ?? '').includes(INTERRUPT_MARKER)
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
// the worker prompt asks for.
export function acpRunnerInvocation(options: {
  effort?: string
  model?: string
  prompt: string
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
  args.push(options.target, 'exec')
  args.push(options.prompt)
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
// fish spells it `fish: Unknown command: <name>`. Only safe alongside the
// harness-name anchoring below: unanchored it would swallow a CLI's own
// "unknown command '<subcommand>'" usage errors.
const SHELL_BINARY_MISSING_PATTERN = /\bENOENT\b|command not found|unknown command/i

// Startup readiness observers see shell/terminal text, so a missing harness
// binary surfaces as printed output rather than a spawn error. Only a line that
// names the harness itself counts: shell rc noise and agent banners routinely
// report other missing binaries, and treating those as a failed launch would
// abort a healthy harness under the wrong failure class.
export function isBinaryMissingOutput(text: string, harness: string): boolean {
  const named = new RegExp(`\\b${escapeRegExp(harness)}\\b`, 'i')
  return text
    .split('\n')
    .some((line) => SHELL_BINARY_MISSING_PATTERN.test(line) && named.test(line))
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

function lastBareJsonObject(text: string): unknown | undefined {
  let best: unknown
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
            if (parsed && typeof parsed === 'object') best = parsed
          } catch {}
          start = -1
        }
      }
    }
  }
  return best
}

// Extracts a structured result from agent text: direct JSON first, then closed
// JSON fences, then unclosed tails, then the last bare JSON object. More than
// one valid closed fence is ambiguous and yields undefined rather than a guess.
export function extractStructuredJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text.trim())
  } catch {}
  const { closed, open } = fencedJsonCandidates(text)
  for (const candidates of [closed, open]) {
    const parsed: unknown[] = []
    for (const candidate of candidates) {
      try {
        parsed.push(JSON.parse(candidate.trim()))
      } catch {}
    }
    if (parsed.length > 1) return undefined
    if (parsed.length === 1) return parsed[0]
  }
  return lastBareJsonObject(text)
}
