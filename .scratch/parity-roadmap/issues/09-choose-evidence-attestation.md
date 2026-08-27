# Choose Evidence and Attestation Provenance

Linear: [ONM-7](https://linear.app/escidmore/issue/ONM-7/choose-evidence-and-attestation-provenance)

Type: grilling
Status: resolved
Blocked by: 05, 07

## Question

What evidence must be retained or published, how is every artifact bound to stage and commit provenance, what belongs in the pull request, and what lifecycle limits are sufficient for reliable team use?

## Answer

Evidence and attestation provenance implements a deterministic dual-layer model:

1. **Local Domain Ledger and Artifact Storage**: Raw stage execution logs, worker transcripts, findings, and diagnostic telemetry are retained locally in SQLite (`~/.orca-no-mistakes/ledger.db`) and streaming log files (`~/.orca-no-mistakes/artifacts/<run_id>/...`), capped at 50MB per stage output. Evidence is retained indefinitely until explicitly pruned by the operator (`orca-no-mistakes prune`).
2. **Cryptographic Stage-to-Commit Provenance**: Each verification stage produces a content hash (`stage_evidence_sha256`) bound to the tuple `(run_id, stage_id, round_index, candidate_commit_oid, base_commit_oid, worker_identity)`. The final `Passed Attestation` is an immutable, portable manifest computing a Merkle root over its header and the ordered stage hashes.
3. **Pull Request Surface**: A single sticky collapsible PR comment displays stage verification progression, candidate commit OID, policy SHA, user intent, and the Merkle proof hash, updating in place per phase to prevent review noise.
4. **Cross-Team Auditability**: Attestation manifests can be exported and deterministically verified offline or in CI via `orca-no-mistakes attestation export` and `orca-no-mistakes attestation verify`.

Architecture context: ADR [0004-evidence-and-attestation-provenance.md](docs/adr/0004-evidence-and-attestation-provenance.md) and glossary terms in [CONTEXT.md](CONTEXT.md).
