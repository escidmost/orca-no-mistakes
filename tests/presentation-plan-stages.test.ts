import assert from 'node:assert/strict'
import test from 'node:test'
import { LEGACY_STAGE_PLAN } from '../scripts/ledger.ts'
import {
  PlainStatusRenderer,
  PresentationPublisher,
  type PresentationSnapshot,
  type PresentationStore,
} from '../scripts/presentation.ts'

function memoryStore(): PresentationStore {
  const recorded: { eventKey: string; runId: string; snapshot: PresentationSnapshot }[] = []
  return {
    listPresentationSnapshots: (runId) =>
      recorded.filter((entry) => entry.runId === runId).map((entry) => entry.snapshot),
    recordPresentationSnapshot: (runId, eventKey, snapshot) => {
      recorded.push({ eventKey, runId, snapshot })
      return true
    },
  }
}

test('presentation follows the run plan instead of always eight stages', () => {
  const lines: string[] = []
  const publisher = new PresentationPublisher(
    memoryStore(),
    'run6',
    new PlainStatusRenderer({ write: (chunk: string) => lines.push(chunk) }),
    () => new Date('2026-09-02T00:00:00.000Z'),
    () => {},
    undefined,
    LEGACY_STAGE_PLAN,
  )
  publisher.publish('attempt:1:stage:review:started', { kind: 'stage-started', stage: 'review' })
  publisher.publish('attempt:1:stage:review:completed', {
    kind: 'stage-completed',
    round: 0,
    stage: 'review',
  })
  publisher.publish('attempt:1:run:completed:passed', {
    kind: 'run-completed',
    status: 'passed',
  })

  assert.equal(publisher.current.stages.length, LEGACY_STAGE_PLAN.length)
  assert.ok(
    publisher.current.stages.every((stage) => !['push', 'pr'].includes(stage.id)),
  )
  assert.ok(lines.includes('no-mistakes run6 stage 3/6 review started\n'))
  assert.ok(lines.includes('no-mistakes run6 stage 3/6 review completed\n'))
})

test('plain status defaults to the eight-stage plan when none is provided', () => {
  const lines: string[] = []
  const publisher = new PresentationPublisher(
    memoryStore(),
    'run8',
    new PlainStatusRenderer({ write: (chunk: string) => lines.push(chunk) }),
  )
  publisher.publish('attempt:1:stage:review:started', { kind: 'stage-started', stage: 'review' })
  assert.ok(lines.includes('no-mistakes run8 stage 3/8 review started\n'))
})
