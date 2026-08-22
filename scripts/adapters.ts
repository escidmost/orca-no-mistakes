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

const VARIANT_FLAGS: Record<string, string> = { opencode: '--variant' }

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export type CliAgentCommandOptions = {
  agentArgsOverride?: AgentArgsOverride
  effort?: string
  model?: string
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
  if (options.model) parts.push('--model', options.model)
  const variantFlag = VARIANT_FLAGS[harness]
  const variant = options.variant ?? (options.model ? options.effort : undefined)
  if (variant && variantFlag) parts.push(variantFlag, variant)
  if (Array.isArray(override)) parts.push(...override)
  // Environment assignments stay unquoted as a prefix; arguments are shell-quoted individually.
  return [...env, ...parts.map(shellQuote)].join(' ')
}

export type TerminalView = { preview?: string | null; title?: string | null }

export function readinessMatcher(
  harness: string
): (terminal: TerminalView) => boolean {
  if (harness === 'opencode') {
    return ({ preview, title }) =>
      (title === 'OpenCode' || title?.startsWith('OC |') === true) &&
      !(preview ?? '').includes(INTERRUPT_MARKER)
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
  model?: string
  prompt: string
  target: string
  timeoutMs?: number
}): AcpRunnerInvocation {
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
