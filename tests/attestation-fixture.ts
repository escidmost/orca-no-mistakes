import { PIPELINE_STEPS } from "../scripts/config.ts";
import { evidenceSha256, type StageEvidenceManifestEntry } from "../scripts/ledger.ts";

/**
 * One clean evidence entry per pipeline stage. A manifest verified through the
 * CLI must carry every required stage, so fixtures that only care about some
 * later check still need a complete stage set to reach it.
 */
export function fullStageEvidence(input: {
  baseCommitOid: string;
  candidateCommitOid: string;
  runId: string;
}): StageEvidenceManifestEntry[] {
  return PIPELINE_STEPS.map((stage) => {
    const entry = {
      artifactSha256: "a".repeat(64),
      baseCommitOid: input.baseCommitOid,
      candidateCommitOid: input.candidateCommitOid,
      exitCode: 0,
      round: 0,
      stage,
      summary: "clean",
      workerIdentity: `${stage}-worker`,
    };
    return { ...entry, evidenceSha256: evidenceSha256({ ...entry, runId: input.runId }) };
  });
}
