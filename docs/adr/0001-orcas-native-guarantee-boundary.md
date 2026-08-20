# Orca Native Guarantee Boundary

## Status

Accepted

## Context

Orca provides durable orchestration without understanding Git custody, repository policy, or the evidence required for Passed. Reimplementing Orca's scheduler and worker lifecycle would create a duplicate, weaker authority, while relying on Orca alone would leave the domain guarantees unowned.

## Decision

Orca is authoritative for Runs, Tasks, Dispatches, mailbox delivery, worker questions and replies, decision gates, lifecycle stops, terminal release, and worker recovery. `orca-no-mistakes` owns the domain ledger for the exact proposed change, repository and branch semantic leases, exact-commit worktree custody, trusted policy execution, Git reconciliation after failure or cancellation, delivery evidence, and the final commit-bound Passed attestation.

## Considered Options

- **Custom standalone daemon**: rejected because Orca already provides durable orchestration and worker lifecycle management.
- **Rely on Orca for Git custody and Passed proof**: rejected because Orca is intentionally unaware of Git and forge policy.
- **Block on upstream Orca enhancements**: rejected; generic enhancements may land asynchronously, while the adapter must provide its safety guarantees immediately.
- **Adapter domain ledger over Orca**: accepted.

## Consequences

- The adapter does not implement its own task scheduler, worker daemon, or terminal supervisor.
- Concurrent validation runs on the same repository branch are rejected through adapter-owned semantic leases.
- Gate provenance, finding history, commit checkpoints, and Passed evidence are recorded in the adapter's SQLite domain ledger.
- Unmerged pipeline commits from failed or cancelled runs are anchored under recovery refs for deterministic custody recovery.
