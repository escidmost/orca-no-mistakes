import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  evidenceSha256,
  type StageEvidenceManifestEntry,
} from "../scripts/ledger.ts";
import { sha256 } from "../scripts/orca-no-mistakes.ts";

const oid = (value: number): string => value.toString(16).padStart(40, "0");

test("retained evidence binds policy and base provenance to its artifact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "onm-evidence-provenance-"));
  const artifactPath = path.join(directory, "review.json");
  const runId = "retained-provenance";
  const summary = "review passed";
  const workerIdentity = "worker:review";
  const artifact = JSON.stringify({
    base_ref_sha: oid(3),
    effective_policy_hash: "a".repeat(64),
    findings: [],
    summary,
  });
  const artifactSha256 = sha256(artifact);
  const entry: StageEvidenceManifestEntry = {
    artifactSha256,
    baseCommitOid: oid(1),
    candidateCommitOid: oid(2),
    evidenceSha256: evidenceSha256({
      artifactSha256,
      baseCommitOid: oid(1),
      candidateCommitOid: oid(2),
      exitCode: 0,
      round: 0,
      runId,
      stage: "review",
      summary,
      workerIdentity,
    }),
    exitCode: 0,
    round: 0,
    stage: "review",
    summary,
    workerIdentity,
  };
  const ledger = new DomainLedger(":memory:");
  try {
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Bind retained provenance.",
      policySha256: "f".repeat(64),
      repoRoot: "/repo",
      runId,
      submissionCommitOid: oid(1),
    });
    await writeFile(artifactPath, artifact);
    ledger.recordEvidence({
      artifactPath,
      artifactSha256,
      baseCommitOid: entry.baseCommitOid,
      baseRefSha: oid(4),
      candidateCommitOid: entry.candidateCommitOid,
      effectivePolicyHash: "b".repeat(64),
      evidenceSha256: entry.evidenceSha256,
      exitCode: entry.exitCode,
      findingsJson: "[]",
      roundIndex: entry.round,
      runId,
      stageId: entry.stage,
      summary,
      workerIdentity,
    });

    assert.deepEqual(ledger.verifyEvidence({ runId, stageEvidence: [entry] }), [
      "review round 0: recorded policy provenance does not match the attested artifact",
      "review round 0: recorded base provenance does not match the attested artifact",
    ]);
  } finally {
    ledger.close();
    await rm(directory, { force: true, recursive: true });
  }
});
