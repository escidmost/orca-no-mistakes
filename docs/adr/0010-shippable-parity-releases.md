---
status: accepted
date: 2026-08-20
scope: target roadmap
implementation: partially implemented
---

# Four Shippable Parity Releases

The target architecture is delivered in four independently useful releases. Each release states its limitations; only Release 4 may emit the full Passed outcome defined by ADR-0005.

## Decision

1. **Local Adversarial Validation Core** runs trusted-policy `intent`, `rebase`, `review`, `test`, `document`, and `lint` stages in isolated worktrees and emits a tamper-evident local evidence manifest. It has no remote side effects and reports local completion, not Passed.
2. **Guarded Remote Delivery and Branch Leasing** adds the local Git gate, repository-scoped semantic leases, exact-head `--force-with-lease` delivery, and pull-request creation. Crash recovery is deliberately deferred: a coordinator crash may strand pipeline-created commits, this limitation must be displayed, and Passed remains unavailable.
3. **Authoritative PR, CI, and Delivery Proof** adds complete GitHub reconciliation, trusted check-set completeness, expected-head non-bypass delivery, and delivered-tree verification. It may report `checks-passed` and verified delivery facts, but still withholds full Passed because custody recovery is absent.
4. **Resilient Recovery and Custody Synchronization** adds coordinator restart recovery, parked-gate reattachment, preserved recovery refs, three-way custody reconciliation, and safe return of pipeline-created commits. Once every ADR-0005 invariant is implemented and accepted, this release may emit Passed.

## Consequences

Before a release is marked complete, an automated end-to-end scenario must exercise its claimed Git, Orca, gate, failure, and recovery behavior. The current implementation delivers the Release 1 stage set and pulls forward branch leases and preserved recovery refs from later releases; see [`docs/current-architecture.md`](../current-architecture.md).
