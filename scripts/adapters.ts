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
  grok: { flag: '--reasoning-effort' },
  opencode: { flag: '--variant', requiresModel: true },
  pi: { flag: '--thinking' },
}
const UNMAPPABLE_HARNESSES = new Set(['agy'])

// A knob already pinned through a raw agent_args_override flag wins, so the
// mapped value is not emitted and no harness receives one knob twice.
const MODEL_PIN_FLAGS = ['-m', '--model']
const EFFORT_PIN_FLAGS = ['--effort', '--reasoning-effort', '--thinking']

function pinsAnyFlag(args: string[], flags: string[]): boolean {
  return args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))
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
  const unmappable = UNMAPPABLE_HARNESSES.has(harness)
  const effortKnob = EFFORT_KNOBS[harness]
  if ((options.model || options.effort || options.variant) && unmappable) {
    throw new Error(
      `agent ${harness}: cannot express model or effort; no verified mechanism exists for it (use agent_args_override.${harness} if your build accepts a flag)`
    )
  }
  if (options.effort && !effortKnob && !unmappable) {
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
  parts.push(...raw)
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
  const pattern = new RegExp(`\\b${harness.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
  return ({ preview, title }) => pattern.test(title ?? '') && !(preview ?? '').includes(INTERRUPT_MARKER)
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

const PREFLIGHT_PATTERNS: [RegExp, PreflightFailureClass][] = [
  [/\bENOENT\b|command not found/i, 'binary-missing'],
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
