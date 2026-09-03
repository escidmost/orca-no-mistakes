---
status: accepted
date: 2026-08-20
scope: target architecture
implementation: partially implemented (Release 2)
---

# Evidence and Attestation Provenance

The target pipeline keeps detailed evidence locally and publishes only a compact summary. Its hashes make later local modification detectable, but without an external signer or trust anchor they do not make the evidence immutable, signed, or independently authentic.

## Decision

- Store structured metadata in `<git-common-dir>/orca-no-mistakes/ledger.sqlite` and captured artifacts under `<git-common-dir>/orca-no-mistakes/artifacts/<run-id>/`.
- Bind each captured artifact to run, stage, round, candidate commit, base commit, actor, exit status, and a SHA-256 content digest.
- Cap each captured stage output at 50MB. Record whether content was truncated, the original byte count when known, and the retained byte range; never describe truncated output as a full log.
- Avoid broad environment capture, redact known credentials and tokens before persistence, and create ledger and artifact files with owner-only permissions.
- Build a deterministic JSON manifest and Merkle root over ordered stage records, effective policy, intent hash, candidate commit, delivery proof, and coordinator version.
- A sticky PR comment may present the manifest hash and stage summary, but the editable comment is not a trust anchor.
- Retain evidence until an explicit operator deletion operation. Deletion must report what was removed and preserve no claim that deleted raw evidence remains independently verifiable.

## Consequences

Offline verification can detect mismatch between a manifest and retained local evidence. It cannot prove who created the manifest or that both manifest and evidence were not replaced together. Strong authenticity claims require a future ADR covering canonical signing, keys, rotation, and independent trust anchors.
