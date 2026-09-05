import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { PIPELINE_STEPS, type StageName } from '../scripts/config.ts'
import { type PresentationSnapshot } from '../scripts/presentation.ts'
import { RailTuiRenderer } from '../scripts/tui.ts'

class FakeInput extends EventEmitter {
  isRaw = false
  isTTY = true
  paused = true

  isPaused(): boolean {
    return this.paused
  }

  pause(): this {
    this.paused = true
    return this
  }

  resume(): this {
    this.paused = false
    return this
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode
    return this
  }
}

class FakeOutput extends EventEmitter {
  columns = 120
  isTTY = true
  rows = 24
  readonly writes: string[] = []

  write(chunk: string): boolean {
    this.writes.push(chunk)
    return true
  }
}

function cleanScreen(screen: string): string {
  return screen
    .replaceAll(new RegExp('\\x1b\\[[0-?]*[ -/]*[@-~]', 'gu'), '')
    .replaceAll('\r', '')
    .replaceAll('\u0007', '')
}

function nextDraw(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

function snapshot(stage: StageName, sequence: number): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: stage,
    mode: { autoFix: true },
    runId: 'run-tui-rebase-test',
    sequence,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      id,
      round: 1,
      status: id === stage ? 'active' : 'pending',
      totalFindings: 0
    })),
    status: 'in-progress',
    transition: { kind: 'stage-started', stage },
    updatedAt: new Date(0).toISOString(),
    version: 1
  }
}

test('rebase gate-resolved fix followed by stage-completed does not fabricate Rebase fix 1', async () => {
  const input = new FakeInput()
  const output = new FakeOutput()
  const renderer = new RailTuiRenderer(input, output, '/unused')

  try {
    const base = snapshot('rebase', 1)
    renderer.render({
      ...base,
      transition: {
        gateId: 'g-rebase',
        kind: 'gate-opened',
        options: ['fix', 'abort'],
        question: 'Rebase decision needed',
        round: 0,
        stage: 'rebase'
      }
    })
    await nextDraw()
    let screen = cleanScreen(output.writes.at(-1) ?? '')
    assert.match(screen, /Rebase decision needed/u)

    // Gate resolved as fix (generic decision without fixer round)
    renderer.render({
      ...base,
      transition: {
        decision: 'fix',
        gateId: 'g-rebase',
        kind: 'gate-resolved',
        round: 0,
        stage: 'rebase'
      }
    })
    await nextDraw()
    screen = cleanScreen(output.writes.at(-1) ?? '')
    assert.match(screen, /Rebase fix/u)
    assert.doesNotMatch(screen, /Rebase fix 1/u)

    // Stage completes with cleared/fixed findings on the rerun
    const stageStateWithFixed = {
      ...base,
      stages: base.stages.map((s) =>
        s.id === 'rebase'
          ? {
              ...s,
              fixedFindings: 1,
              status: 'passed' as const,
              totalFindings: 1
            }
          : s
      )
    }

    renderer.render({
      ...stageStateWithFixed,
      transition: {
        kind: 'stage-completed',
        round: 0,
        stage: 'rebase'
      }
    })
    await nextDraw()
    screen = cleanScreen(output.writes.at(-1) ?? '')
    assert.match(screen, /Rebase fix/u)
    assert.doesNotMatch(screen, /Rebase fix 1/u)
    assert.doesNotMatch(screen, /Rebase fix.*fixed/u)
  } finally {
    renderer.close()
  }
})

test('rebase gate-resolved fix followed by findings reconciliation does not fabricate Rebase fix 1', async () => {
  const input = new FakeInput()
  const output = new FakeOutput()
  const renderer = new RailTuiRenderer(input, output, '/unused')

  try {
    const base = snapshot('rebase', 1)
    renderer.render({
      ...base,
      transition: {
        decision: 'fix',
        gateId: 'g-rebase',
        kind: 'gate-resolved',
        round: 0,
        stage: 'rebase'
      }
    })
    await nextDraw()
    let screen = cleanScreen(output.writes.at(-1) ?? '')
    assert.match(screen, /Rebase fix/u)
    assert.doesNotMatch(screen, /Rebase fix 1/u)

    // Reconciled findings snapshot indicates fixed findings, but no fixer ever ran
    const stageStateWithFixed = {
      ...base,
      stages: base.stages.map((s) =>
        s.id === 'rebase'
          ? {
              ...s,
              fixedFindings: 1,
              totalFindings: 1
            }
          : s
      )
    }

    renderer.render({
      ...stageStateWithFixed,
      transition: {
        actionable: 0,
        kind: 'findings-recorded',
        round: 0,
        stage: 'rebase',
        total: 1
      }
    })
    await nextDraw()
    screen = cleanScreen(output.writes.at(-1) ?? '')
    assert.match(screen, /Rebase fix/u)
    assert.doesNotMatch(screen, /Rebase fix 1/u)
    assert.doesNotMatch(screen, /Rebase fix.*fixed/u)
  } finally {
    renderer.close()
  }
})

test('activity entry with explicit fix-completed metadata is correctly updated and verified', async () => {
  const input = new FakeInput()
  const output = new FakeOutput()
  const renderer = new RailTuiRenderer(input, output, '/unused')

  try {
    const base = snapshot('review', 1)
    renderer.render({
      ...base,
      transition: {
        kind: 'round-started',
        role: 'reviewer',
        round: 0,
        stage: 'review'
      }
    })
    renderer.render({
      ...base,
      transition: {
        actionable: 1,
        kind: 'findings-recorded',
        round: 0,
        stage: 'review',
        total: 1
      }
    })
    renderer.render({
      ...base,
      transition: {
        decision: 'fix',
        gateId: 'g-review',
        kind: 'gate-resolved',
        round: 0,
        stage: 'review'
      }
    })
    renderer.render({
      ...base,
      transition: {
        analysis: 1,
        kind: 'round-started',
        role: 'fixer',
        round: 1,
        stage: 'review'
      }
    })
    renderer.render({
      ...base,
      transition: {
        approvedFindings: 0,
        findingIds: ['finding-1'],
        kind: 'fix-completed',
        round: 1,
        stage: 'review'
      }
    })

    await nextDraw()
    let screen = cleanScreen(output.writes.at(-1) ?? '')
    assert.match(screen, /Review fix 1\s+· 1 fix applied/u)

    // Stage completed without re-analysis verifies the fix entry carrying explicit fix metadata
    const withFixed = {
      ...base,
      stages: base.stages.map((s) =>
        s.id === 'review'
          ? {
              ...s,
              fixedFindings: 1,
              status: 'passed' as const,
              totalFindings: 1
            }
          : s
      )
    }
    renderer.render({
      ...withFixed,
      transition: {
        kind: 'stage-completed',
        round: 0,
        stage: 'review'
      }
    })

    await nextDraw()
    screen = cleanScreen(output.writes.at(-1) ?? '')
    assert.match(screen, /Review fix 1\s+· 1 fixed/u)
  } finally {
    renderer.close()
  }
})
