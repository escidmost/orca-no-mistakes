# Orca Native Guarantee Boundary

Orca provides the authoritative runtime for durable runs, task dispatch, mailbox delivery, worker lifecycle, and decision-gate mechanics. We decided that `orca-no-mistakes` will not reimplement a standalone daemon, supervisor, or worktree manager, but will instead operate as a domain ledger and policy coordinator layered directly over Orca. The adapter relies on Orca workspaces with branch-level single-occupancy leases, maintains gate resolver provenance in a local SQLite ledger, and reconciles Git custody via preserved recovery refs.

## Status

Accepted

## Considered Options

- **Custom Standalone Daemon**: Rebuild no-mistakes' original daemon, process supervisor, and worktree isolation layer inside the adapter. Rejected because Orca's native run and dispatch primitives already provide durable lifecycle guarantees, and duplicating them creates split authority.
- **Upstream Orca Enhancements**: Propose atomic worktree leasing and gate provenance schema changes directly to Orca core before shipping. Rejected in favor of keeping all guarantee mechanisms self-contained within the adapter ledger to maintain independence.
- **Adapter Domain Ledger over Orca**: Use Orca natively for task dispatch and decision gates while the adapter manages branch occupancy, Git custody, gate audit provenance, and Passed attestations. Accepted.

## Consequences

- The adapter eliminates daemon management overhead and leverages Orca's native lifecycle and crash resilience.
- Concurrent validation runs on the same branch or repository will be rejected at the adapter boundary rather than isolated into parallel worktrees.
- All gate provenance, finding history, and final Passed evidence are recorded in a dedicated local SQLite database managed by the adapter.
- Aborted or failed runs with unmerged pipeline modifications are safely anchored under `refs/no-mistakes/recover/<run_id>` for user recovery.
