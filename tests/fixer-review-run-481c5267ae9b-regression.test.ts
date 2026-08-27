import { fullStageEvidence } from './attestation-fixture.ts'
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

async function recordStageEvidence(
  ledger: DomainLedger,
  runId: string,
  artifactPath: string,
  artifact: Buffer,
  count = 1,
): Promise<StageEvidenceManifestEntry> {
  await writeFile(artifactPath, artifact);
  const fields = {
    artifactSha256: sha256(artifact),
    baseCommitOid: commit,
    candidateCommitOid: commit,
    exitCode: 0,
    round: 0,
    stage: "review" as const,
    summary: "passed",
    workerIdentity: "reviewer",
  };
  const entry = {
    ...fields,
    evidenceSha256: evidenceSha256({ ...fields, runId }),
  };
  for (let attempt = 0; attempt < count; attempt += 1) {
    ledger.recordEvidence({
      ...fields,
      artifactPath,
      evidenceSha256: entry.evidenceSha256,
      roundIndex: fields.round,
      runId,
      stageId: fields.stage,
    });
  }
  return entry;
}

test("manifest-file verification verifies offline, then requires an intact stored attestation", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "orca-attestation-verify-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  try {
    const manifest = buildAttestation(fullStageEvidence({ baseCommitOid: commit, candidateCommitOid: commit, runId: "missing-run" }), {
      baseCommitOid: commit,
      candidateCommitOid: commit,
      intent: "Verify evidence.",
      policySha256: policy,
      runId: "missing-run",
    });
    const manifestPath = path.join(home, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));

    // No ledger record for this run: the manifest still proves itself.
    await main(["attestation", "verify", manifestPath]);

    const ledger = new DomainLedger();
    startRun(ledger, manifest.runId);
    ledger.recordAttestation(manifest);
    ledger.close();
    const db = new DatabaseSync(path.join(home, "ledger.db"));
    db.prepare("UPDATE passed_attestations SET merkle_root = ? WHERE run_id = ?").run(
      "0".repeat(64),
      manifest.runId,
    );
    db.close();

    await assert.rejects(
      main(["attestation", "verify", manifestPath]),
      /stored attestation manifest does not match the ledger Merkle root/,
    );
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("evidence verification hashes exact artifact bytes", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-evidence-bytes-"));
  const ledger = new DomainLedger(path.join(temp, "ledger.db"));
  try {
    const runId = "byte-run";
    startRun(ledger, runId);
    const artifactPath = path.join(temp, "artifact.log");
    const entry = await recordStageEvidence(
      ledger,
      runId,
      artifactPath,
      Buffer.from("\uFFFD"),
    );
    const manifest = buildAttestation([entry], {
      baseCommitOid: commit,
      candidateCommitOid: commit,
      intent: "Verify evidence.",
      policySha256: policy,
      runId,
    });

    assert.deepEqual(ledger.verifyEvidence(manifest), []);
    await writeFile(artifactPath, Buffer.from([0xff]));
    assert.deepEqual(ledger.verifyEvidence(manifest), [
      `review round 0: artifact ${artifactPath} does not match its recorded digest`,
    ]);
  } finally {
    ledger.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("duplicate evidence entries require distinct ledger rows", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-evidence-cardinality-"));
  const ledger = new DomainLedger(path.join(temp, "ledger.db"));
  try {
    const runId = "duplicate-run";
    startRun(ledger, runId);
    const artifactPath = path.join(temp, "artifact.log");
    const entry = await recordStageEvidence(
      ledger,
      runId,
      artifactPath,
      Buffer.from("passed"),
      2,
    );
    const manifest = buildAttestation([entry, entry], {
      baseCommitOid: commit,
      candidateCommitOid: commit,
      intent: "Verify evidence.",
      policySha256: policy,
      runId,
    });
    assert.deepEqual(ledger.verifyEvidence(manifest), []);

    const db = new DatabaseSync(ledger.path);
    db.exec(
      "DELETE FROM stage_evidence WHERE evidence_id = (SELECT evidence_id FROM stage_evidence LIMIT 1)",
    );
    db.close();

    assert.deepEqual(ledger.verifyEvidence(manifest), [
      "review round 0: the attested evidence row is missing from the ledger",
    ]);
  } finally {
    ledger.close();
    await rm(temp, { recursive: true, force: true });
  }
});
