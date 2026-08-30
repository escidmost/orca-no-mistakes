import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  DomainLedger,
  buildPipelineCompletionAttestation,
  evidenceSha256,
  sha256,
  type PipelineCompletionAttestationManifest,
  type StageEvidenceManifestEntry
} from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const commit = 'a'.repeat(40)
const policy = 'b'.repeat(64)

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function stageEvidence(runId: string, stage: 'pr' | 'push', round: number): StageEvidenceManifestEntry {
  const entry: StageEvidenceManifestEntry = {
    artifactSha256: sha256(`${stage}-artifact`),
    baseCommitOid: commit,
    candidateCommitOid: commit,
    evidenceSha256: '',
    exitCode: 0,
    round,
    stage,
    summary: `${stage} verified.`,
    workerIdentity: 'coordinator'
  }
  entry.evidenceSha256 = evidenceSha256({ ...entry, runId })
  return entry
}

function completionFacts(
  ledger: DomainLedger,
  runId: string,
  verdict: 'failed' | 'passed' = 'passed'
): { manifest: PipelineCompletionAttestationManifest; publicationObservation: string } {
  const intent = `Complete ${runId}.`
  const evidence = [stageEvidence(runId, 'push', 0), stageEvidence(runId, 'pr', 1)]
  ledger.startRun({
    baseBranch: 'main',
    branch: 'feature',
    intent,
    policySha256: policy,
    repoRoot: '/repo',
    runId,
    stagePlan: evidence.map((entry) => ({ requirement: 'required', stageId: entry.stage })),
    submissionCommitOid: commit
  })
  for (const entry of evidence) {
    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: entry.evidenceSha256,
      runId,
      stageId: entry.stage
    })
  }
  const publicationRoute = {
    baseBranch: 'main',
    baseRepositoryId: 'R_base',
    forgeHost: 'github.com',
    headBranch: 'feature',
    headOwner: 'owner',
    headRepositoryId: 'R_head'
  }
  const routeFingerprint = ledger.recordPublicationRoute({ ...publicationRoute, runId })
  const attemptId = `${runId}-attempt`
  ledger.startAttempt({
    actorIdentity: 'operator',
    attemptId,
    coordinatorIdentity: 'coordinator',
    generationToken: 1,
    runId,
    startedAt: '2026-08-30T12:00:00.000Z'
  })
  const unrelatedObservation = ledger.recordRemoteObservation({
    attemptId,
    kind: 'publication-head',
    observedAt: '2026-08-30T12:00:01.000Z',
    payload: { state: 'absent' },
    runId,
    subject: 'refs/heads/feature'
  })
  const publicationObservation = ledger.recordRemoteObservation({
    attemptId,
    kind: 'publication-head',
    observedAt: '2026-08-30T12:00:02.000Z',
    payload: { oid: commit },
    runId,
    subject: 'refs/heads/feature'
  })
  const push = evidence[0]
  const pushSettlement = {
    checkpoint: { inputCommitOid: commit, outputCommitOid: commit, roundIndex: 0 },
    evidence: {
      artifactPath: `/tmp/${runId}-push.json`,
      artifactSha256: push.artifactSha256,
      baseCommitOid: commit,
      candidateCommitOid: commit,
      evidenceSha256: push.evidenceSha256,
      exitCode: 0,
      roundIndex: 0,
      runId,
      stageId: 'push',
      summary: push.summary,
      workerIdentity: push.workerIdentity
    },
    receipt: {
      authoritativePostObservationSha256: unrelatedObservation,
      candidateCommitOid: commit,
      kind: 'candidate-publication',
      payload: { routeFingerprint }
    },
    runId,
    stageId: 'push'
  } as const
  assert.throws(
    () => ledger.settleRemoteStage(pushSettlement),
    /does not match its authoritative post-read observation/
  )
  const publicationReceipt = ledger.settleRemoteStage({
    ...pushSettlement,
    receipt: {
      ...pushSettlement.receipt,
      authoritativePostObservationSha256: publicationObservation
    }
  }).receiptSha256
  const pullRequestObservation = ledger.recordRemoteObservation({
    attemptId,
    kind: 'pull-request',
    observedAt: '2026-08-30T12:00:03.000Z',
    payload: { candidateCommitOid: commit, number: 77 },
    runId,
    subject: 'owner/repo#77'
  })
  const pr = evidence[1]
  const pullRequestReceipt = ledger.settleRemoteStage({
    checkpoint: { inputCommitOid: commit, outputCommitOid: commit, roundIndex: 1 },
    evidence: {
      artifactPath: `/tmp/${runId}-pr.json`,
      artifactSha256: pr.artifactSha256,
      baseCommitOid: commit,
      candidateCommitOid: commit,
      evidenceSha256: pr.evidenceSha256,
      exitCode: 0,
      roundIndex: 1,
      runId,
      stageId: 'pr',
      summary: pr.summary,
      workerIdentity: pr.workerIdentity
    },
    receipt: {
      authoritativePostObservationSha256: pullRequestObservation,
      candidateCommitOid: commit,
      kind: 'pull-request-binding',
      payload: { number: 77, routeFingerprint }
    },
    runId,
    stageId: 'pr'
  }).receiptSha256
  const custody = { recoveryRef: `refs/no-mistakes/recover/${runId}` }
  const outcome = ledger.recordAttemptOutcome({
    actorIdentity: 'operator',
    attemptId,
    candidateCommitOid: commit,
    completedAt: '2026-08-30T12:00:04.000Z',
    coordinatorIdentity: 'coordinator',
    custody,
    reason: verdict === 'passed' ? 'pipeline completed' : 'publication failed',
    receiptDigests: [publicationReceipt, pullRequestReceipt],
    resumeEligible: verdict === 'failed',
    runId,
    stoppingFact: verdict === 'passed' ? 'pull-request-bound' : 'remote-failure',
    verdict
  })
  assert.equal(ledger.finishRun(runId, 'passed', commit), true)
  return {
    manifest: buildPipelineCompletionAttestation(evidence, {
      attemptOutcomeDigests: [outcome],
      baseCommitOid: commit,
      candidateCommitOid: commit,
      candidatePublicationReceiptSha256: publicationReceipt,
      custody,
      intent,
      policySha256: policy,
      publicationRoute: { ...publicationRoute, routeFingerprint },
      pullRequestBindingReceiptSha256: pullRequestReceipt,
      runId,
      stageDispositions: evidence.map((entry) => ({
        disposition: 'satisfied',
        evidenceSha256: entry.evidenceSha256,
        stage: entry.stage
      })),
      stagePlan: evidence.map((entry) => ({ requirement: 'required', stage: entry.stage }))
    }),
    publicationObservation
  }
}

test('attached linked worktrees migrate using the origin repository identity', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-linked-migration-'))
  const repo = path.join(temp, 'repo')
  const gate = path.join(temp, 'gate')
  const home = path.join(temp, 'home')
  const names = [
    'HOME',
    'NO_MISTAKES_GATE_BRANCH',
    'NO_MISTAKES_GATE_WORKTREE_ID',
    'NO_MISTAKES_ORIGIN_WORKTREE',
    'ORCA_NO_MISTAKES_HOME'
  ] as const
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await writeFile(path.join(repo, 'README.md'), 'seed\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'seed')
    git(repo, 'worktree', 'add', '-b', 'gate-branch', gate)
    process.env.HOME = home
    delete process.env.ORCA_NO_MISTAKES_HOME
    const origin = await realpath(repo)
    const legacy = new DomainLedger(path.join(home, '.orca-no-mistakes', 'ledger.db'))
    legacy.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'Retain the active origin run.',
      policySha256: policy,
      repoRoot: origin,
      runId: 'active-origin-run',
      submissionCommitOid: commit
    })
    legacy.close()
    Object.assign(process.env, {
      NO_MISTAKES_GATE_BRANCH: 'gate-branch',
      NO_MISTAKES_GATE_WORKTREE_ID: 'gate-id',
      NO_MISTAKES_ORIGIN_WORKTREE: origin
    })
    await assert.rejects(
      main(['run', '--attached', `--repo=${gate}`, '--base=main', '--intent=Verify migration.']),
      /cannot migrate repository state: run active-origin-run is still in-progress/
    )
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(temp, { recursive: true, force: true })
  }
})

test('v2 receipts, outcomes, and child facts remain bound to passed runs', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-v2-integrity-'))
  const dbPath = path.join(temp, 'ledger.sqlite')
  const ledger = new DomainLedger(dbPath)
  const failedLedger = new DomainLedger(':memory:')
  try {
    const { manifest, publicationObservation } = completionFacts(ledger, 'passed-run')
    const wrongIntent = buildPipelineCompletionAttestation(manifest.stageEvidence, {
      ...manifest,
      intent: 'Different retained intent.'
    })
    assert.throws(() => ledger.recordAttestation(wrongIntent), /passed run/)
    ledger.recordAttestation(manifest)

    const failed = completionFacts(failedLedger, 'failed-only-run', 'failed')
    assert.throws(
      () => failedLedger.recordAttestation(failed.manifest),
      /passed attempt outcome/
    )

    const direct = new DatabaseSync(dbPath)
    assert.throws(
      () => direct.prepare(
        'DELETE FROM remote_observations WHERE observation_sha256 = ?'
      ).run(publicationObservation),
      /remote_observations rows are immutable/
    )
    direct.close()
    assert.equal(ledger.prune(['passed-run']), 1)
    assert.equal(ledger.runStatus('passed-run'), undefined)
  } finally {
    failedLedger.close()
    ledger.close()
    await rm(temp, { recursive: true, force: true })
  }
})
