import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import {
  buildPipelineCompletionAttestation,
  DomainLedger,
  evidenceSha256,
  repositoryLedgerPath,
  sha256,
  type StageEvidenceManifestEntry
} from '../scripts/ledger.ts'

const execFileAsync = promisify(execFile)
const base = 'a'.repeat(40)
const candidate = 'b'.repeat(40)
const submission = 'c'.repeat(40)
const policy = 'd'.repeat(64)

test('concurrent first opens converge on one repository migration', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-migration-race-'))
  const repo = path.join(temp, 'repo')
  const legacyPath = path.join(temp, 'legacy.sqlite')
  try {
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
    const repoRoot = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8'
    }).trim()
    new DomainLedger(legacyPath).close()
    const legacy = new DatabaseSync(legacyPath)
    legacy.exec('BEGIN IMMEDIATE')
    const insert = legacy.prepare(
      `INSERT INTO runs (
         run_id, repo_root, branch, base_branch, submission_commit_oid,
         intent, intent_hash, policy_sha256, status, created_at, completed_at
       ) VALUES (?, ?, ?, 'main', ?, 'migrate', ?, ?, 'failed', ?, ?)`
    )
    for (let index = 0; index < 1_500; index += 1) {
      insert.run(
        `legacy-${index}`,
        repoRoot,
        `feature-${index}`,
        submission,
        sha256('migrate'),
        policy,
        '2026-08-30T12:00:00.000Z',
        '2026-08-30T12:00:01.000Z'
      )
    }
    legacy.exec('COMMIT')
    legacy.close()

    const moduleUrl = pathToFileURL(path.resolve('scripts/ledger.ts')).href
    const child = `
      import { DomainLedger } from ${JSON.stringify(moduleUrl)};
      new DomainLedger({ legacyPath: ${JSON.stringify(legacyPath)}, repositoryPath: ${JSON.stringify(repo)} }).close();
    `
    await Promise.all(Array.from({ length: 6 }, () => execFileAsync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', child],
      { env: { ...process.env, NODE_NO_WARNINGS: '1' } }
    )))

    const repository = new DatabaseSync(repositoryLedgerPath(repo))
    assert.equal(
      (repository.prepare('SELECT COUNT(*) AS count FROM repository_migrations').get() as {
        count: number | bigint
      }).count,
      1
    )
    assert.equal(
      (repository.prepare('SELECT COUNT(*) AS count FROM runs').get() as {
        count: number | bigint
      }).count,
      1_500
    )
    repository.close()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

async function completionFixture(startNewerAttempt: boolean) {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-v2-resume-'))
  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
  const runId = startNewerAttempt ? 'stale-completion' : 'resumed-completion'
  const intent = 'Resume after durable candidate publication.'
  const artifact = Buffer.from('{}')
  const entries: (StageEvidenceManifestEntry & { artifactPath: string })[] = []
  for (const [round, stage] of ['push', 'pr'].entries()) {
    const artifactPath = path.join(temp, `${stage}.json`)
    await writeFile(artifactPath, artifact)
    const entry = {
      artifactPath,
      artifactSha256: sha256(artifact),
      baseCommitOid: base,
      candidateCommitOid: candidate,
      evidenceSha256: '',
      exitCode: 0,
      round,
      stage,
      summary: `${stage} completed.`,
      workerIdentity: 'coordinator'
    }
    entry.evidenceSha256 = evidenceSha256({ ...entry, runId })
    entries.push(entry)
  }
  ledger.startRun({
    baseBranch: 'main',
    branch: 'feature',
    intent,
    policySha256: policy,
    repoRoot: '/repo',
    runId,
    stagePlan: [
      { requirement: 'required', stageId: 'push' },
      { requirement: 'required', stageId: 'pr' }
    ],
    submissionCommitOid: submission
  })
  for (const entry of entries.toReversed()) {
    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: entry.evidenceSha256,
      runId,
      stageId: entry.stage
    })
  }
  const route = {
    baseBranch: 'main',
    baseRepositoryId: 'R_base',
    forgeHost: 'github.com',
    headBranch: 'feature',
    headOwner: 'owner',
    headRepositoryId: 'R_head'
  }
  const routeFingerprint = ledger.recordPublicationRoute({ ...route, runId })
  ledger.recordPublicationBaseline({
    headCommitOid: null,
    observedAt: '2026-08-30T12:00:00.000Z',
    routeFingerprint,
    runId
  })
  ledger.startAttempt({
    actorIdentity: 'operator',
    attemptId: 'publication-attempt',
    coordinatorIdentity: 'coordinator',
    generationToken: 1,
    runId,
    startedAt: '2026-08-30T12:00:00.000Z'
  })
  const preRead = ledger.recordRemoteObservation({
    attemptId: 'publication-attempt',
    kind: 'publication-head',
    observedAt: '2026-08-30T12:00:01.000Z',
    payload: {
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      repositoryId: 'R_head',
      state: 'absent'
    },
    runId,
    subject: 'github.com/R_head:refs/heads/feature'
  })
  const publicationIntent = ledger.recordMutationIntent({
    attemptId: 'publication-attempt',
    createdAt: '2026-08-30T12:00:02.000Z',
    kind: 'candidate-publication',
    payload: { expected: 'absent', update: candidate },
    runId,
    targetFingerprint: routeFingerprint
  })
  const postRead = ledger.recordRemoteObservation({
    attemptId: 'publication-attempt',
    kind: 'publication-head',
    observedAt: '2026-08-30T12:00:03.000Z',
    payload: {
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      oid: candidate,
      repositoryId: 'R_head'
    },
    runId,
    subject: 'github.com/R_head:refs/heads/feature'
  })
  const evidenceFor = (stage: 'pr' | 'push') => {
    const entry = entries.find((candidateEntry) => candidateEntry.stage === stage)!
    return {
      artifactPath: entry.artifactPath,
      artifactSha256: entry.artifactSha256,
      baseCommitOid: base,
      candidateCommitOid: candidate,
      evidenceSha256: entry.evidenceSha256,
      exitCode: 0,
      roundIndex: entry.round,
      runId,
      stageId: stage,
      summary: entry.summary,
      workerIdentity: entry.workerIdentity
    }
  }
  const publicationReceipt = ledger.settleRemoteStage({
    checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 0 },
    evidence: evidenceFor('push'),
    receipt: {
      authoritativePostObservationSha256: postRead,
      candidateCommitOid: candidate,
      kind: 'candidate-publication',
      payload: {
        mutationIntent: publicationIntent,
        outcome: 'created',
        postRead,
        preRead,
        routeFingerprint
      }
    },
    runId,
    stageId: 'push'
  }).receiptSha256
  const failedOutcome = ledger.recordAttemptOutcome({
    actorIdentity: 'operator',
    attemptId: 'publication-attempt',
    candidateCommitOid: candidate,
    completedAt: '2026-08-30T12:00:04.000Z',
    coordinatorIdentity: 'coordinator',
    custody: { recoveryRef: `refs/no-mistakes/recover/${runId}` },
    reason: 'publication completed before interruption',
    receiptDigests: [publicationReceipt],
    resumeEligible: true,
    runId,
    stoppingFact: 'candidate-publication-verified',
    verdict: 'failed'
  })
  ledger.startAttempt({
    actorIdentity: 'operator',
    attemptId: 'completion-attempt',
    coordinatorIdentity: 'coordinator',
    generationToken: 2,
    runId,
    startedAt: '2026-08-30T12:00:05.000Z'
  })
  const pullRequestIntent = ledger.recordMutationIntent({
    attemptId: 'completion-attempt',
    createdAt: '2026-08-30T12:00:06.000Z',
    kind: 'pull-request',
    payload: {
      action: 'ensure-open',
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      candidateCommitOid: candidate,
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_head'
    },
    runId,
    targetFingerprint: routeFingerprint
  })
  const pullRequestObservation = ledger.recordRemoteObservation({
    attemptId: 'completion-attempt',
    kind: 'pull-request',
    observedAt: '2026-08-30T12:00:07.000Z',
    payload: {
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      candidateCommitOid: candidate,
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_head',
      number: 77,
      state: 'open'
    },
    runId,
    subject: 'github.com/R_base#77'
  })
  const pullRequestReceipt = ledger.settleRemoteStage({
    checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 1 },
    evidence: evidenceFor('pr'),
    receipt: {
      authoritativePostObservationSha256: pullRequestObservation,
      candidateCommitOid: candidate,
      kind: 'pull-request-binding',
      payload: {
        mutationIntent: pullRequestIntent,
        number: 77,
        outcome: 'created',
        postRead: pullRequestObservation,
        routeFingerprint
      }
    },
    runId,
    stageId: 'pr'
  }).receiptSha256
  const custody = { recoveryRef: `refs/no-mistakes/recover/${runId}` }
  const passedOutcome = ledger.recordAttemptOutcome({
    actorIdentity: 'operator',
    attemptId: 'completion-attempt',
    candidateCommitOid: candidate,
    completedAt: '2026-08-30T12:00:08.000Z',
    coordinatorIdentity: 'coordinator',
    custody,
    reason: 'pull request bound',
    receiptDigests: [publicationReceipt, pullRequestReceipt],
    resumeEligible: false,
    runId,
    stoppingFact: 'pull-request-bound',
    verdict: 'passed'
  })
  if (startNewerAttempt) {
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId: 'newer-attempt',
      coordinatorIdentity: 'coordinator',
      generationToken: 3,
      runId,
      startedAt: '2026-08-30T12:00:09.000Z'
    })
  }
  ledger.finishRun(runId, 'passed', candidate)
  const stageEvidence = entries.map(({ artifactPath: _artifactPath, ...entry }) => entry)
  const manifest = buildPipelineCompletionAttestation(stageEvidence, {
    attemptOutcomeDigests: [failedOutcome, passedOutcome],
    baseCommitOid: base,
    candidateCommitOid: candidate,
    candidatePublicationReceiptSha256: publicationReceipt,
    custody,
    intent,
    policySha256: policy,
    publicationRoute: { ...route, routeFingerprint },
    pullRequestBindingReceiptSha256: pullRequestReceipt,
    runId,
    stageDispositions: stageEvidence.map((entry) => ({
      disposition: 'satisfied',
      evidenceSha256: entry.evidenceSha256,
      stage: entry.stage
    })),
    stagePlan: [
      { requirement: 'required', stage: 'push' },
      { requirement: 'required', stage: 'pr' }
    ]
  })
  return { ledger, manifest, runId, temp }
}

test('resumed completion accepts fresh pre-read and historical publication receipt', async () => {
  const fixture = await completionFixture(false)
  try {
    assert.deepEqual(
      fixture.ledger.stageDispositions(fixture.runId).map((row) => row.stage_id),
      ['push', 'pr']
    )
    assert.doesNotThrow(() => fixture.ledger.recordAttestation(fixture.manifest))
  } finally {
    fixture.ledger.close()
    await rm(fixture.temp, { recursive: true, force: true })
  }
})

test('v2 attestation rejects a passed outcome from a stale attempt generation', async () => {
  const fixture = await completionFixture(true)
  try {
    assert.throws(
      () => fixture.ledger.recordAttestation(fixture.manifest),
      /passed attempt outcome/
    )
  } finally {
    fixture.ledger.close()
    await rm(fixture.temp, { recursive: true, force: true })
  }
})
