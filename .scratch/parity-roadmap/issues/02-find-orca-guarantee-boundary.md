# Find Orca's Native Guarantee Boundary

Linear: [ONM-5](https://linear.app/escidmore/issue/ONM-5/find-orcas-native-guarantee-boundary)

Type: research
Status: resolved
Blocked by:

## Question

For run ownership, worktree isolation, dispatch durability, decision gates, cancellation, recovery, locking, and audit history, which guarantees does current Orca provide natively, where are they materially weaker than original no-mistakes, and which gaps are better fixed in Orca itself?

## Answer

Orca is the authority for durable Runs, Tasks, Dispatches, mailbox delivery, worker questions, decision-gate mechanics, lifecycle fencing, terminal release, and recoverable worker identity. Reimplementing those mechanisms here would create a second, weaker authority.

This project must own the domain ledger for the exact proposed change, repository and branch semantic leases, exact-commit worktree custody, trusted policy, Git reconciliation after cancellation or restart, delivery evidence, and the final commit-bound Passed attestation.

Generic gaps worth considering in Orca itself are atomic worktree occupancy, reliable discovery of externally created linked worktrees, gate resolver provenance, durable orchestration audit export, and direct-SSH control-plane durability.

Research context: branch `research/orca-guarantee-boundary`, commit `8b6daa714dce307c76ad224fe812dc048d3e0336`, report `.scratch/parity-roadmap/research/02-orca-guarantee-boundary.md`.
