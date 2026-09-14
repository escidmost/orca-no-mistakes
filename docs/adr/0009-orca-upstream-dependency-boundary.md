---
status: accepted
date: 2026-08-20
scope: target architecture
implementation: partially implemented
---

# Orca Upstream Dependency Boundary

Useful releases should not wait for every desirable Orca enhancement, but an absent authoritative capability cannot be replaced with a weaker assertion while retaining the same guarantee.

## Decision

- Target releases require Orca CLI `>= 1.4.185` and fail closed when the minimum version is not met.
- Adapter-owned state uses `<git-common-dir>/orca-no-mistakes/ledger.sqlite`, consistent with ADR-0001 and ADR-0006.
- The adapter may implement domain-specific leases, checkpoints, custody, and attestation metadata without waiting for upstream support.
- Generic capabilities such as atomic worktree occupancy, canonical external-worktree paths, resolver-principal export, durable audit export, and headless control should be proposed upstream and adopted when available.
- When a target guarantee depends on an authoritative Orca fact that the installed version cannot provide, the release reports the limitation and withholds Passed. It does not synthesize the fact locally.

## Consequences

The roadmap can ship independently useful stages without overstating parity. Version enforcement and capability checks must exist before a release claims the guarantees that depend on them.
