import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  beginGateAdmission,
  deriveAdmissionId,
  type GateMetadata,
  type ValidatedReceive
} from '../scripts/admission.ts'
import { DomainLedger } from '../scripts/ledger.ts'

const oid = (character: string) => character.repeat(40)

function metadata(): GateMetadata {
  return {
    commonDir: '/repo/.git',
    defaultBranch: 'main',
    gateIdentity: 'gate-identity',
    gatePath: '/repo/.git/orca-no-mistakes/gate.git',
    hookVersion: 1,
    remoteName: 'orca-no-mistakes',
    repoRoot: '/repo',
    stateDir: '/repo/.git/orca-no-mistakes',
    version: 1
  }
}

test('direct and gate ingress derive the same identity from the same submission', () => {
  const gate = {
    gateIdentity: 'gate-identity',
    intent: 'Run the six-stage validation.',
    newOid: oid('b'),
    oldOid: oid('a'),
    refName: 'refs/heads/feature'
  }
  assert.equal(deriveAdmissionId(gate), deriveAdmissionId({ ...gate, oldOid: oid('b') }))
})

test('admission replay is idempotent and the pending ref lease is released on acceptance', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-admission-'))
  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
  try {
    const update: ValidatedReceive = {
      newOid: oid('b'),
      noEvent: false,
      oldOid: oid('a'),
      refName: 'refs/heads/feature',
      intent: 'Run the six-stage validation.'
    }
    const first = beginGateAdmission(ledger, metadata(), update)
    const replay = beginGateAdmission(ledger, metadata(), update)
    assert.equal(replay.admission_id, first.admission_id)
    assert.equal(replay.lease_token, first.lease_token)

    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: update.intent,
      policySha256: oid('c').slice(0, 64),
      repoRoot: '/repo',
      runId: 'admission-run',
      submissionCommitOid: update.newOid
    })
    ledger.bindSubmissionAdmission(first.admission_id, 'admission-run')
    const accepted = ledger.markSubmissionAccepted({
      acceptedOid: update.newOid,
      admissionId: first.admission_id,
      runId: 'admission-run'
    })
    assert.equal(accepted.status, 'accepted')
    assert.equal(ledger.submissionAdmission(first.admission_id)?.status, 'accepted')

    const next = ledger.beginSubmissionAdmission({
      admissionId: `admission-${'e'.repeat(64)}`,
      gateIdentity: metadata().gateIdentity,
      intent: 'A different submission.',
      newOid: oid('d'),
      oldOid: update.newOid,
      refName: update.refName,
      repoRoot: metadata().repoRoot,
      source: 'gate'
    })
    assert.equal(next.status, 'pending')
  } finally {
    ledger.close()
    await rm(temp, { force: true, recursive: true })
  }
})

test('a competing submission on the same ref cannot acquire the pending lease', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-admission-lease-'))
  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
  try {
    ledger.beginSubmissionAdmission({
      admissionId: `admission-${'f'.repeat(64)}`,
      gateIdentity: 'gate-identity',
      intent: 'First submission.',
      newOid: oid('b'),
      oldOid: oid('a'),
      refName: 'refs/heads/feature',
      repoRoot: '/repo',
      source: 'gate'
    })
    assert.throws(
      () =>
        ledger.beginSubmissionAdmission({
          admissionId: `admission-${'d'.repeat(64)}`,
          gateIdentity: 'gate-identity',
          intent: 'Second submission.',
          newOid: oid('c'),
          oldOid: oid('a'),
          refName: 'refs/heads/feature',
          repoRoot: '/repo',
          source: 'direct'
        }),
      /pending admission lease already exists/
    )

  } finally {
    ledger.close()
    await rm(temp, { force: true, recursive: true })
  }
})

test('an unbound failed direct admission can be retried', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-admission-retry-'))
  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
  const input = {
    admissionId: `admission-${'a'.repeat(64)}`,
    gateIdentity: 'gate-identity',
    intent: 'Retry an unbound direct admission.',
    newOid: oid('b'),
    oldOid: oid('b'),
    refName: 'refs/heads/feature',
    repoRoot: '/repo',
    source: 'direct' as const
  }
  try {
    ledger.beginSubmissionAdmission(input)
    ledger.failSubmissionAdmission(input.admissionId)

    const retry = ledger.beginSubmissionAdmission(input)
    assert.equal(retry.status, 'pending')
    assert.equal(retry.run_id, null)
    assert.throws(
      () =>
        ledger.beginSubmissionAdmission({
          ...input,
          admissionId: `admission-${'c'.repeat(64)}`,
          intent: 'Competing retry.',
          newOid: oid('d')
        }),
      /pending admission lease already exists/
    )

    const gateInput = {
      ...input,
      admissionId: `admission-${'e'.repeat(64)}`,
      refName: 'refs/heads/gate-feature',
      source: 'gate' as const
    }
    ledger.beginSubmissionAdmission(gateInput)
    ledger.failSubmissionAdmission(gateInput.admissionId)
    assert.equal(ledger.beginSubmissionAdmission(gateInput).status, 'pending')
  } finally {
    ledger.close()
    await rm(temp, { force: true, recursive: true })
  }
})
