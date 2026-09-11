import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  acpRunnerInvocation,
  buildCliCommand,
  classifyHarness,
  collectResidualResources,
  extractStructuredJson,
  isBinaryMissingOutput,
  nativeWorkerStartArgs,
  parseAcpTarget,
  parseAgyStream,
  readinessMatcher,
  shellQuote,
  workerAgentReadyTimeoutMs
} from '../scripts/adapters.ts'

test('classifyHarness routes native, CLI, and ACP harnesses', () => {
  assert.equal(classifyHarness('claude'), 'cli')
  assert.equal(classifyHarness('codex'), 'cli')
  assert.equal(classifyHarness('cursor'), 'native')
  assert.equal(classifyHarness('Cursor'), 'native')
  assert.equal(classifyHarness('opencode'), 'cli')
  assert.equal(classifyHarness('grok'), 'cli')
  assert.equal(classifyHarness('gemini'), 'cli')
  assert.equal(classifyHarness('Kimi'), 'cli')
  assert.equal(classifyHarness('future-cli-agent'), 'cli')
  assert.equal(classifyHarness('acp:gemini-dev'), 'acp')
  assert.equal(classifyHarness('ACP:gemini-dev'), 'acp')
})

test('parseAcpTarget extracts valid targets and rejects malformed harnesses', () => {
  assert.equal(parseAcpTarget('acp:claude-code'), 'claude-code')
  assert.equal(parseAcpTarget('acp:gemini_2-dev'), 'gemini_2-dev')
  assert.equal(parseAcpTarget('ACP:gemini_2-dev'), 'gemini_2-dev')
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
    agent: 'Cursor',
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
  assert.ok(fixer.includes('cursor'))

  // Effort requires a model per the Orca worker-start contract.
  assert.throws(
    () => nativeWorkerStartArgs({ agent: 'cursor', effort: 'high', taskId: 't' }),
    /agent cursor: effort requires a model/
  )
})

test('buildCliCommand formats startup lines with model, variant, env, and override args', () => {
  assert.equal(buildCliCommand('opencode'), `'opencode'`)
  assert.equal(
    buildCliCommand('opencode', { model: 'openai/gpt-5.6', variant: 'high' }),
    `OPENCODE_CONFIG_CONTENT='{"agent":{"build":{"model":"openai/gpt-5.6","variant":"high"}}}' 'opencode' '--model' 'openai/gpt-5.6' '--agent' 'build'`
  )
  assert.equal(
    buildCliCommand('opencode', { effort: 'high', model: 'openai/gpt-5.6' }),
    `OPENCODE_CONFIG_CONTENT='{"agent":{"build":{"model":"openai/gpt-5.6","variant":"high"}}}' 'opencode' '--model' 'openai/gpt-5.6' '--agent' 'build'`
  )
  // Variant is opencode-specific.
  assert.equal(buildCliCommand('grok', { model: 'grok-4', variant: 'high' }), `'grok' '--model' 'grok-4'`)
  assert.equal(buildCliCommand('gemini', { model: 'gemini-3-pro' }), `'gemini' '--model' 'gemini-3-pro'`)
  assert.equal(
    buildCliCommand('Kimi', { model: 'kimi-k2.5' }),
    `'kimi' '--model' 'kimi-k2.5' '--auto'`
  )
  assert.equal(
    buildCliCommand('claude', { effort: 'high', model: 'opus[1m]' }),
    `'claude' '--model' 'opus[1m]' '--effort' 'high' '--dangerously-skip-permissions'`
  )
  assert.equal(
    buildCliCommand('Claude', { effort: 'high', model: 'opus[1m]' }),
    `'claude' '--model' 'opus[1m]' '--effort' 'high' '--dangerously-skip-permissions'`
  )
  assert.equal(
    buildCliCommand('claude', {
      agentArgsOverride: { Claude: ['--verbose'] } as never,
    }),
    `'claude' '--dangerously-skip-permissions' '--verbose'`
  )
  assert.throws(
    () =>
      buildCliCommand('claude', {
        agentArgsOverride: { claude: ['--one'], Claude: ['--two'] } as never,
      }),
    /duplicate harness keys 'claude' and 'Claude'/
  )
  assert.equal(
    buildCliCommand('Codex', { effort: 'max', model: 'gpt-5.6-luna' }),
    `'codex' '--model' 'gpt-5.6-luna' '-c' 'model_reasoning_effort="max"' '--dangerously-bypass-approvals-and-sandbox'`
  )
  assert.equal(
    buildCliCommand('codex', {
      agentArgsOverride: { codex: ['-c', 'model_reasoning_effort="low"'] } as never,
      effort: 'max'
    }),
    `'codex' '--dangerously-bypass-approvals-and-sandbox' '-c' 'model_reasoning_effort="low"'`
  )
  assert.equal(
    buildCliCommand('codex', {
      agentArgsOverride: { codex: ['-c', 'model="raw"'] } as never,
      model: 'mapped'
    }),
    `'codex' '--dangerously-bypass-approvals-and-sandbox' '-c' 'model="raw"'`
  )
  assert.equal(
    buildCliCommand('codex', {
      agentArgsOverride: {
        codex: ['-c', 'model = "raw"', '-c', 'model_reasoning_effort = "low"']
      } as never,
      effort: 'max',
      model: 'mapped'
    }),
    `'codex' '--dangerously-bypass-approvals-and-sandbox' '-c' 'model = "raw"' '-c' 'model_reasoning_effort = "low"'`
  )
  assert.equal(
    buildCliCommand('codex', {
      agentArgsOverride: { codex: ['-cmodel="raw"', '-cmodel_reasoning_effort="low"'] } as never,
      effort: 'max',
      model: 'mapped'
    }),
    `'codex' '--dangerously-bypass-approvals-and-sandbox' '-cmodel="raw"' '-cmodel_reasoning_effort="low"'`
  )
  assert.equal(
    buildCliCommand('codex', {
      agentArgsOverride: {
        codex: ['--', '-c', 'model_reasoning_effort="low"', '--model', 'raw']
      } as never,
      effort: 'max',
      model: 'mapped'
    }),
    `'codex' '--model' 'mapped' '-c' 'model_reasoning_effort="max"' '--dangerously-bypass-approvals-and-sandbox' '--' '-c' 'model_reasoning_effort="low"' '--model' 'raw'`
  )
  assert.throws(
    () =>
      buildCliCommand('codex', {
        agentArgsOverride: { codex: ['-c', 'model_reasoning_effort='] } as never,
        effort: 'max'
      }),
    /model_reasoning_effort requires a nonempty value/
  )
  assert.throws(
    () =>
      buildCliCommand('codex', {
        agentArgsOverride: { codex: ['--dangerously-bypass-approvals-and-sandbox'] } as never
      }),
    /reserved argument/
  )
  for (const [harness, args] of [
    ['agy', ['--sandbox']],
    ['claude', ['--permission-mode', 'manual']],
    ['codex', ['--sandbox', 'read-only']],
    ['codex', ['--ask-for-approval', 'on-request']],
    ['codex', ['-c', 'sandbox_mode="read-only"']],
    ['codex', ['-sread-only']],
    ['codex', ['-aon-request']],
    ['codex', ['-pdefault']],
    ['codex', ['-csandbox_mode="read-only"']],
    ['kimi', ['--prompt', 'raw']],
  ] as const) {
    assert.throws(
      () =>
        buildCliCommand(harness, {
          agentArgsOverride: { [harness]: [...args] } as never,
        }),
      /reserved (?:argument|config)/,
    )
  }
  for (const [harness, required] of [
    ['claude', '--dangerously-skip-permissions'],
    ['codex', '--dangerously-bypass-approvals-and-sandbox']
  ]) {
    const command = buildCliCommand(harness, {
      agentArgsOverride: { [harness]: ['--', 'prompt'] } as never
    })
    assert.ok(command.indexOf(required) < command.indexOf("'--'"))
  }
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
  // Accepted raw model-pin forms for opencode effort validation:
  for (const rawArgs of [
    ['--model', 'custom/model'],
    ['--model=custom/model'],
    ['-m', 'custom/model'],
    ['-m=custom/model'],
    ['-mcustom/model']
  ]) {
    assert.equal(
      buildCliCommand('opencode', {
        agentArgsOverride: { opencode: rawArgs } as never,
        effort: 'high'
      }),
      `OPENCODE_CONFIG_CONTENT='{"agent":{"build":{"model":"custom/model","variant":"high"}}}' 'opencode' '--agent' 'build' ${rawArgs.map((a) => `'${a}'`).join(' ')}`
    )
  }
  // Empty raw model pins are malformed rather than silently treated as absent.
  for (const rawArgs of [['--model'], ['--model='], ['--model', ''], ['-m'], ['-m='], ['-m', '']]) {
    assert.throws(
      () =>
        buildCliCommand('opencode', {
          agentArgsOverride: { opencode: rawArgs } as never,
          effort: 'high'
        }),
      /requires a value/
    )
  }
  assert.equal(
    buildCliCommand('opencode', { effort: 'medium', variant: 'high' }),
    `OPENCODE_CONFIG_CONTENT='{"agent":{"build":{"variant":"high"}}}' 'opencode' '--agent' 'build'`
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
    model: 'openai/gpt-5.6'
  })
  assert.equal(
    pinnedVariant,
    `OPENCODE_CONFIG_CONTENT='{"agent":{"build":{"model":"openai/gpt-5.6","variant":"low"}}}' 'opencode' '--model' 'openai/gpt-5.6' '--agent' 'build'`,
  )
  assert.equal(
    buildCliCommand('opencode', {
      agentArgsOverride: { opencode: ['--model', 'custom/model'] } as never,
      model: 'profile-model',
      variant: 'high',
    }),
    `OPENCODE_CONFIG_CONTENT='{"agent":{"build":{"model":"custom/model","variant":"high"}}}' 'opencode' '--agent' 'build' '--model' 'custom/model'`,
  )
  assert.equal(
    buildCliCommand('opencode', {
      agentArgsOverride: {
        opencode: ['--agent', 'reviewer'],
      } as never,
      variant: 'high',
    }),
    `OPENCODE_CONFIG_CONTENT='{"agent":{"reviewer":{"variant":"high"}}}' 'opencode' '--agent' 'reviewer'`,
  )
  assert.throws(
    () =>
      buildCliCommand('opencode', {
        agentArgsOverride: { opencode: ['--variant', '--print-logs'] } as never,
        model: 'openai/gpt-5.6',
      }),
    /argument --variant requires a value/,
  )
  for (const rawArgs of [['--variant='], ['--variant'], ['--agent='], ['--agent']]) {
    assert.throws(
      () =>
        buildCliCommand('opencode', {
          agentArgsOverride: { opencode: rawArgs } as never,
          variant: 'high',
        }),
      /requires a value/,
    )
  }
  for (const rawArgs of [
    ['--agent', 'reviewer', '--agent=build'],
    ['--model', 'first', '-msecond'],
    ['--variant=low', '--variant', 'high'],
  ]) {
    assert.throws(
      () =>
        buildCliCommand('opencode', {
          agentArgsOverride: { opencode: rawArgs } as never,
          variant: 'high',
        }),
      /may only be specified once/,
    )
  }
  assert.equal(
    buildCliCommand('opencode', {
      agentArgsOverride: {
        opencode: {
          OPENCODE_CONFIG_CONTENT: '{"theme":"dark","agent":{"build":{"temperature":0.2}}}',
        },
      } as never,
      variant: 'high',
    }),
    `OPENCODE_CONFIG_CONTENT='{"theme":"dark","agent":{"build":{"temperature":0.2,"variant":"high"}}}' 'opencode' '--agent' 'build'`,
  )
  // Unknown harnesses keep the legacy --model passthrough.
  assert.equal(buildCliCommand('mycli', { model: 'm1' }), `'mycli' '--model' 'm1'`)

  const overridden = buildCliCommand('opencode', {
    agentArgsOverride: { opencode: { OPENCODE_MODEL: 'custom' }, grok: ['--verbose'] } as never,
    model: 'custom/m'
  })
  assert.match(overridden, /^OPENCODE_MODEL='custom' 'opencode'/)
  assert.ok(!overridden.includes('--verbose'), 'override entries apply per harness')

  const extra = buildCliCommand('grok', {
    agentArgsOverride: { grok: ['--dangerously-auto', '-q'] } as never
  })
  assert.equal(extra, `'grok' '--dangerously-auto' '-q'`)
})

test('OpenCode validates the effective explicit model without selecting a provider', () => {
  for (const model of ['', 'gpt-6-astra', '/gpt-6-astra', 'openai/', 'openai/gpt 6', ' openai/gpt-6']) {
    assert.throws(() => buildCliCommand('OpenCode', { model }), /agent opencode: invalid model.*provider\/model/)
  }
  for (const raw of [
    ['--model', 'gpt-6-astra'], ['--model=gpt-6-astra'],
    ['-m', 'gpt-6-astra'], ['-m=gpt-6-astra'], ['-mgpt-6-astra'],
  ]) {
    assert.throws(() => buildCliCommand('opencode', {
      model: 'openai/gpt-6-astra', agentArgsOverride: { opencode: raw },
    }), /provider\/model/)
  }
  for (const model of ['openai/gpt-6-astra', 'opencode/gpt-6-astra', 'openrouter/openai/gpt-6-astra']) {
    assert.equal(buildCliCommand('opencode', { model, effort: 'medium' }),
      `OPENCODE_CONFIG_CONTENT='{"agent":{"build":{"model":"${model}","variant":"medium"}}}' 'opencode' '--model' '${model}' '--agent' 'build'`)
    assert.equal(buildCliCommand('opencode', { model }), `'opencode' '--model' '${model}'`)
  }
  assert.throws(() => buildCliCommand('opencode', {
    model: 'bare', agentArgsOverride: { opencode: ['--', '--model', 'openai/gpt-6-astra'] },
  }), /provider\/model/)
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

  const pi = readinessMatcher('pi')
  assert.equal(pi({ title: 'π - worker-worktree', preview: 'ready' }), true)
  assert.equal(pi({ title: 'Pi', preview: 'ready' }), true)
  assert.equal(pi({ title: 'zsh', preview: 'ready' }), false)

  const agy = readinessMatcher('AGY')
  assert.equal(agy({ title: 'Antigravity', preview: 'ready' }), true)
  assert.equal(agy({ title: 'agy', preview: 'esc interrupt' }), false)
  assert.equal(agy({ title: 'notagy', preview: 'ready' }), false)

  const codex = readinessMatcher('codex')
  assert.equal(
    codex({
      title: '⠇ no-mistakes-review-1',
      preview: '• Working (44s • esc to interrupt)\n› Find and fix a bug in @filename  gpt-5.6-luna max'
    }),
    true
  )
  assert.equal(
    codex({
      title: '⠇ no-mistakes-review-1',
      preview: '• Working (2s • esc to interrupt)\n› Audit the change  gpt-5.6-luna ultra'
    }),
    true
  )
  assert.equal(
    codex({ title: 'no-mistakes-review-1', preview: '•Working(44s)' }),
    false
  )
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
    '--file',
    '-'
  ])
  const minimal = acpRunnerInvocation({ target: 'x' })
  assert.deepEqual(minimal.args, ['--format', 'quiet', '--approve-all', 'x', 'exec', '--file', '-'])
})

test('acpRunnerInvocation refuses effort instead of silently dropping it', () => {
  assert.throws(
    () => acpRunnerInvocation({ effort: 'high', target: 'gemini-dev' }),
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

test('buildCliCommand always sends the agy reserved flag and rejects reserved overrides', () => {
  assert.equal(buildCliCommand('agy'), `'agy' '--dangerously-skip-permissions'`)
  assert.equal(
    buildCliCommand('agy', { model: 'gemini-3-pro', effort: 'high' }),
    `'agy' '--model' 'gemini-3-pro' '--effort' 'high' '--dangerously-skip-permissions'`
  )
  assert.equal(
    buildCliCommand('agy', { effort: 'low' }),
    `'agy' '--effort' 'low' '--dangerously-skip-permissions'`
  )
  const overridden = buildCliCommand('agy', {
    agentArgsOverride: { agy: ['--mode', 'accept-edits'] } as never
  })
  assert.equal(
    overridden,
    `'agy' '--dangerously-skip-permissions' '--mode' 'accept-edits'`
  )
  const envOverride = buildCliCommand('agy', {
    agentArgsOverride: { agy: { AGY_EFFORT: 'high' } } as never,
    model: 'm'
  })
  assert.match(envOverride, /^AGY_EFFORT='high' 'agy'/)
  for (const flag of [
    '--continue',
    '--conversation=00000000-0000-4000-8000-000000000000',
    '--dangerously-skip-permissions',
    '--print',
    '--prompt',
    '--prompt-interactive',
    '-c00000000-0000-4000-8000-000000000000',
    '-i',
    '-pprompt',
    '--prompt-interactive=/tmp/x',
    '--dangerously-skip-permissions=false'
  ]) {
    assert.throws(
      () => buildCliCommand('agy', { agentArgsOverride: { agy: [flag] } } as never),
      (error: unknown) =>
        error instanceof Error &&
        error.message === `agent agy: reserved argument '${flag}' cannot be overridden`
    )
  }
  assert.throws(
    () => buildCliCommand('agy', { agentArgsOverride: { agy: ['--'] } } as never),
    /option terminator '--' cannot precede the managed prompt carrier/
  )
  // Other harnesses keep plain passthrough overrides.
  assert.equal(
    buildCliCommand('grok', { agentArgsOverride: { grok: ['-q'] } as never }),
    `'grok' '-q'`
  )
})

test('buildCliCommand reserves pi conversation and interactive-mode controls', () => {
  for (const flag of [
    '--continue',
    '--export=/tmp/pi-session.html',
    '--fork=session-id',
    '--list-models=claude',
    '--mode=json',
    '--no-session',
    '--print',
    '--resume=session-id',
    '--session=session-id',
    '--session-dir=/tmp/pi-sessions',
    '--session-id=00000000-0000-4000-8000-000000000000',
    '-c',
    '-pprompt',
    '-rsession-id'
  ]) {
    assert.throws(
      () => buildCliCommand('pi', { agentArgsOverride: { pi: [flag] } }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === `agent pi: reserved argument '${flag}' cannot be overridden`
    )
  }
  assert.throws(
    () =>
      buildCliCommand('pi', {
        agentArgsOverride: { pi: { PI_CODING_AGENT_SESSION_DIR: '/tmp/pi-sessions' } }
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "agent pi: reserved environment variable 'PI_CODING_AGENT_SESSION_DIR' cannot be overridden"
  )
})

test('isBinaryMissingOutput spots shell binary failures naming the harness', () => {
  assert.equal(isBinaryMissingOutput('zsh: command not found: agy', 'agy'), true)
  assert.equal(isBinaryMissingOutput('spawn agy ENOENT', 'agy'), true)
  assert.equal(isBinaryMissingOutput('agy: command not found', 'agy'), true)
  assert.equal(isBinaryMissingOutput('fish: Unknown command: agy', 'agy'), true)
  assert.equal(isBinaryMissingOutput('Antigravity ready', 'agy'), false)
  assert.equal(isBinaryMissingOutput('', 'agy'), false)
  // Unrelated startup noise must not abort a healthy harness.
  assert.equal(
    isBinaryMissingOutput('nvm: command not found\nOpenCode\nagy is elsewhere', 'opencode'),
    false
  )
  assert.equal(isBinaryMissingOutput('spawn ripgrep ENOENT', 'opencode'), false)
  assert.equal(isBinaryMissingOutput("opencode: unknown command '--nope'", 'opencode'), false)
})

test('parseAgyStream maps deltas, thinking usage, responses, and structured output', () => {
  const stream = [
    JSON.stringify({ event: 'step_update', step_update: { text_delta: 'Hel' } }),
    JSON.stringify({
      event: 'step_update',
      step_update: {
        text_delta: 'lo',
        usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 42 }
      }
    }),
    '',
    'not json at all',
    JSON.stringify({
      event: 'result',
      result: {
        status: 'SUCCESS',
        response: 'final answer',
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          thinking_tokens: 50,
          cache_read_tokens: 3,
          cache_creation_tokens: 9
        }
      }
    })
  ].join('\n')
  const parsed = parseAgyStream(stream)
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.text, 'final answer', 'the terminal result response outranks stream deltas')
  assert.equal(parsed.usage.inputTokens, 12)
  assert.equal(parsed.usage.outputTokens, 7)
  assert.equal(parsed.usage.cacheReadTokens, 3)
  assert.equal(parsed.usage.cacheCreationTokens, 9)
  assert.equal(parsed.usage.cacheCreationReported, true)
  assert.equal(parsed.usage.reasoningTokens, 50)
  assert.equal(parsed.usage.reasoningReported, true)

  const structured = parseAgyStream([
    JSON.stringify({ event: 'step_update', step_update: { text_delta: '{"partial":true}' } }),
    JSON.stringify({
      event: 'result',
      result: { status: 'SUCCESS', response: 'prose wrapper', structured_output: { success: true } }
    })
  ].join('\n'))
  assert.equal(structured.text, '{"success":true}', 'structured_output outranks response and deltas')

  const deltasOnly = parseAgyStream([
    JSON.stringify({ event: 'step_update', step_update: { text_delta: 'stream only' } }),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } })
  ].join('\n'))
  assert.equal(deltasOnly.text, 'stream only')

  assert.equal(
    parseAgyStream(JSON.stringify({ event: 'result', result: { status: 'ERROR' } })).error,
    'unknown error'
  )
  assert.equal(
    parseAgyStream(
      JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'quota exceeded' } })
    ).error,
    'quota exceeded'
  )
})

test('parseAgyStream distinguishes a genuine zero of thinking tokens from absence', () => {
  const zero = parseAgyStream(
    JSON.stringify({ event: 'step_update', step_update: { usage: { thinking_tokens: 0 } } })
  )
  assert.equal(zero.usage.reasoningReported, true)
  assert.equal(zero.usage.reasoningTokens, 0)

  const absent = parseAgyStream(
    JSON.stringify({ event: 'step_update', step_update: { usage: { output_tokens: 2 } } })
  )
  assert.equal(absent.usage.reasoningReported, undefined)
  assert.equal(absent.usage.reasoningTokens, undefined)

  const malformed = parseAgyStream(
    JSON.stringify({ event: 'step_update', step_update: { usage: { thinking_tokens: 'lots' } } })
  )
  assert.equal(malformed.usage.reasoningReported, true)
  assert.equal(malformed.usage.reasoningTokens, undefined)

  const junk = [
    'null',
    '[1,2]',
    '"quoted string"',
    '42',
    'not json at all',
    JSON.stringify({ event: null }),
    JSON.stringify({ other: true })
  ].join('\n')
  const junkResult = parseAgyStream(junk)
  assert.equal(junkResult.text, '')
  assert.equal(junkResult.error, undefined)
  assert.deepEqual(junkResult.usage, {})
})

test('parseAgyStream replays recorded plain and structured agy fixtures', async () => {
  const plain = parseAgyStream(
    await readFile(new URL('./fixtures/agy/plain.jsonl', import.meta.url), 'utf8')
  )
  assert.equal(plain.error, undefined)
  assert.equal(plain.text, 'OK')
  assert.equal(plain.usage.inputTokens, 17586)
  assert.equal(plain.usage.outputTokens, 26)
  assert.equal(plain.usage.reasoningTokens, 25)

  const structured = parseAgyStream(
    await readFile(new URL('./fixtures/agy/structured.jsonl', import.meta.url), 'utf8')
  )
  assert.equal(structured.error, undefined)
  assert.equal(structured.text, '{"ok":true}')
  assert.equal(structured.usage.inputTokens, 35757)
  assert.equal(structured.usage.outputTokens, 124)
  assert.equal(structured.usage.reasoningTokens, 81)
})

test('extractStructuredJson prefers closed fences over unclosed tails and prose quotes', () => {
  assert.deepEqual(extractStructuredJson('{"a":1}'), { a: 1 })
  assert.deepEqual(extractStructuredJson('noise\n```json\n{"a":1}\n```\ntail'), { a: 1 })
  assert.deepEqual(extractStructuredJson('```json{"glued":true}```'), { glued: true })
  assert.deepEqual(
    extractStructuredJson(
      'example:\n```json as an inline quote\nthen real data\n```json\n{"a":1}\n```\n'
    ),
    { a: 1 },
    'prose quoting a fence must not shadow a trailing closed block'
  )
  assert.deepEqual(
    extractStructuredJson(
      'Wrap output in ```json fences.\n\n```json\n{"findings":[],"summary":"clean"}\n```\n\nAlso `{"strict":true}` matters.'
    ),
    { findings: [], summary: 'clean' },
    'a quoted opener must not pair with the real opener and hide the report body'
  )
  assert.deepEqual(extractStructuredJson('```json\n{"open":1}'), { open: 1 })
  assert.deepEqual(extractStructuredJson('prefix {"bare":true} suffix'), { bare: true })
  assert.deepEqual(extractStructuredJson('```json\n{"nested":{"deep":2}}\n```'), { nested: { deep: 2 } })
  assert.equal(
    extractStructuredJson('```json\n{"a":1}\n```\n```json\n{"a":2}\n```'),
    undefined,
    'multiple valid closed fences are ambiguous'
  )
  assert.deepEqual(
    extractStructuredJson('```json\n{"a":1}\n```\ntext\n```json\n{"a":1}\n```'),
    { a: 1 },
    'closed fences repeating the same value do not disagree'
  )
  assert.equal(extractStructuredJson('no json here'), undefined)
  assert.equal(
    extractStructuredJson(
      'I reviewed the diff and found nothing.\n\n{"findings":[],"summary":"clean"}\n\nThe report shape is {"findings":[{"id":"stable-id","severity":"error|warning|info","file":"optional/path","line":1,"description":"full finding","action":"auto-fix|ask-user|no-op"}],"summary":"concise result","tested":["optional command"],"artifacts":["optional path"]}\n'
    ),
    undefined,
    'a narrative file with disagreeing bare objects must not yield the echoed prompt template'
  )
  assert.deepEqual(
    extractStructuredJson('{"a":1} restated as {"a":1}'),
    { a: 1 },
    'repeated identical bare objects are not ambiguous'
  )
})

test('extractStructuredJson with an accept gate ignores thinking-model reasoning debris', () => {
  const isReport = (value: unknown): boolean =>
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { findings?: unknown }).findings) &&
    typeof (value as { summary?: unknown }).summary === 'string'
  const report = { findings: [], summary: 'done' }
  const schemaFragment = '{"type":"object","properties":{"findings":{"type":"array"}}}'

  assert.deepEqual(
    extractStructuredJson(
      `Checking the schema first. ${schemaFragment}\n${JSON.stringify(report)}`,
      isReport
    ),
    report,
    'a quoted schema fragment in reasoning must not hide the bare payload'
  )
  assert.deepEqual(
    extractStructuredJson(
      `Example: \`\`\`json\n${schemaFragment}\n\`\`\`\nResult:\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``,
      isReport
    ),
    report,
    'a reasoning-phase fence quote must not compete with the real closed fence'
  )
  assert.equal(
    extractStructuredJson(`x ${schemaFragment} y ${JSON.stringify(report)}`),
    undefined,
    'without the gate the same debris stays ambiguous'
  )
  assert.equal(
    extractStructuredJson(
      `${JSON.stringify(report)} then ${JSON.stringify({ findings: [], summary: 'different' })}`,
      isReport
    ),
    undefined,
    'two approved-but-different candidates still fail closed'
  )
})
