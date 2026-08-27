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
  manifestLeaves,
  merkleRoot,
  sha256,
  verifyManifest,
  type StageEvidenceManifestEntry
} from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const commit = 'a'.repeat(40)
const policySha256 = 'b'.repeat(64)

test('offline verification rejects a manifest for a failed local run', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'onm-failed-offline-'))
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  process.env.ORCA_NO_MISTAKES_HOME = home
  try {
    const runId = 'failed-offline-run'
    const manifest = buildAttestation(fullStageEvidence({ baseCommitOid: commit, candidateCommitOid: commit, runId }), {
      baseCommitOid: commit,
      candidateCommitOid: commit,
      intent: 'Reject contradictory offline evidence.',
      policySha256,
      runId
    })
    const ledger = new DomainLedger()
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: manifest.intent,
      policySha256,
      repoRoot: '/repo',
      runId,
      submissionCommitOid: commit
    })
    ledger.finishRun(runId, 'failed')
    ledger.close()
    const manifestPath = path.join(home, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify(manifest))

    await assert.rejects(
      main(['attestation', 'verify', manifestPath]),
      /has no passed attestation \(status: failed\)/
    )
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('manifest verification rejects sparse stage evidence with matching digests', () => {
  const runId = 'sparse-stage-evidence'
  const manifest = buildAttestation([], {
    baseCommitOid: commit,
    candidateCommitOid: commit,
    intent: 'Reject incomplete evidence.',
    policySha256,
    runId
  })
  const entry = {
    artifactSha256: sha256('artifact')
  } as StageEvidenceManifestEntry
  entry.evidenceSha256 = evidenceSha256({ ...entry, runId })
  manifest.stageEvidence = [entry]
  manifest.merkleRoot = merkleRoot(manifestLeaves(manifest))

  assert.throws(() => verifyManifest(manifest), /invalid required fields/)
})
