---
status: accepted
date: 2026-08-20
scope: target architecture
implementation: partially implemented (Release 1)
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

Release 4 implements custody return and recovery under ADR-0010. Earlier remote-delivery releases explicitly accept that a crash may strand pipeline-created commits and therefore cannot emit the full target Passed outcome.
