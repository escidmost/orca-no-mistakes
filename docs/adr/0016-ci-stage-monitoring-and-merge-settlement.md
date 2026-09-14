---
status: accepted
date: 2026-09-06
scope: target architecture
implementation: implemented
---

# CI Stage Monitoring and Merge Settlement

The merge wait that the `pr` stage carried under ADR-0002 moves into a ninth coordinator-owned `ci` stage. `pr` settles as soon as the managed report is published; `ci` monitors the exact candidate's pull request until it is merged or closed and reports check failures to a human gate. This ports the Go `no-mistakes` CI step without adding auto-fix.

## Decision

- The core stage plan is `intent, rebase, review, test, document, lint, push, pr, ci`. Stored plans and attestations retain their original meaning under the [compatibility contract](../current-architecture.md#retained-run-compatibility).
- `pr` publishes the managed report on the exact candidate's pull request, notifies the originating terminal, and settles immediately with an open pull-request binding (`state: 'open'`, title and body hashes, pipeline evidence root). It no longer awaits merge.
- `ci` runs no worker agent. Each poll observes the exact pull request by route and candidate head, fails closed with `pull-request facts changed while monitoring CI` if title, body, head, or draft state drift from the `pr` receipt, then reads state, mergeability, base tip, and the head commit's check rollup bucketed as pass, fail, pending, cancel, or skip.
- Decision table, evaluated in this order on every poll: `MERGED` with matching facts upgrades the receipt to a merged pull-request binding and passes the stage. `CLOSED` fails the stage with `the exact pull request was closed without merging` and no gate. While any check is `pending` there is no verdict; the stage logs and keeps polling. With nothing pending, every check whose bucket is `fail` or `cancel` yields one `ask-user` finding (id `ci-<name>`, with its details URL), and mergeability `CONFLICTING` independently adds a `merge-conflict` finding; any finding opens a gate with summary `CI failures detected on pull request #N`. There is no aggregate cancelled-or-unresolved finding. Completed checks with an unrecognised conclusion bucket as `fail`; `NEUTRAL` and `SKIPPED` bucket as `skip`; `CANCELLED` and `STALE` as `cancel`. All pass or skip and no-checks-yet each log a status line and keep polling.
- The `ci` gate offers `fix` and `stop`. `fix` means resume monitoring after the human acted externally; the stage repairs nothing itself.
- An idle timeout (`ci.timeout_ms`, default seven days, `0` unlimited) opens a gate with a single `ci-timeout` finding, `CI monitoring timed out before PR was merged or closed`, and no other findings. It re-arms whenever the pull request's base branch tip advances, so a long-lived but moving PR is not abandoned.
- `ci.no_ci: true` treats an empty check set as passed and is honored only from the trusted base-branch policy, never from the proposed branch or a local bypass.
- Polling backs off from 30 seconds to 60 and then 120 seconds, with a branch-lease heartbeat per poll. Stage-log placement is described in docs/current-architecture.md ("Evidence").
- A `passed` verdict on a nine-stage plan requires the merged receipt; the completion attestation binds that upgraded receipt digest.

## Consequences

CI monitoring reaches the origin as a durable gate instead of a stalled `pr` task, and a checks-passed state is logged but never settled as proof. Deferred work includes CI auto-fix with candidate re-publication, transient check reruns (`ci.rerun_transient`), merge-conflict auto-repair, and gate auto-reconciliation while a gate is open. These paths must account for exact-candidate evidence when repairs require another publication; the single-publication attestation model cannot express re-publication without `push` and `pr` rounds greater than zero and receipt supersession. Trusted check-set completeness, guarded merge, and delivered-tree verification remain with ADR-0002 and ADR-0010.
