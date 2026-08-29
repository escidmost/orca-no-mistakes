import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DomainLedger } from "../scripts/ledger.ts";

test("legacy gate audits recover only unambiguous evidence identity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "onm-legacy-gate-evidence-"));
  const dbPath = path.join(directory, "ledger.db");
  const runId = "legacy-gate-evidence";
  const uniqueEvidence = "a".repeat(64);
  let ledger: DomainLedger | undefined = new DomainLedger(dbPath);

  try {
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Resume with durable gate decisions.",
      policySha256: "b".repeat(64),
      repoRoot: "/repo",
      runId,
      submissionCommitOid: "c".repeat(40),
    });
    ledger.close();
    ledger = undefined;

    const legacy = new DatabaseSync(dbPath);
    try {
      const insertEvidence = legacy.prepare(`INSERT INTO stage_evidence (
        evidence_id, run_id, stage_id, round_index, candidate_commit_oid,
        base_commit_oid, worker_identity, exit_code, evidence_sha256,
        artifact_path, summary, created_at
      ) VALUES (?, ?, 'review', ?, ?, ?, 'worker', 1, ?, '/tmp/evidence', 'review', ?)`);
      const now = "2026-01-01T00:00:00.000Z";
      insertEvidence.run("unique", runId, 0, "d".repeat(40), "e".repeat(40), uniqueEvidence, now);
      insertEvidence.run("ambiguous-1", runId, 1, "d".repeat(40), "e".repeat(40), "f".repeat(64), now);
      insertEvidence.run("ambiguous-2", runId, 1, "d".repeat(40), "e".repeat(40), "0".repeat(64), now);
      legacy.exec("ALTER TABLE gate_audit DROP COLUMN evidence_sha256");
      const insertGate = legacy.prepare(`INSERT INTO gate_audit (
        gate_id, run_id, stage_id, round_index, gate_kind, question,
        options_json, resolution, decision, opened_at, resolved_at
      ) VALUES (?, ?, 'review', ?, 'finding', 'q', '["approve"]', ?, ?, ?, ?)`);
      insertGate.run("unique-gate", runId, 0, "approve", "approve", now, now);
      insertGate.run("ambiguous-gate", runId, 1, "fix", "fix", now, now);
    } finally {
      legacy.close();
    }

    ledger = new DomainLedger(dbPath);
    assert.deepEqual(
      ledger.listGateAudit(runId).map(({ evidence_sha256, gate_id }) => ({
        evidence_sha256,
        gate_id,
      })),
      [
        { evidence_sha256: uniqueEvidence, gate_id: "unique-gate" },
        { evidence_sha256: null, gate_id: "ambiguous-gate" },
      ],
    );
  } finally {
    ledger?.close();
    await rm(directory, { force: true, recursive: true });
  }
});
