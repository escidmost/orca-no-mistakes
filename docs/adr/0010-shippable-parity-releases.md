---
status: accepted
date: 2026-08-20
scope: target roadmap
implementation: partially implemented
acceptance: protected live proof pending
---

# Four Shippable Parity Releases

This ADR preserves the historical four-milestone delivery plan and its dated amendments. Its release numbers are roadmap labels, not supported product versions or selectable operating modes. See [Current architecture](../current-architecture.md) for implemented behavior and [Acceptance](../acceptance.md) for the evidence requirements.

The plan divides the target architecture into four independently useful milestones. Only the final milestone may emit the full Passed outcome defined by ADR-0005.

## Decision

1. **Local Adversarial Validation Core** runs trusted-policy `intent`, `rebase`, `review`, `test`, `document`, and `lint` stages in isolated worktrees and emits a tamper-evident local evidence manifest. It has no remote side effects and reports local completion, not Passed.
2. **Candidate Publication, Pull-Request Binding, and Settlement** adds the local submission gate, exact-head `--force-with-lease` candidate publication to the pull-request head branch, publication of the owned pull-request title/body report, keeping the PR stage active while the pull request is open, and settling only after an authoritative matching MERGED observation. It builds on the repository-scoped semantic leases pulled into Release 1. A durably failed run may be explicitly resumed after candidate publication by reconciling recorded remote facts and continuing from the first incomplete stage without rolling publication back. Adoption of an abandoned `in-progress` run remains deferred: a coordinator crash may strand pipeline-created commits, this limitation must be displayed, and Passed remains unavailable.
3. **Authoritative PR, CI, and Delivery Proof** adds complete GitHub reconciliation, trusted check-set completeness, expected-head non-bypass delivery, and delivered-tree verification. It may report `checks-passed` and verified delivery facts, but still withholds full Passed because custody recovery is absent.
4. **Resilient Recovery and Custody Synchronization** adds coordinator restart recovery, parked-gate reattachment, adoption of abandoned `in-progress` runs, and three-way custody reconciliation after interruption or divergence. Preserved recovery refs remain a Release 1 guarantee, as does uncontended fast-forward custody return on successful runs. Once every ADR-0005 invariant is implemented and accepted, this release may emit Passed.

## Amendment 2026-08-21

Release 1 pulled forward two capabilities the list above assigns to later releases, because both are prerequisites for a trustworthy local evidence manifest rather than remote-publication features:

- Repository-scoped semantic branch leases (item 2) — a local run must fail closed when a second run holds the branch, otherwise stage evidence is not bound to a single custodian.
- Preserved recovery refs and fast-forward custody return (item 4) — `refs/no-mistakes/recover/<run-id>` anchors pipeline-created commits so a local run cannot strand them.

Release 2 still owns `--force-with-lease` candidate publication, pull-request report publication, and merge settlement; Release 4 still owns coordinator restart recovery, parked-gate reattachment, and three-way custody reconciliation. Every other item stands as decided.

The local v1.3 evidence manifest emitted at the end of Release 1, historically called a "Passed Attestation" by that implementation, predates and does not satisfy the version 2 pipeline completion-attestation schema. It binds the recorded stage history and terminal candidate after every required *local* validation stage reaches an accepted terminal disposition; it does not prove that every stage ran against one unchanged candidate or prove delivery. Full "Passed" — including remote delivery, PR, and CI proof — remains reserved for Release 4.

## Amendment 2026-09-01

A focused, non-default publication API (`scripts/publication.ts`) pulled forward item 2's exact-head `--force-with-lease` publication primitive: it admits a custom plan whose final stage is `push` and enforces mandatory stable repository identity, transport-rewrite fencing, retained-evidence verification, authoritative post-read reconciliation, and durable receipts. It runs outside the default coordinator DAG, so the default six-stage plan remains local-only. Release 2 still owns automatic publication orchestration, pull-request report publication, and merge settlement.

The repository-local admission gate is also pulled forward from item 2 into Release 1. This moves only admission; Release 2 still owns automatic candidate publication orchestration, pull-request report publication, and merge settlement.

## Amendment 2026-09-02

Release 2 now runs `push` and `pr` after the six local validation stages for both direct and gate ingress. Candidate publication and pull-request report publication settle only with authoritative post-reads, keeping the PR stage active while the exact pull request is open and settling only after an authoritative matching MERGED observation with atomic receipts, evidence, dispositions, and checkpoints; successful runs store a v2 completion attestation and expose lowercase `passed`. Resume remains limited to durably failed runs: adopting a stranded `in-progress` remote run remains a Release 4 limitation.

## Acceptance status 2026-09-05

The [acceptance runbook](../acceptance.md) defines the local matrix, live fixtures, evidence and operator procedure for the title/body and matching-merge contract. The local matrix alone does not satisfy this decision: acceptance remains pending until macOS, Linux and protected live same-repository/fork results are retained.

## Status update (2026-09-06)

[ADR-0016](0016-ci-stage-monitoring-and-merge-settlement.md) adds CI monitoring and merge settlement as a ninth `ci` stage, moving the merge wait out of `pr`; delivery proof (delivered-tree verification, CI auto-fix re-publication) still belongs to the third roadmap milestone.

## Consequences

Before a release is marked complete, an automated end-to-end scenario must exercise its claimed Git, Orca, gate, failure, and recovery behavior. For what is implemented today, see [`docs/current-architecture.md`](../current-architecture.md).
