---
status: accepted
date: 2026-08-20
scope: target architecture
implementation: partially implemented
---

# Authoritative Git Custody Model

The target pipeline owns an exact proposed-change head while it creates rebases and fixes, without mutating or silently replacing the operator's active checkout.

## Decision

- Record each submission and stage transition in `<git-common-dir>/orca-no-mistakes/ledger.sqlite` and anchor the pipeline head under `refs/no-mistakes/heads/<run-id>`.
- Run reviewers and fixers in pipeline-owned worktrees. Stage checkpoints record input and output commit IDs before the next stage begins.
- Acquire one exclusive semantic lease per repository identity and branch. The lease contains the active run, coordinator generation, and heartbeat; a stale generation cannot update refs or checkpoints.
- Before any terminal release, preserve an unpublished terminal head under `refs/no-mistakes/recover/<run-id>`.
- If the operator head still equals the submitted head, custody may advance by fast-forward. Otherwise the coordinator leaves both heads intact and requires an explicit recovery decision after proving whether the terminal head contains the submitted and operator work.

## Consequences

The current pipeline preserves recovery refs for terminal runs and returns custody by uncontended fast-forward on successful runs. Adoption and three-way custody recovery for interrupted or divergent runs remain planned under ADR-0010. A crash may strand pipeline-created commits, so the full target Passed outcome remains unavailable.
