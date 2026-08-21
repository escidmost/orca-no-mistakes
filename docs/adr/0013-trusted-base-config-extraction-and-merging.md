---
status: accepted
date: 2026-08-21
scope: target architecture
implementation: not implemented
---

# Trusted Base Config Extraction and Merging Engine

Validation policy must be sourced from the trusted base ref rather than the untrusted proposed branch, while supporting explicit local development bypasses and tamper-evident policy hashing.

## Decision

- **Trusted Base Extraction**:
  - During validation runs, repository configuration is extracted from the trusted base ref via `git show <trusted-base>:.orca/no-mistakes.yaml` (e.g. `origin/main:.orca/no-mistakes.yaml`).
  - If `.orca/no-mistakes.yaml` is absent from the trusted base ref, extraction resolves to an empty object `{}` and proceeds using global and built-in defaults without failing.

- **Local Development Bypass & Policy Tainting**:
  - Operators may pass `--allow-local-config` or `--config <path>` to bypass base extraction during local iteration.
  - Applying a local config bypass explicitly marks the run as uncertified / tainted in the domain ledger, withholding Passed certification.

- **Canonical Policy Hashing**:
  - The merged configuration is normalized, canonicalized via key-sorted JSON serialization, and hashed with SHA-256 (`effective_policy_hash`).
  - Stage evidence binds the `base_ref_sha`, `effective_policy_hash`, `local_bypass` status, and full effective configuration snapshot.

## Consequences

Enforces ADR-0003 invariants against untrusted configuration tampering on feature branches while enabling flexible local development and cryptographic policy auditability.
