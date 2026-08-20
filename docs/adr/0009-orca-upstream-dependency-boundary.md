# 0009: Orca Upstream Dependency Boundary

Status: accepted

Context:
To restore safety-semantic parity across shippable releases, we need a defined boundary between Orca core enhancements and adapter responsibilities, ensuring parity milestones do not stall on upstream release cycles or carry weaker local substitutes.

Decision:
Shippable parity releases of `orca-no-mistakes` will not hard-block on new upstream Orca engine releases; all required safety invariants (branch semantic leases, gate resolver provenance, findings overrides, and commit-bound Passed attestations) are owned authoritatively by an adapter-managed SQLite validation ledger. Five generic upstream enhancements (atomic worktree occupancy leases, canonical external worktree path resolution, gate resolver principal tracking, durable audit export, and headless SSH control plane) will be authored directly as upstream Orca PRs and opportunistically adopted.

Considered Options:
- Hard-blocking parity releases on new Orca upstream releases: rejected because it delays shipping independently valuable parity milestones without improving safety semantics.
- Deferring safety guarantees (e.g. unverified gate resolutions or unleased branch runs) until upstream Orca support lands: rejected because it violates the non-negotiable definition of Passed.
- Rebuilding a standalone daemon/supervisor inside the adapter: rejected because Orca already provides durable orchestration and worker lifecycle management.

Consequences:
- `orca-no-mistakes` requires a minimum Orca CLI version fence (`>= 1.4.185`) and fails closed on incompatible environments.
- The adapter implements a repository-scoped SQLite ledger (`.git/orca-no-mistakes/ledger.sqlite`) for lease coordination and attestation provenance.
- Upstream Orca PRs for atomic occupancy, resolver principals, and audit export can land asynchronously without breaking adapter safety guarantees.
