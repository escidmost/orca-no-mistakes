import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAttestation,
  manifestLeaves,
  merkleRoot,
  verifyManifest,
  type PassedAttestationManifest
} from '../scripts/ledger.ts'

test('offline manifests reject invalid runtime headers with matching roots', () => {
  const valid = buildAttestation([], {
    baseCommitOid: 'a'.repeat(40),
    candidateCommitOid: 'b'.repeat(40),
    intent: 'Verify offline.',
    policySha256: 'c'.repeat(64),
    runId: 'run-valid'
  })

  for (const [field, value, expected] of [
    ['runId', '', /run ID/],
    ['runId', 'invalid/run', /run ID/],
    ['coordinatorVersion', '', /coordinator version/],
    ['createdAt', '', /creation timestamp/],
    ['createdAt', 'not-a-timestamp', /creation timestamp/]
  ] as const) {
    const manifest = structuredClone(valid) as PassedAttestationManifest & Record<string, unknown>
    manifest[field] = value
    manifest.merkleRoot = merkleRoot(manifestLeaves(manifest))
    assert.throws(() => verifyManifest(manifest), expected)
  }
})
