import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { PIPELINE_STEPS, type StageName } from '../scripts/config.ts'
import {
  DomainLedger,
  finalContiguousCheckpointByStage,
  isCandidateReachable
} from '../scripts/ledger.ts'
import {
  type PresentationSnapshot
} from '../scripts/presentation.ts'
import {
  CandidatePublicationError,
  terminalCandidate
} from '../scripts/publication.ts'
import {
  RailTuiRenderer
} from '../scripts/tui.ts'

function oid(digit: number): string {
  return String(digit).repeat(40)
}

function sha(char: string): string {
  return char.repeat(64)
}

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

function cleanScreen(output: string): string {
  const screen = output.split('\u001b[H\u001b[2J').at(-1) ?? output
  return screen
    .replaceAll(new RegExp('\\x1b\\[[0-?]*[ -/]*[@-~]', 'gu'), '')
    .replaceAll('\r', '')
}

async function nextDraw(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function snapshot(stage: StageName, sequence: number): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: stage,
    mode: { autoFix: true },
    runId: 'run-tui-test',
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

test('finalContiguousCheckpointByStage retains intent and rebase checkpoints across revalidated later stages', () => {
  const stageIds = ['intent', 'rebase', 'review', 'test']
  const oidS = oid(1)
  const oidR = oid(2)
  const oidC = oid(3)

  const checkpoints = [
    { created_at: '2026-01-01T00:00:00Z', input_commit_oid: oidS, output_commit_oid: oidS, round_index: 0, run_id: 'run-1', stage_id: 'intent' },
    { created_at: '2026-01-01T00:00:01Z', input_commit_oid: oidS, output_commit_oid: oidR, round_index: 0, run_id: 'run-1', stage_id: 'rebase' },
    { created_at: '2026-01-01T00:00:02Z', input_commit_oid: oidR, output_commit_oid: oidC, round_index: 0, run_id: 'run-1', stage_id: 'review' },
    { created_at: '2026-01-01T00:00:03Z', input_commit_oid: oidC, output_commit_oid: oidC, round_index: 1, run_id: 'run-1', stage_id: 'review' },
    { created_at: '2026-01-01T00:00:04Z', input_commit_oid: oidC, output_commit_oid: oidC, round_index: 0, run_id: 'run-1', stage_id: 'test' }
  ]

  const evidence = [
    { candidateCommitOid: oidS, roundIndex: 0, stage: 'intent' },
    { candidateCommitOid: oidR, roundIndex: 0, stage: 'rebase' },
    { candidateCommitOid: oidC, roundIndex: 1, stage: 'review' },
    { candidateCommitOid: oidC, roundIndex: 0, stage: 'test' }
  ]

  const result = finalContiguousCheckpointByStage(stageIds, checkpoints, oidS, evidence)
  assert.equal(result.get('intent')?.output_commit_oid, oidS)
  assert.equal(result.get('rebase')?.output_commit_oid, oidR)
  assert.equal(result.get('review')?.output_commit_oid, oidC)
  assert.equal(result.get('review')?.round_index, 1)
  assert.equal(result.get('test')?.output_commit_oid, oidC)
  assert.equal(result.get('test')?.round_index, 0)
})

test('terminalCandidate publishes full pipeline retaining intent and rebase while later stages revalidated', () => {
  const ledger = new DomainLedger(':memory:')
  const runId = 'test-revalidation-terminal-candidate'
  const oidS = oid(1)
  const oidR = oid(2)
  const oidC = oid(3)

  try {
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Verify publication of revalidated terminal candidate.',
      policySha256: sha('f'),
      repoRoot: '/tmp/repo',
      runId,
      stagePlan: [
        { requirement: 'required', stageId: 'intent' },
        { requirement: 'required', stageId: 'rebase' },
        { requirement: 'required', stageId: 'review' },
        { requirement: 'required', stageId: 'test' },
        { requirement: 'required', stageId: 'push' }
      ],
      submissionCommitOid: oidS
    })

    const evIntentSha = sha('1')
    ledger.recordEvidence({
      artifactPath: '/tmp/intent.json',
      artifactSha256: sha('a'),
      baseCommitOid: oidS,
      candidateCommitOid: oidS,
      evidenceSha256: evIntentSha,
      exitCode: 0,
      roundIndex: 0,
      runId,
      stageId: 'intent',
      summary: 'intent confirmed',
      workerIdentity: 'authoritative:intent'
    })
    ledger.recordCheckpoint({
      inputCommitOid: oidS,
      outputCommitOid: oidS,
      roundIndex: 0,
      runId,
      stageId: 'intent'
    })
    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: evIntentSha,
      runId,
      stageId: 'intent'
    })

    const evRebaseSha = sha('2')
    ledger.recordEvidence({
      artifactPath: '/tmp/rebase.json',
      artifactSha256: sha('b'),
      baseCommitOid: oidS,
      candidateCommitOid: oidR,
      evidenceSha256: evRebaseSha,
      exitCode: 0,
      roundIndex: 0,
      runId,
      stageId: 'rebase',
      summary: 'rebased onto main',
      workerIdentity: 'authoritative:rebase'
    })
    ledger.recordCheckpoint({
      inputCommitOid: oidS,
      outputCommitOid: oidR,
      roundIndex: 0,
      runId,
      stageId: 'rebase'
    })
    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: evRebaseSha,
      runId,
      stageId: 'rebase'
    })

    // Review round 0 fixer advanced R to C
    ledger.recordCheckpoint({
      inputCommitOid: oidR,
      outputCommitOid: oidC,
      roundIndex: 0,
      runId,
      stageId: 'review'
    })

    // Review round 1 revalidated candidate C
    const evReviewSha = sha('3')
    ledger.recordEvidence({
      artifactPath: '/tmp/review.json',
      artifactSha256: sha('c'),
      baseCommitOid: oidR,
      candidateCommitOid: oidC,
      evidenceSha256: evReviewSha,
      exitCode: 0,
      roundIndex: 1,
      runId,
      stageId: 'review',
      summary: 'review revalidation passed',
      workerIdentity: 'authoritative:reviewer'
    })
    ledger.recordCheckpoint({
      inputCommitOid: oidC,
      outputCommitOid: oidC,
      roundIndex: 1,
      runId,
      stageId: 'review'
    })
    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: evReviewSha,
      runId,
      stageId: 'review'
    })

    // Test stage round 0 ran on candidate C
    const evTestSha = sha('4')
    ledger.recordEvidence({
      artifactPath: '/tmp/test.json',
      artifactSha256: sha('d'),
      baseCommitOid: oidR,
      candidateCommitOid: oidC,
      evidenceSha256: evTestSha,
      exitCode: 0,
      roundIndex: 0,
      runId,
      stageId: 'test',
      summary: 'test passed',
      workerIdentity: 'authoritative:test'
    })
    ledger.recordCheckpoint({
      inputCommitOid: oidC,
      outputCommitOid: oidC,
      roundIndex: 0,
      runId,
      stageId: 'test'
    })
    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: evTestSha,
      runId,
      stageId: 'test'
    })

    const candidate = terminalCandidate(ledger, runId, false)
    assert.equal(candidate, oidC)
  } finally {
    ledger.close()
  }
})

test('isCandidateReachable confirms forward custody and rejects backward jumps', () => {
  const oidA = oid(1)
  const oidB = oid(2)
  const oidC = oid(3)
  const oidD = oid(4)
  const oidE = oid(5)

  const checkpoints = [
    { input_commit_oid: oidA, output_commit_oid: oidB, round_index: 0, stage_id: 'review' },
    { input_commit_oid: oidB, output_commit_oid: oidC, round_index: 0, stage_id: 'document' },
    { input_commit_oid: oidC, output_commit_oid: oidD, round_index: 1, stage_id: 'review' },
    { input_commit_oid: oidB, output_commit_oid: oidE, round_index: 1, stage_id: 'document' }
  ]

  assert.equal(isCandidateReachable(oidA, oidD, checkpoints), true)
  assert.equal(isCandidateReachable(oidB, oidD, checkpoints), true)
  assert.equal(isCandidateReachable(oidD, oidB, checkpoints), false)
  assert.equal(isCandidateReachable(oidD, oidE, checkpoints), false)
})

test('TUI does not fabricate fixer activity on round 2 when findings were not fixed', async () => {
  const input = new FakeInput()
  const output = new FakeOutput()
  const renderer = new RailTuiRenderer(input, output, '/unused')

  const base = snapshot('review', 1)
  renderer.render({ ...base, transition: { kind: 'round-started', role: 'reviewer', round: 0, stage: 'review' } })
  renderer.render({
    ...base,
    transition: {
      actionable: 2,
      kind: 'findings-recorded',
      round: 0,
      stage: 'review',
      total: 2
    }
  })
  renderer.render({
    ...base,
    transition: {
      decision: 'approve',
      gateId: 'g1',
      kind: 'gate-resolved',
      round: 0,
      stage: 'review'
    }
  })

  // Round 2 reviewer starts without any fixer having executed
  renderer.render({
    ...base,
    transition: {
      kind: 'round-started',
      role: 'reviewer',
      round: 1,
      stage: 'review'
    }
  })

  await nextDraw()
  const screen = cleanScreen(output.writes.at(-1) ?? '')
  assert.match(screen, /Review analysis 1 · 2 found/u)
  assert.match(screen, /Review approved/u)
  assert.match(screen, /Review analysis 2/u)
  assert.doesNotMatch(screen, /Review fix 1/u)
  renderer.close()
})
