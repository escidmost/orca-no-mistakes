---
status: accepted
date: 2026-09-06
scope: target architecture
implementation: implemented
---

# CI Stage Monitoring and Merge Settlement

The merge wait that the `pr` stage carried under ADR-0002 moves into a ninth coordinator-owned `ci` stage. `pr` settles as soon as the managed report is published; `ci` monitors the exact candidate's pull request until it is merged or closed and reports check failures to a human gate. This ports the Go `no-mistakes` CI step without adding auto-fix.

## Decision

- The Release 2 stage plan becomes `intent, rebase, review, test, document, lint, push, pr, ci`. Earlier v2 attestations whose frozen plan ends `push, pr` still verify; migrated Release 1 plans are unchanged.
- `pr` publishes the managed report on the exact candidate's pull request, notifies the originating terminal, and settles immediately with an open pull-request binding (`state: 'open'`, title and body hashes, pipeline evidence root). It no longer awaits merge.
- `ci` runs no worker agent. Each poll observes the exact pull request by route and candidate head, fails closed with `pull-request facts changed while monitoring CI` if title, body, head, or draft state drift from the `pr` receipt, then reads state, mergeability, base tip, and the head commit's check rollup bucketed as pass, fail, pending, cancel, or skip.
- Decision table: `MERGED` with matching facts upgrades the receipt to a merged pull-request binding and passes the stage. `CLOSED` fails the stage without a gate. Failing checks with nothing pending open a gate with one `ask-user` finding per failing check and a `merge-conflict` finding when mergeability is `CONFLICTING`. Cancelled or unknown checks with nothing failing or pending open a gate with `CI checks cancelled or unresolved`. All pass or skip, pending, and no-checks-yet each log and keep polling.
- The `ci` gate offers `fix` and `stop`. `fix` means resume monitoring after the human acted externally; the stage repairs nothing itself.
- An idle timeout (`ci.timeout_ms`, default seven days, `0` unlimited) opens a gate with `CI monitoring timed out before PR was merged or closed` plus known failures. It re-arms whenever the pull request's base branch tip advances, so a long-lived but moving PR is not abandoned.
- `ci.no_ci: true` treats an empty check set as passed and is honored only from the trusted base-branch policy, never from the proposed branch or a local bypass.
- Polling backs off from 30 seconds to 60 and then 120 seconds, with a branch-lease heartbeat per poll. The stage writes no stage log, like `push`.
- A `passed` verdict on a nine-stage plan requires the merged receipt; the completion attestation binds that upgraded receipt digest.

## Consequences

CI monitoring reaches the origin as a durable gate instead of a stalled `pr` task, and a checks-passed state is logged but never settled as proof. Deferred to Release 3: CI auto-fix with candidate re-publication, transient check reruns (`ci.rerun_transient`), merge-conflict auto-repair, and gate auto-reconciliation while a gate is open. Each of these requires a second exact-candidate publication, which the single-publication attestation model cannot express: re-publication needs `push` and `pr` rounds greater than zero and receipt supersession. Trusted check-set completeness, guarded merge, and delivered-tree verification remain with ADR-0002 and ADR-0010.
