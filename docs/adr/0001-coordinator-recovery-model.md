---
status: accepted
date: 2026-08-20
scope: target architecture
implementation: partially implemented (Release 1)
---

# Coordinator Recovery Model

The target coordinator persists domain state separately from Orca's orchestration state so a restarted coordinator can resume without duplicating workers or losing Git custody. Current behavior is documented in [`docs/current-architecture.md`](../current-architecture.md).

## Decision

- Resolve the repository's common Git directory and store the domain ledger at `<git-common-dir>/orca-no-mistakes/ledger.sqlite`.
- Use the ledger for proposed-change identity, branch semantic leases, commit-bound stage checkpoints, and custody state. Orca remains authoritative for Runs, Tasks, Dispatches, and decision-gate lifecycle under ADR-0008.
- Fence each coordinator generation before it may advance domain state. A restarted coordinator may adopt an Orca worker only when Orca identifies it as the same live Dispatch for the same task and generation; otherwise it restarts from the last committed checkpoint.
- Preserve unpublished pipeline heads under `refs/no-mistakes/recover/<run-id>` before releasing or changing custody.
- Return custody only through a three-way containment check over the submitted head, operator head, and terminal pipeline head. Ambiguous divergence requires an operator decision and never triggers an automatic reset.

## Consequences

Recovery is a Release 4 capability under ADR-0010. Earlier releases may run and deliver changes, but they are not crash-safe and cannot claim the full target Passed guarantee.
