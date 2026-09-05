import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { DomainLedger } from '../scripts/ledger.ts'
import {
  pullRequestArtifacts,
  pullRequestPipelineRounds,
  recoverFixRecords,
  type StageReport
} from '../scripts/orca-no-mistakes.ts'
import type { PresentationSnapshot } from '../scripts/presentation.ts'
import { pullRequestContent, type PullRequestPipelineStep } from '../scripts/pull-request.ts'

test('pullRequestArtifacts requires recorded expected digest and skips missing-digest artifacts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'onm-pr-digest-reg-'))
  try {
    const artifactName = 'test-artifact.log'
    const artifactPath = path.join(dir, artifactName)
    const content = 'valid artifact preview content'
    const expectedDigest = createHash('sha256').update(content).digest('hex')
    const trustedPublicationApprovals = [expectedDigest]
    await writeFile(artifactPath, content)

    // 1. Missing artifactDigests entirely -> skipped
    const reportNoDigests: StageReport = {
      artifacts: [artifactName],
      findings: [],
      summary: 'no digests record'
    }
    const skippedMissing = await pullRequestArtifacts(dir, reportNoDigests, { trustedPublicationApprovals })
    assert.equal(skippedMissing.length, 0)

    // 2. artifactDigests present but missing this artifact -> skipped
    const reportEmptyDigests: StageReport = {
      artifactDigests: {},
      artifacts: [artifactName],
      findings: [],
      summary: 'empty digests record'
    }
    const skippedEmpty = await pullRequestArtifacts(dir, reportEmptyDigests, { trustedPublicationApprovals })
    assert.equal(skippedEmpty.length, 0)

    // 3. Matching digest without trusted approval -> metadata only
    const reportValid: StageReport = {
      artifactDigests: { [artifactName]: expectedDigest },
      artifacts: [artifactName],
      findings: [],
      summary: 'valid digest record'
    }
    const withheld = await pullRequestArtifacts(dir, reportValid)
    assert.equal(withheld.length, 1)
    assert.ok(withheld[0].content.includes(`SHA-256: ${expectedDigest}`))
    assert.ok(withheld[0].content.includes(`Size: ${Buffer.byteLength(content)} bytes`))
    assert.match(withheld[0].content, /Artifact content withheld/)
    assert.ok(!withheld[0].content.includes(content))

    // Exact-content trusted approval permits the preview
    const included = await pullRequestArtifacts(dir, reportValid, { trustedPublicationApprovals })
    assert.equal(included.length, 1)
    assert.equal(included[0]?.content, content)

    // 4. Mismatched expected digest -> skipped
    const reportMismatch: StageReport = {
      artifactDigests: { [artifactName]: 'a'.repeat(64) },
      artifacts: [artifactName],
      findings: [],
      summary: 'mismatched digest record'
    }
    const skippedMismatch = await pullRequestArtifacts(dir, reportMismatch, { trustedPublicationApprovals })
    assert.equal(skippedMismatch.length, 0)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
})

test('branchIntents orders by rowid preserving lifecycle sequence across clock rollback', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-clock-rollback-'))
  const dbPath = path.join(temp, 'ledger.db')
  const ledger = new DomainLedger(dbPath)
  const repoRoot = path.join(temp, 'repo')
  const branch = 'feature/rollback'
  try {
    ledger.startRun({
      baseBranch: 'main',
      branch,
      intent: 'First branch intent',
      policySha256: 'a'.repeat(64),
      repoRoot,
      runId: 'run-1',
      submissionCommitOid: '1'.repeat(40)
    })

    const genToken = ledger.acquireLease({ branch, repoRoot, runId: 'run-1' })
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'att-1',
      coordinatorIdentity: 'coordinator',
      generationToken: genToken,
      runId: 'run-1',
      startedAt: '2026-09-02T10:00:00.000Z'
    })

    const obsSha = ledger.recordRemoteObservation({
      attemptId: 'att-1',
      kind: 'pull-request',
      observedAt: '2026-09-02T12:00:00.000Z',
      payload: {
        baseBranch: 'main',
        bodySha256: 'c'.repeat(64),
        candidateCommitOid: '1'.repeat(40),
        forgeHost: 'github.com',
        headBranch: branch,
        headOwner: 'owner',
        headRepositoryId: 'repo',
        number: 101,
        pullRequestNodeId: 'PR_node1',
        state: 'merged',
        titleSha256: 'd'.repeat(64)
      },
      runId: 'run-1',
      subject: 'github.com/owner/repo#101'
    })

    const db = new DatabaseSync(dbPath)
    db.prepare(
      `INSERT INTO remote_receipts (
         receipt_id, run_id, kind, candidate_commit_oid,
         authoritative_post_observation_sha256, receipt_json, receipt_sha256, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      'run-1',
      'pull-request-binding',
      '1'.repeat(40),
      obsSha,
      JSON.stringify({ state: 'merged' }),
      'e'.repeat(64),
      '2026-09-02T12:00:00.000Z'
    )

    ledger.startRun({
      baseBranch: 'main',
      branch,
      intent: 'Second branch intent',
      policySha256: 'b'.repeat(64),
      repoRoot,
      runId: 'run-2',
      submissionCommitOid: '2'.repeat(40)
    })

    // Simulate system clock moving backward so run-2 has an earlier created_at than run-1
    db.prepare("UPDATE runs SET created_at = '2026-09-05T12:00:00.000Z' WHERE run_id = 'run-1'").run()
    db.prepare("UPDATE runs SET created_at = '2026-09-05T10:00:00.000Z' WHERE run_id = 'run-2'").run()

    // With run-1 merged, branchIntents for run-2 starts after run-1 boundary (rowid order preserved)
    const postMergeIntents = ledger.branchIntents(repoRoot, branch, 'run-2')
    assert.deepEqual(postMergeIntents, ['Second branch intent'])

    // Without a merged PR boundary on a new branch with rollback, rowid preserves both intents
    const branch2 = 'feature/rollback-unmerged'
    ledger.startRun({
      baseBranch: 'main',
      branch: branch2,
      intent: 'Branch2 intent 1',
      policySha256: 'a'.repeat(64),
      repoRoot,
      runId: 'b2-run-1',
      submissionCommitOid: '1'.repeat(40)
    })
    ledger.startRun({
      baseBranch: 'main',
      branch: branch2,
      intent: 'Branch2 intent 2',
      policySha256: 'b'.repeat(64),
      repoRoot,
      runId: 'b2-run-2',
      submissionCommitOid: '2'.repeat(40)
    })
    db.prepare("UPDATE runs SET created_at = '2026-09-05T12:00:00.000Z' WHERE run_id = 'b2-run-1'").run()
    db.prepare("UPDATE runs SET created_at = '2026-09-05T10:00:00.000Z' WHERE run_id = 'b2-run-2'").run()

    const unmergedIntents = ledger.branchIntents(repoRoot, branch2, 'b2-run-2')
    assert.deepEqual(unmergedIntents, ['Branch2 intent 1', 'Branch2 intent 2'])
  } finally {
    ledger.close()
    await rm(temp, { force: true, recursive: true })
  }
})

test('legacy fix summaries correctly associate when prior analysis had no fix and unassociated render clearly', () => {
  // Scenario: Analysis 1 had finding F1 approved as-is (NO fixer ran).
  // Analysis 2 had finding F2, fixer ran with summary 'fixed F2'.
  // Analysis 3 re-checked cleanly.
  const snapshots: PresentationSnapshot[] = [
    {
      attempt: 1,
      mode: { autoFix: true },
      runId: 'run-leg',
      sequence: 1,
      stages: [{
        actionableFindings: 1,
        analysis: 1,
        id: 'review',
        round: 0,
        status: 'active',
        totalFindings: 1
      }],
      status: 'in-progress',
      transition: { analysis: 1, kind: 'round-started', role: 'reviewer', round: 0, stage: 'review' },
      updatedAt: '',
      version: 1
    },
    {
      attempt: 1,
      mode: { autoFix: true },
      runId: 'run-leg',
      sequence: 2,
      stages: [{
        actionableFindings: 1,
        analysis: 1,
        findings: [{ description: 'f1', disposition: 'approved', id: 'f1', severity: 'warning' }],
        id: 'review',
        round: 0,
        status: 'active',
        totalFindings: 1
      }],
      status: 'in-progress',
      transition: { decision: 'approve', gateId: 'g1', kind: 'gate-resolved', round: 0, stage: 'review' },
      updatedAt: '',
      version: 1
    },
    {
      attempt: 1,
      mode: { autoFix: true },
      runId: 'run-leg',
      sequence: 3,
      stages: [{
        actionableFindings: 1,
        analysis: 2,
        id: 'review',
        round: 1,
        status: 'active',
        totalFindings: 1
      }],
      status: 'in-progress',
      transition: { analysis: 2, kind: 'round-started', role: 'reviewer', round: 1, stage: 'review' },
      updatedAt: '',
      version: 1
    },
    {
      attempt: 1,
      mode: { autoFix: true },
      runId: 'run-leg',
      sequence: 4,
      stages: [{
        actionableFindings: 1,
        analysis: 2,
        id: 'review',
        round: 2,
        status: 'active',
        totalFindings: 1
      }],
      status: 'in-progress',
      transition: {
        analysis: 2,
        approvedFindings: 0,
        findingIds: ['f2'],
        fixAttempt: 0,
        kind: 'fix-completed',
        round: 2,
        stage: 'review',
        summary: 'fixed F2'
      },
      updatedAt: '',
      version: 1
    },
    {
      attempt: 1,
      mode: { autoFix: true },
      runId: 'run-leg',
      sequence: 5,
      stages: [{
        actionableFindings: 0,
        analysis: 3,
        id: 'review',
        round: 2,
        status: 'passed',
        totalFindings: 0
      }],
      status: 'in-progress',
      transition: { analysis: 3, kind: 'round-started', role: 'reviewer', round: 2, stage: 'review' },
      updatedAt: '',
      version: 1
    }
  ]

  const stageState = {
    fixSummaries: ['fixed F2']
  }

  const recovered = recoverFixRecords('review', stageState, snapshots)
  assert.equal(recovered.length, 1)
  assert.deepEqual(recovered[0], {
    analysis: 2,
    fixAttempt: 0,
    summary: 'fixed F2'
  })

  const reports: StageReport[] = [
    { findings: [{ action: 'auto-fix', description: 'f1', id: 'f1', severity: 'warning' }], summary: 'analysis 1' },
    { findings: [{ action: 'auto-fix', description: 'f2', id: 'f2', severity: 'error' }], summary: 'analysis 2' },
    { findings: [], summary: 'analysis 3' }
  ]

  const rounds = pullRequestPipelineRounds(reports, recovered, [
    { description: 'f1', disposition: 'approved', id: 'f1', severity: 'warning' },
    { description: 'f2', disposition: 'fixed', id: 'f2', severity: 'error' }
  ])

  assert.equal(rounds.length, 3)
  // Round 0 (analysis 1) had no fix
  assert.equal(rounds[0].fixSummary, undefined)
  // Round 1 (analysis 2) was the analysis that found F2; its fix is re-checked in round 2
  assert.equal(rounds[1].fixSummary, undefined)
  // Round 2 (analysis 3) is the re-check of fix for analysis 2
  assert.equal(rounds[2].fixSummary, 'fixed F2')

  // Unassociated legacy strings render as clearly labeled historical fixer summaries without claiming a specific analysis
  const unprovableRounds = pullRequestPipelineRounds(reports, ['unprovable legacy fix'], [])
  assert.equal(unprovableRounds[0].fixSummary, undefined)
  assert.equal(unprovableRounds[1].fixSummary, undefined)
  assert.equal(unprovableRounds[2].fixSummary, undefined)
  assert.deepEqual(unprovableRounds[2].historicalFixSummaries, ['unprovable legacy fix'])

  const content = pullRequestContent('feat: test legacy summaries', {
    candidateCommitOid: '1'.repeat(40),
    pipelineSteps: [{
      name: 'review',
      rounds: unprovableRounds,
      status: 'completed'
    }],
    risk: { level: 'low', rationale: 'none' },
    testing: { artifacts: [], summary: 'passed', tested: [] },
    whatChanged: 'legacy fix summary verification'
  })

  assert.match(content.body, /🔧 Historical fix: unprovable legacy fix/)
  assert.doesNotMatch(content.body, /🔧 Fix: unprovable legacy fix/)
})

test('pipeline details dynamically allocate preserving details exceeding 4 KiB when fitting total budget', () => {
  const largeDetail = 'Important finding explanation line.\n'.repeat(150)
  assert.ok(Buffer.byteLength(largeDetail) > 4096)

  const steps: PullRequestPipelineStep[] = [
    {
      details: largeDetail,
      name: 'review',
      status: 'completed'
    },
    {
      details: 'Test stage passed without incident.',
      name: 'test',
      status: 'completed'
    }
  ]

  const result = pullRequestContent('feat: test dynamic pipeline detail allocation', {
    candidateCommitOid: 'a'.repeat(40),
    pipelineSteps: steps,
    risk: { level: 'low', rationale: 'Risk is well understood.' },
    testing: { artifacts: [], summary: 'All tests passed.', tested: ['npm test'] },
    whatChanged: 'Dynamic detail allocation.'
  })

  // Full detail is preserved without per-stage 4096-byte truncation
  assert.ok(result.body.includes(largeDetail))
  assert.doesNotMatch(result.body, /_\[truncated to fit GitHub PR body limits\]_/)

  // Genuinely over-budget pipeline details retain explicit truncation and later-stage visibility
  const giantDetail = 'Over-budget detail line that will be capped.\n'.repeat(400)
  const overBudgetSteps: PullRequestPipelineStep[] = [
    {
      details: giantDetail,
      name: 'review',
      status: 'completed'
    },
    {
      details: 'Later stage remains visible despite earlier giant stage.',
      name: 'lint',
      status: 'completed'
    }
  ]

  const overBudgetResult = pullRequestContent('feat: test over budget allocation', {
    candidateCommitOid: 'a'.repeat(40),
    pipelineSteps: overBudgetSteps,
    risk: { level: 'low', rationale: 'none' },
    testing: { artifacts: [], summary: 'ok', tested: [] },
    whatChanged: 'Over budget test.'
  })

  assert.ok(Buffer.byteLength(overBudgetResult.body) <= 63_488)
  assert.match(overBudgetResult.body, /_\[truncated to fit GitHub PR body limits\]_/)
  assert.match(overBudgetResult.body, /Later stage remains visible despite earlier giant stage\./)
})
