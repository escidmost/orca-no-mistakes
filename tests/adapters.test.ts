import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acpRunnerInvocation,
  buildCliCommand,
  classifyHarness,
  collectResidualResources,
  nativeWorkerStartArgs,
  parseAcpTarget,
  readinessMatcher,
  shellQuote,
  workerAgentReadyTimeoutMs
} from '../scripts/adapters.ts'

test('classifyHarness routes native, CLI, and ACP harnesses', () => {
  assert.equal(classifyHarness('claude'), 'native')
  assert.equal(classifyHarness('codex'), 'native')
  assert.equal(classifyHarness('cursor'), 'native')
  assert.equal(classifyHarness('opencode'), 'cli')
  assert.equal(classifyHarness('grok'), 'cli')
  assert.equal(classifyHarness('gemini'), 'cli')
  assert.equal(classifyHarness('future-cli-agent'), 'cli')
  assert.equal(classifyHarness('acp:gemini-dev'), 'acp')
})

test('parseAcpTarget extracts valid targets and rejects malformed harnesses', () => {
  assert.equal(parseAcpTarget('acp:claude-code'), 'claude-code')
  assert.equal(parseAcpTarget('acp:gemini_2-dev'), 'gemini_2-dev')
  assert.throws(() => parseAcpTarget('acp:'), /invalid ACP harness 'acp:'/)
  assert.throws(() => parseAcpTarget('acp:bad target!'), /invalid ACP harness/)
  assert.throws(() => parseAcpTarget('opencode'), /invalid ACP harness/)
})

test('nativeWorkerStartArgs maps model, effort, timeout, and worktree placement', () => {
  const reviewer = nativeWorkerStartArgs({
    agent: 'claude',
    baseBranch: 'feature',
    effort: 'high',
    model: 'claude-opus-4',
    name: 'no-mistakes-review-1',
    repoRoot: '/repo',
    runId: 'run-1',
    taskId: 'task-9',
    timeoutMs: 45000,
    worktree: 'new-child'
  })
  assert.deepEqual(reviewer, [
    'orchestration',
    'worker-start',
    '--task',
    'task-9',
    '--agent',
    'claude',
    '--worktree',
    'new-child',
    '--model',
    'claude-opus-4',
    '--effort',
    'high',
    '--timeout-ms',
    '45000',
    '--name',
    'no-mistakes-review-1',
    '--repo',
    'path:/repo',
    '--base-branch',
    'feature',
    '--run',
    'run-1',
    '--json'
  ])

  const fixer = nativeWorkerStartArgs({
    agent: 'codex',
    effort: 'high',
    model: 'gpt-5.6',
    name: 'ignored-for-current',
    repoRoot: '/repo',
    taskId: 'task-2',
    worktree: 'current'
  })
  // Creation flags are rejected for current worktrees.
  assert.ok(!fixer.includes('--name'))
  assert.ok(!fixer.includes('path:/repo'))
  assert.ok(!fixer.includes('--base-branch'))
  assert.ok(fixer.includes('--worktree'))
  assert.ok(fixer.includes('current'))

  // Effort requires a model per the Orca worker-start contract.
  assert.throws(
    () => nativeWorkerStartArgs({ agent: 'cursor', effort: 'high', taskId: 't' }),
    /agent cursor: effort requires a model/
  )
})

test('buildCliCommand formats startup lines with model, variant, env, and override args', () => {
  assert.equal(buildCliCommand('opencode'), `'opencode'`)
  assert.equal(
    buildCliCommand('opencode', { model: 'gpt-5.6', variant: 'high' }),
    `'opencode' '--model' 'gpt-5.6' '--variant' 'high'`
  )
  assert.equal(
    buildCliCommand('opencode', { effort: 'high', model: 'gpt-5.6' }),
    `'opencode' '--model' 'gpt-5.6' '--variant' 'high'`
  )
  // Variant is opencode-specific.
  assert.equal(buildCliCommand('grok', { model: 'grok-4', variant: 'high' }), `'grok' '--model' 'grok-4'`)
  assert.equal(buildCliCommand('gemini', { model: 'gemini-3-pro' }), `'gemini' '--model' 'gemini-3-pro'`)
  // Effort maps per harness through one table.
  assert.equal(
    buildCliCommand('grok', { effort: 'high', model: 'grok-4' }),
    `'grok' '--model' 'grok-4' '--reasoning-effort' 'high'`
  )
  assert.equal(buildCliCommand('pi', { effort: 'high' }), `'pi' '--thinking' 'high'`)
  const pinnedPi = buildCliCommand('pi', {
    agentArgsOverride: { pi: ['--thinking', 'low'] } as never,
    effort: 'high'
  })
  assert.equal(pinnedPi, `'pi' '--thinking' 'low'`)
  // Effort is refused rather than silently dropped where a harness has no mechanism.
  assert.throws(() => buildCliCommand('gemini', { model: 'm', effort: 'high' }), /cannot express effort/)
  // opencode variants are model-scoped: effort without a model is refused, but
  // an explicit variant option supersedes the effort knob.
  assert.throws(
    () => buildCliCommand('opencode', { effort: 'high' }),
    /cannot express effort without a model/
  )
  assert.equal(
    buildCliCommand('opencode', { effort: 'medium', variant: 'high' }),
    `'opencode' '--variant' 'high'`
  )
  assert.throws(
    () => buildCliCommand('agy', { effort: 'high', model: 'm' }),
    /cannot express model or effort/
  )
  // A raw override flag that already pins a knob wins over the profile value.
  const pinned = buildCliCommand('grok', {
    agentArgsOverride: { grok: ['--reasoning-effort', 'low', '-m', 'other'] } as never,
    effort: 'high',
    model: 'grok-4'
  })
  assert.equal(pinned, `'grok' '--reasoning-effort' 'low' '-m' 'other'`)
  const pinnedVariant = buildCliCommand('opencode', {
    agentArgsOverride: { opencode: ['--variant=low'] } as never,
    effort: 'high',
    model: 'gpt-5.6'
  })
  assert.equal(pinnedVariant, `'opencode' '--model' 'gpt-5.6' '--variant=low'`)
  // Unknown harnesses keep the legacy --model passthrough.
  assert.equal(buildCliCommand('mycli', { model: 'm1' }), `'mycli' '--model' 'm1'`)

  const overridden = buildCliCommand('opencode', {
    agentArgsOverride: { opencode: { OPENCODE_MODEL: 'custom' }, grok: ['--verbose'] } as never,
    model: 'm'
  })
  assert.match(overridden, /^OPENCODE_MODEL='custom' 'opencode'/)
  assert.ok(!overridden.includes('--verbose'), 'override entries apply per harness')

  const extra = buildCliCommand('grok', {
    agentArgsOverride: { grok: ['--dangerously-auto', '-q'] } as never
  })
  assert.equal(extra, `'grok' '--dangerously-auto' '-q'`)
})

test('buildCliCommand rejects environment names that would break out of the assignment prefix', () => {
  assert.throws(
    () =>
      buildCliCommand('opencode', {
        agentArgsOverride: { opencode: { 'X=1; touch pwned #': 'v' } } as never
      }),
    /invalid environment variable name/
  )
  assert.throws(
    () => buildCliCommand('opencode', { agentArgsOverride: { opencode: { '1BAD': 'v' } } as never }),
    /invalid environment variable name/
  )
  assert.equal(
    buildCliCommand('opencode', { agentArgsOverride: { opencode: { _OK9: 'v' } } as never }),
    `_OK9='v' 'opencode'`
  )
})

test('readinessMatcher matches per-harness terminal titles and rejects interrupts', () => {
  const opencode = readinessMatcher('opencode')
  assert.equal(opencode({ title: 'OpenCode', preview: 'prompt' }), true)
  assert.equal(opencode({ title: 'OC | OpenCode Discussion', preview: '' }), true)
  assert.equal(opencode({ title: 'bash', preview: 'ready' }), false)
  assert.equal(opencode({ title: 'OpenCode', preview: 'esc interrupt active' }), false)
  assert.equal(opencode({ title: null, preview: null }), false)

  const grok = readinessMatcher('grok')
  assert.equal(grok({ title: 'Grok CLI', preview: 'ready' }), true)
  assert.equal(grok({ title: 'GROK session', preview: 'esc interrupt' }), false)
  assert.equal(grok({ title: 'zsh', preview: '' }), false)

  const gemini = readinessMatcher('gemini')
  assert.equal(gemini({ title: 'Gemini', preview: 'ok' }), true)
  assert.equal(gemini({ title: 'vim', preview: '' }), false)

  const agy = readinessMatcher('AGY')
  assert.equal(agy({ title: 'Antigravity', preview: 'ready' }), true)
  assert.equal(agy({ title: 'agy', preview: 'esc interrupt' }), false)
  assert.equal(agy({ title: 'notagy', preview: 'ready' }), false)
})

test('workerAgentReadyTimeoutMs honors the environment override with a safe default', () => {
  const previous = process.env.WORKER_AGENT_READY_TIMEOUT_MS
  try {
    delete process.env.WORKER_AGENT_READY_TIMEOUT_MS
    assert.equal(workerAgentReadyTimeoutMs(), 60_000)
    process.env.WORKER_AGENT_READY_TIMEOUT_MS = '2500'
    assert.equal(workerAgentReadyTimeoutMs(), 2500)
    process.env.WORKER_AGENT_READY_TIMEOUT_MS = 'not-a-number'
    assert.equal(workerAgentReadyTimeoutMs(), 60_000)
    process.env.WORKER_AGENT_READY_TIMEOUT_MS = '0'
    assert.equal(workerAgentReadyTimeoutMs(), 60_000)
  } finally {
    if (previous === undefined) delete process.env.WORKER_AGENT_READY_TIMEOUT_MS
    else process.env.WORKER_AGENT_READY_TIMEOUT_MS = previous
  }
})

test('acpRunnerInvocation targets the acpx runner and forwards constraints', () => {
  const invocation = acpRunnerInvocation({
    model: 'glm-5',
    prompt: 'Review this diff.',
    target: 'gemini-dev',
    timeoutMs: 30000
  })
  assert.deepEqual(invocation.args, [
    '--format',
    'quiet',
    '--approve-all',
    '--model',
    'glm-5',
    '--timeout',
    '30',
    'gemini-dev',
    'exec',
    'Review this diff.'
  ])
  const minimal = acpRunnerInvocation({ prompt: 'go', target: 'x' })
  assert.deepEqual(minimal.args, ['--format', 'quiet', '--approve-all', 'x', 'exec', 'go'])
})

test('acpRunnerInvocation refuses effort instead of silently dropping it', () => {
  assert.throws(
    () => acpRunnerInvocation({ effort: 'high', prompt: 'go', target: 'gemini-dev' }),
    /agent acp:gemini-dev: cannot express effort/
  )
})

test('collectResidualResources reclaims terminals and worktrees from failure receipts', () => {
  assert.deepEqual(collectResidualResources(undefined), { terminalHandles: [], worktreeIds: [] })
  assert.deepEqual(collectResidualResources([{ kind: 'worktree', id: 'wt-1' }, { kind: 'terminal', handle: 't-1' }]), {
    terminalHandles: ['t-1'],
    worktreeIds: ['wt-1']
  })
  assert.deepEqual(collectResidualResources({ worktree: { id: 'wt-2' }, terminal: { handle: 't-2' } }), {
    terminalHandles: ['t-2'],
    worktreeIds: ['wt-2']
  })
  assert.deepEqual(collectResidualResources({ worker: { terminalHandle: 't-3', worktreeId: 'wt-3' } }), {
    terminalHandles: ['t-3'],
    worktreeIds: ['wt-3']
  })
  assert.deepEqual(
    collectResidualResources({
      terminal: { handle: 't-1', session: { id: 'sess-9' } },
      worktree: { id: 'wt-1', repo: { id: 'repo-7' } }
    }),
    { terminalHandles: ['t-1'], worktreeIds: ['wt-1'] }
  )
  assert.deepEqual(collectResidualResources([{ type: 'Terminal', id: 't-4' }, { type: 'Terminal', id: 't-4' }]), {
    terminalHandles: ['t-4'],
    worktreeIds: []
  })
  assert.deepEqual(collectResidualResources({ note: 'nothing leaked' }), {
    terminalHandles: [],
    worktreeIds: []
  })
})

test('shellQuote escapes embedded single quotes', () => {
  assert.equal(shellQuote("it's"), `'it'"'"'s'`)
})
