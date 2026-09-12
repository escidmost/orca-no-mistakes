---
status: accepted
date: 2026-08-20
scope: target architecture
implementation: partially implemented (Release 2; merge-state waiting and CI monitoring implemented, check completeness, branch-protection, and delivered-tree proof pending)
---

# PR and CI Proof Architecture

The target pipeline separates deterministic GitHub and Git object proof from adversarial agent diagnosis. Agents may explain failures or propose fixes; they do not decide that required CI or delivery policy passed.

## Decision

- A typed provider queries pull-request state, check runs, commit statuses, branch rules, and merge results against exact object IDs with complete pagination.
- Required checks must finish successfully. `neutral`, `skipped`, or absent checks satisfy Passed only when the effective trusted policy explicitly marks them optional; a generic empty check list never passes.
- Check completeness is evaluated against both the effective trusted manifest and applicable forge branch rules.
- Delivery uses a non-bypass expected-head transition that fails closed if the candidate or target base changed after reconciliation.
- GitHub merge fields are a delivery receipt, not delivered-tree proof. After delivery, the coordinator fetches the resulting Git objects and verifies candidate ancestry for merge commits or exact tree equality for squash/rebase delivery.

## Status update (2026-09-06)

[ADR-0016](0016-ci-stage-monitoring-and-merge-settlement.md) implements CI monitoring as a ninth `ci` stage that polls the exact candidate's check rollup and merge state; check-set completeness, guarded merge, and delivered-tree proof remain Release 3.

ONM-100 (2026-09-12) adds selected CI repair, full relevant revalidation, and guarded candidate republication with superseding receipts. This does not add check-set completeness or delivery proof.

## Consequences

The coordinator needs scoped non-bypass GitHub credentials and records full check lifecycle identifiers and timestamps. Agent summaries and PR state alone cannot produce `checks-passed` or `Passed`.
