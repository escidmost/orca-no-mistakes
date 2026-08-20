# Orca's Native Guarantee Boundary

Status: accepted

Context:
We need to delineate the orchestration authority provided natively by Orca from the safety and Git custody guarantees required for adversarial pipeline validation.

Decision:
Orca is the native authority for durable Runs, Tasks, Dispatches, mailbox delivery, worker questions/replies, decision gates, lifecycle stops, and worker recovery. The adapter owns the domain ledger for the exact proposed change, repository and branch semantic leases, exact-commit worktree custody, trusted policy execution, Git reconciliation upon failure/cancellation, delivery evidence, and the final commit-bound Passed attestation.

Considered Options:
- Recreating a standalone daemon/supervisor inside the adapter: rejected to avoid maintaining a duplicate, weaker orchestration authority.
- Relying on Orca for Git custody and Passed proof: rejected because Orca models generic orchestration without Git or forge policy awareness.

Consequences:
- The adapter does not implement its own task scheduler or worker daemon.
- The adapter must manage its own local domain ledger and branch semantic leases.
