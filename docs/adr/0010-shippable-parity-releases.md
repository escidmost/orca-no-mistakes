# 0010: Four Shippable Parity Releases

To restore the original meaning of Passed without compromising safety or blocking on unresolved remote proofs, we divide the delivery of Orca No-Mistakes into four independently shippable parity releases: Local Validation Core, Guarded Push Delivery, Authoritative CI Proof & Merge, and Resilient Recovery & Custody Synchronization.

## Status

Accepted

## Context

Orca No-Mistakes replaces a standalone daemon with an Orca-native validation pipeline. Releasing a single massive migration creates high delivery risk and risks shipping weakened guarantees. Conversely, releasing an early version that writes to remote remotes before branch leasing or CI reconciliation exist would produce misleading Passed outcomes.

## Decision

We partition the roadmap into four distinct, independently shippable releases:

1. **Release 1 (Local Adversarial Validation Core)**: Executes trusted-policy validation DAG (`intent`, `rebase`, `review`, `test`, `document`, `lint`) across isolated child worktrees with Claude reviewers and durable Codex fixers, persisting an unforgeable commit-bound Attestation JSON without remote push side-effects.
2. **Release 2 (Guarded Remote Delivery & Branch Custody)**: Introduces the bare gate push option entrypoint (`git push no-mistakes -o intent="..."`), exclusive branch semantic leases in `~/.orca-no-mistakes/leases/`, `--force-with-lease` exact-commit push, and PR creation.
3. **Release 3 (Authoritative PR/CI Proof & Guarded Merge)**: Enforces fully paginated reconciliation of GitHub Checks API and Commit Statuses against exact commit SHAs, pre-declared trusted check-set completeness with fail-closed `no_ci: true` fallback, and non-bypass expected-head merge or merge queue transitions.
4. **Release 4 (Resilient Coordinator Recovery & Custody Sync)**: Implements coordinator crash resumption, parked gate recovery, fail-closed branch custody reconciliation via `no-mistakes axi sync --recover` with anchored refs under `refs/no-mistakes/recover-local/<runId>`, and forward compatibility for upstream Orca atomic worktree occupancy leases.

Each release must be accompanied by an automated live scenario rig demonstrating real Git and Orca execution under fault and adversarial injection.
