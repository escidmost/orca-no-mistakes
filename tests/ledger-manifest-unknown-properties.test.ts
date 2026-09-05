import assert from 'node:assert/strict'
import test from 'node:test'

import { PIPELINE_STEPS } from '../scripts/config.ts'
import {
  buildAttestation,
  evidenceSha256,
  manifestLeaves,
  merkleRoot,
  verifyManifest,
  type GateDecisionRecord,
  type PassedAttestationManifest,
  type StageEvidenceManifestEntry
} from '../scripts/ledger.ts'

const commit = 'a'.repeat(40)
const policySha256 = 'b'.repeat(64)

function fullManifest(): PassedAttestationManifest {
  const runId = 'unknown-properties'
  const entries = PIPELINE_STEPS.map((stage, round) => {
    const entry: StageEvidenceManifestEntry = {
      artifactSha256: 'c'.repeat(64),
      baseCommitOid: commit,
      candidateCommitOid: commit,
      evidenceSha256: '',
      exitCode: 0,
      round,
      stage,
      summary: 'Passed.',
      workerIdentity: 'worker',
      ...(stage === 'review'
        ? {
            waiverOrApproval: {
              decision: 'approve' as const,
              gateId: 'review-gate',
              resolvedAt: '2026-01-02T03:04:05.000Z'
            }
          }
        : {})
    }
    entry.evidenceSha256 = evidenceSha256({ ...entry, runId })
    return entry
  })
  return buildAttestation(entries, {
    baseCommitOid: commit,
    candidateCommitOid: commit,
    guardrailMode: 'strict',
    intent: 'Reject unknown properties.',
    policySha256,
    runId
  })
}

test('manifest verification rejects unknown properties at every object level', () => {
  const topLevel = fullManifest() as PassedAttestationManifest & Record<string, unknown>
  topLevel.issuer = 'forged'
  assert.throws(() => verifyManifest(topLevel, PIPELINE_STEPS), /manifest has unknown properties/)

  const stageEntry = fullManifest()
  const firstEntry = stageEntry.stageEvidence[0] as StageEvidenceManifestEntry &
    Record<string, unknown>
  firstEntry.result = 'forged'
  assert.throws(() => verifyManifest(stageEntry, PIPELINE_STEPS), /entry 0 has unknown properties/)

  const nested = fullManifest()
  const waiver = nested.stageEvidence.find((entry) => entry.waiverOrApproval)!
    .waiverOrApproval as GateDecisionRecord & Record<string, unknown>
  waiver.reason = 'forged'
  nested.merkleRoot = merkleRoot(manifestLeaves(nested))
  assert.throws(() => verifyManifest(nested, PIPELINE_STEPS), /invalid waiver/)
})
