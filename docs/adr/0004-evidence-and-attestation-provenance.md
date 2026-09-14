---
status: accepted
date: 2026-08-20
scope: target architecture
implementation: partially implemented
---

# Evidence and Attestation Provenance

The target pipeline keeps detailed evidence locally and publishes only a compact summary. Its hashes make later local modification detectable, but without an external signer or trust anchor they do not make the evidence immutable, signed, or independently authentic.

## Decision

- Store structured metadata in `<git-common-dir>/orca-no-mistakes/ledger.sqlite` and captured artifacts under `<git-common-dir>/orca-no-mistakes/artifacts/<run-id>/`.
- Bind each captured artifact to run, stage, round, candidate commit, base commit, actor, exit status, and a SHA-256 content digest.
- Cap each captured stage output at 50MB. Record whether content was truncated, the original byte count when known, and the retained byte range; never describe truncated output as a full log.
- Avoid broad environment capture, redact known credentials and tokens before persistence, and create ledger and artifact files with owner-only permissions.
- Build a deterministic JSON manifest and Merkle root over ordered stage records, effective policy, intent hash, candidate commit, delivery proof, and coordinator version.
- The managed PR report presents the manifest hash and stage summary, but the editable body is not a trust anchor.
- Retain evidence until an explicit operator deletion operation. Deletion must report what was removed and preserve no claim that deleted raw evidence remains independently verifiable.

## Current implementation

Repository ledgers use `<git-common-dir>/orca-no-mistakes/ledger.sqlite`. Stage and remote artifacts currently use `<artifact-home>/artifacts/<run-id>/`, where `<artifact-home>` is `ORCA_NO_MISTAKES_HOME` or, by default, `~/.orca-no-mistakes`. This differs from the repository-local artifact location in the target decision above; the home override does not relocate repository ledgers.

Completion attestations are stored in the repository ledger; exports go to stdout or the requested `--out` file. Retained-evidence verification reads the artifact paths recorded in the ledger. Ordinary `prune` removes eligible run directories beneath the current artifact home, so use the same home setting that created those artifacts. Changing the setting does not move existing evidence or rewrite its recorded paths.

## Consequences

Offline verification can detect mismatch between a manifest and retained local evidence. It cannot prove who created the manifest or that both manifest and evidence were not replaced together. Strong authenticity claims require a future ADR covering canonical signing, keys, rotation, and independent trust anchors.
