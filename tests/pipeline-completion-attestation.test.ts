import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DomainLedger,
  LEGACY_STAGE_PLAN,
  assuranceClaimsFor,
  buildAttestation,
  buildPipelineCompletionAttestation,
  canonicalJson,
  evidenceSha256,
  sha256,
  verifyCompletionAttestation,
  type StageEvidenceManifestEntry
} from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const commit = 'a'.repeat(40)
const policy = 'b'.repeat(64)
const stages = ['intent', 'rebase', 'review', 'test', 'document', 'lint', 'push', 'pr']

function evidence(
  runId: string,
  plan: readonly string[] = stages
): StageEvidenceManifestEntry[] {
  return plan.map((stage, round) => {
    const entry: StageEvidenceManifestEntry = {
      artifactSha256: sha256(`${stage}-artifact`),
      baseCommitOid: commit,
      candidateCommitOid: commit,
      evidenceSha256: '',
      exitCode: 0,
      round,
      stage,
      summary: `${stage} satisfied.`,
      workerIdentity: 'coordinator'
    }
    entry.evidenceSha256 = evidenceSha256({ ...entry, runId })
    return entry
  })
}

test('v2 completion attestations bind Release 2 facts without overstating assurance', async () => {
  const runId = 'pipeline-completion-v2'
  const stageEvidence = evidence(runId)
  const publicationRoute = {
    baseBranch: 'main',
    baseRepositoryId: 'R_base',
    forgeHost: 'github.com',
    headBranch: 'feature',
    headOwner: 'owner',
    headRepositoryId: 'R_head'
  }
  const manifest = buildPipelineCompletionAttestation(stageEvidence, {
    attemptOutcomeDigests: [sha256('failed-attempt'), sha256('passed-attempt')],
    baseCommitOid: commit,
    candidateCommitOid: commit,
    candidatePublicationReceiptSha256: sha256('publication-receipt'),
    custody: {
      recoveryRef: `refs/no-mistakes/recover/${runId}`,
      settlement: 'candidate preserved'
    },
    intent: 'Verify Release 2 completion evidence.',
    policySha256: policy,
    publicationRoute: {
      ...publicationRoute,
      routeFingerprint: sha256(canonicalJson(publicationRoute))
    },
    pullRequestBindingReceiptSha256: sha256('pr-receipt'),
    runId,
    stageDispositions: stageEvidence.map((entry) => ({
      disposition: 'satisfied' as const,
      evidenceSha256: entry.evidenceSha256,
      stage: entry.stage
    })),
    stagePlan: stages.map((stage) => ({ requirement: 'required' as const, stage }))
  })

  verifyCompletionAttestation(manifest)
  assert.equal(manifest.version, '2.0.0')
  assert.deepEqual(manifest.assuranceClaims, [
    'configured-pipeline-completed',
    'candidate-publication-verified',
    'pull-request-bound'
  ])
  assert.equal(manifest.assuranceClaims.includes('checks-passed' as never), false)
  assert.equal(manifest.assuranceClaims.includes('Passed' as never), false)

  const overstated = structuredClone(manifest)
  overstated.assuranceClaims.push('checks-passed' as never)
  assert.throws(() => verifyCompletionAttestation(overstated), /assurance claims/)

  const legacyMeta = {
    baseCommitOid: commit,
    candidateCommitOid: commit,
    guardrailMode: 'strict',
    intent: 'Read legacy evidence conservatively.',
    policySha256: policy,
    runId: 'legacy-v1-3'
  } as const
  assert.throws(
    () => assuranceClaimsFor(buildAttestation([], legacyMeta)),
    /missing required stage evidence/
  )
  const legacy = buildAttestation(
    evidence(legacyMeta.runId, LEGACY_STAGE_PLAN),
    legacyMeta
  )
  assert.deepEqual(assuranceClaimsFor(legacy), ['legacy-local-pipeline-passed'])

  const home = await mkdtemp(path.join(tmpdir(), 'onm-v2-attestation-'))
  const offlineHome = await mkdtemp(path.join(tmpdir(), 'onm-v2-offline-'))
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  try {
    process.env.ORCA_NO_MISTAKES_HOME = home
    const ledger = new DomainLedger()
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: manifest.intent,
      policySha256: policy,
      repoRoot: '/repo',
      runId,
      stagePlan: stages.map((stageId) => ({ requirement: 'required' as const, stageId })),
      submissionCommitOid: commit
    })
    ledger.finishRun(runId, 'passed', commit)
    ledger.recordAttestation(manifest)
    ledger.close()

    const exported = path.join(home, 'completion.json')
    await main(['attestation', 'export', runId, `--out=${exported}`])
    assert.deepEqual(JSON.parse(await readFile(exported, 'utf8')), manifest)

    process.env.ORCA_NO_MISTAKES_HOME = offlineHome
    await main(['attestation', 'verify', exported])
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(offlineHome, { recursive: true, force: true })
  }
})
