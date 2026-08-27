import { fullStageEvidence } from './attestation-fixture.ts'
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  buildAttestation,
  evidenceSha256,
  sha256,
  type StageEvidenceManifestEntry,
} from "../scripts/ledger.ts";
import { main } from "../scripts/orca-no-mistakes.ts";

const commit = "a".repeat(40);
const otherCommit = "c".repeat(40);
const policy = "b".repeat(64);

function startRun(ledger: DomainLedger, runId: string): void {
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "Verify evidence.",
    policySha256: policy,
    repoRoot: "/repo",
    runId,
    submissionCommitOid: commit,
  });
}

async function recordEvidence(
  ledger: DomainLedger,
  runId: string,
  artifactPath: string,
): Promise<StageEvidenceManifestEntry> {
  const artifact = Buffer.from("passed");
  await writeFile(artifactPath, artifact);
  const fields = {
    artifactSha256: sha256(artifact),
    baseCommitOid: commit,
    candidateCommitOid: commit,
    exitCode: 0,
    round: 0,
    stage: "review",
    summary: "passed",
    workerIdentity: "reviewer",
  };
  const entry = {
    ...fields,
    evidenceSha256: evidenceSha256({ ...fields, runId }),
  };
  ledger.recordEvidence({
    ...fields,
    artifactPath,
    evidenceSha256: entry.evidenceSha256,
    roundIndex: fields.round,
    runId,
    stageId: fields.stage,
  });
  return entry;
}

test("evidence verification rejects unattested ledger rows", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-unattested-evidence-"));
  const ledger = new DomainLedger(path.join(temp, "ledger.db"));
  try {
    const runId = "extra-row-run";
    startRun(ledger, runId);
    const artifactPath = path.join(temp, "artifact.log");
    const entry = await recordEvidence(ledger, runId, artifactPath);
    await recordEvidence(ledger, runId, artifactPath);
    const manifest = buildAttestation([entry], {
      baseCommitOid: commit,
      candidateCommitOid: commit,
      guardrailMode: "strict",
      intent: "Verify evidence.",
      policySha256: policy,
      runId,
    });

    assert.deepEqual(ledger.verifyEvidence(manifest), [
      "review round 0: the ledger evidence row is absent from the attestation",
    ]);
  } finally {
    ledger.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("manifest-file verification rejects a forged manifest for a recorded run", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orca-complete-manifest-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  try {
    const runId = "complete-manifest-run";
    const manifest = buildAttestation(fullStageEvidence({ baseCommitOid: commit, candidateCommitOid: commit, runId }), {
      baseCommitOid: commit,
      candidateCommitOid: commit,
      guardrailMode: "strict",
      intent: "Verify evidence.",
      policySha256: policy,
      runId,
    });
    const ledger = new DomainLedger();
    startRun(ledger, runId);
    ledger.recordAttestation(manifest);
    ledger.close();
    // Internally valid — rebuilt from scratch, so its Merkle root covers the
    // forged candidate commit — but not the manifest this run recorded.
    const forged = buildAttestation(fullStageEvidence({ baseCommitOid: commit, candidateCommitOid: otherCommit, runId }), {
      baseCommitOid: commit,
      candidateCommitOid: otherCommit,
      guardrailMode: "strict",
      intent: "Verify evidence.",
      policySha256: policy,
      runId,
    });
    const manifestPath = path.join(home, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(forged));

    await assert.rejects(
      main(["attestation", "verify", manifestPath]),
      /manifest does not match the attestation recorded in the domain ledger/,
    );

    // A field edit on the recorded manifest fails on its own digests, with no
    // ledger lookup needed.
    const tamperedPath = path.join(home, "tampered.json");
    await writeFile(
      tamperedPath,
      JSON.stringify({ ...manifest, candidateCommitOid: otherCommit }),
    );
    await assert.rejects(
      main(["attestation", "verify", tamperedPath]),
      /commit OIDs/,
    );
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
