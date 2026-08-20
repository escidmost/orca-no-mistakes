# Evidence and Attestation Provenance

To restore safety-semantic parity for the `Passed` outcome, `orca-no-mistakes` establishes a deterministic dual-layer evidence provenance model. All raw stage logs, agent transcripts, and execution telemetry are retained locally in the SQLite domain ledger and structured filesystem store, bound cryptographically to exact candidate commit SHAs, parent bases, stage rounds, and worker identities. The pipeline publishes an immutable, portable `Passed Attestation` manifest containing a Merkle root over all stage evidence, surfaced on GitHub via a single deterministic sticky PR comment, and retains all run evidence indefinitely until explicit operator pruning.

## Status

Accepted

## Considered Options

- **Local Domain Store vs Public Forge Publishing**: Publishing full execution transcripts and raw logs directly to GitHub PR comments or check annotations was rejected because it causes excessive PR noise, risks exposing sensitive local environment telemetry, and exceeds forge payload limits. Storing full evidence locally in `~/.orca-no-mistakes/` while publishing a compact Merkle-backed attestation summary preserves privacy, performance, and auditability.
- **Dual-Layer Merkle Binding vs Run-Level Attribution**: Relying solely on the top-level Orca Run ID and final delivered commit SHA was rejected because it fails to cryptographically prove that intermediate verification steps (lint, review, test) were executed against the exact submitted commit rather than stale worktrees. Dual-layer SHA-256 hashing across all stage artifacts tied to `(run_id, stage_id, round, candidate_commit_oid, base_commit_oid, worker_identity)` ensures tamper-evident traceability.
- **Sticky Bot PR Comment vs Multi-Check PR Spam**: Posting separate comments or check runs for every intermediate stage fix or diagnostic run was rejected to avoid comment pollution. A single sticky collapsible PR comment updated deterministically per pipeline phase delivers clear visibility without review friction.
- **Indefinite Retention with Explicit Pruning vs Automatic Eviction (TTL/LRU)**: Automatic time-based (e.g. 30-day) or LRU pruning of old run records was rejected because long-lived branches, compliance audits, and post-merge debugging require reliable access to historical verification proof. Evidence is retained indefinitely until explicitly purged via `orca-no-mistakes prune`.
- **Portable Attestation Manifest vs Forge-Coupled Verification**: Restricting verification to live GitHub API queries was rejected to maintain offline auditability and provider independence. A standardized, portable JSON/TOON manifest allows deterministic offline verification via `orca-no-mistakes attestation verify`.

## Consequences

- **Local Storage Schema**:
  - The SQLite domain ledger (`~/.orca-no-mistakes/ledger.db`) stores structured stage metadata, execution timings, exit codes, findings, and head/tail truncated stdout/stderr for rapid CLI/AXI querying.
  - Raw full logs, agent transcripts, and large diagnostic blobs are streamed to `~/.orca-no-mistakes/artifacts/<run_id>/<stage_id>_r<round>.log`, capped at 50MB per stage output.
- **Cryptographic Provenance**:
  - Every stage artifact generates a content hash (`stage_evidence_sha256`).
  - The final `Passed Attestation` computes a Merkle root over the ordered manifest of all stage evidence hashes, locking candidate commit OID, base commit OID, policy SHA, and coordinator version into an immutable proof.
- **GitHub Pull Request Presentation**:
  - A single sticky collapsible comment on the PR displays stage progression, policy version, candidate commit OID, user intent, and the Merkle proof hash.
  - Updated in-place per phase without creating new notifications or polluting the review conversation.
- **Cross-Environment Audit & CLI Operations**:
  - Operators and CI pipelines can export and verify attestation manifests using `orca-no-mistakes attestation export <run_id|commit_oid>` and `orca-no-mistakes attestation verify <manifest_file|commit_oid>`.
  - Stale or unwanted historical artifacts are removed solely through explicit operator action (`orca-no-mistakes prune [--before <date>] [--repo <name>]`).
