---
status: accepted
date: 2026-08-20
scope: target architecture
implementation: partially implemented
---

# Orca Native Guarantee Boundary

Orca owns generic orchestration lifecycle; Orca No-Mistakes owns Git, policy, and proof semantics. Neither component may fabricate facts owned by the other.

## Decision

- Orca is authoritative for Runs, Tasks, Dispatches, worker lifecycle, mailbox delivery, decision-gate status, resolution, resolver identity when available, and terminal release.
- Orca No-Mistakes owns proposed-change identity, the repository ledger, branch semantic leases, exact-commit custody, effective-policy execution, Git and forge reconciliation, and Passed evaluation.
- The domain ledger records Orca identifiers and copies authoritative gate facts for evidence. It does not invent resolver provenance or replace Orca's scheduler.
- If Orca cannot supply an authoritative fact required by effective policy, the adapter may ship a narrower workflow but must withhold Passed rather than substitute an unverifiable local assertion.

## Consequences

The adapter has no standalone task scheduler, worker daemon, or terminal supervisor. Generic missing capabilities should be improved upstream; domain-specific invariants remain in this project.
