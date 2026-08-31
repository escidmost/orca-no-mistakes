import { fullStageEvidence } from './attestation-fixture.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DomainLedger,
  buildAttestation,
  evidenceSha256,
  legacyLedgerPath,
  manifestLeaves,
  merkleRoot,
  sha256,
  verifyManifest,
  type GateDecisionRecord,
  type StageEvidenceManifestEntry
} from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const commit = 'a'.repeat(40)
const policySha256 = 'b'.repeat(64)

test('stored attestations require a passed run for verify and export', async () => {
  const previousCwd = process.cwd()
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  try {
    for (const status of ['in-progress', 'failed'] as const) {
      const home = await mkdtemp(path.join(tmpdir(), `onm-${status}-attestation-`))
      process.env.ORCA_NO_MISTAKES_HOME = home
      try {
        process.chdir(home)
        const runId = `${status}-attestation`
        const manifest = buildAttestation(fullStageEvidence({ baseCommitOid: commit, candidateCommitOid: commit, runId }), {
          baseCommitOid: commit,
          candidateCommitOid: commit,
          guardrailMode: 'strict',
          intent: 'Reject attestations for runs that did not pass.',
          policySha256,
          runId
        })
        const ledger = new DomainLedger(legacyLedgerPath())
        ledger.startRun({
          baseBranch: 'main',
          branch: 'feature',
          intent: manifest.intent,
          policySha256,
          repoRoot: '/repo',
          runId,
          submissionCommitOid: commit
        })
        ledger.recordAttestation(manifest)
        if (status === 'failed') ledger.finishRun(runId, status)
        ledger.close()
        const manifestPath = path.join(home, 'manifest.json')
        await writeFile(manifestPath, JSON.stringify(manifest))

        await assert.rejects(
          main(['attestation', 'verify', manifestPath]),
          new RegExp(`status is ${status}`)
        )
        await assert.rejects(
          main(['attestation', 'export', runId, `--out=${path.join(home, 'export.json')}`]),
          new RegExp(`status is ${status}`)
        )
      } finally {
        process.chdir(previousCwd)
        await rm(home, { recursive: true, force: true })
      }
    }
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome
  }
})

test('manifest verification rejects malformed waiver records with matching roots', () => {
  const runId = 'invalid-waiver'
  const resolvedAt = '2026-01-02T03:04:05.000Z'
  const entry: StageEvidenceManifestEntry = {
    artifactSha256: sha256('artifact'),
    baseCommitOid: commit,
    candidateCommitOid: commit,
    evidenceSha256: '',
    exitCode: 0,
    round: 0,
    stage: 'review',
    summary: 'Approved.',
    waiverOrApproval: { decision: 'approve', gateId: 'gate-1', resolvedAt },
    workerIdentity: 'reviewer'
  }
  entry.evidenceSha256 = evidenceSha256({ ...entry, runId })
  const valid = buildAttestation([entry], {
    baseCommitOid: commit,
    candidateCommitOid: commit,
    guardrailMode: 'strict',
    intent: 'Reject malformed waivers.',
    policySha256,
    runId
  })

  for (const waiver of [
    null,
    { decision: 'approve' },
    { decision: 'deny', gateId: 'gate-1', resolvedAt },
    { decision: 'skip', gateId: '', resolvedAt },
    { decision: 'approve', gateId: 'gate-1', resolvedAt: 'not-a-timestamp' },
    { decision: 'approve', gateId: 'gate-1', resolvedAt: '2026-01-02T03:04:05Z' }
  ]) {
    const manifest = structuredClone(valid)
    manifest.stageEvidence[0].waiverOrApproval = waiver as GateDecisionRecord
    manifest.merkleRoot = merkleRoot(manifestLeaves(manifest))
    assert.throws(() => verifyManifest(manifest), /invalid waiver/)
  }
})
