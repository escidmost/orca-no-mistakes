---
status: accepted
date: 2026-09-06
scope: target architecture
implementation: implemented
---

# CI Stage Monitoring and Merge Settlement

The merge wait that the `pr` stage carried under ADR-0002 moves into a ninth coordinator-owned `ci` stage. `pr` settles as soon as the managed report is published; `ci` monitors the exact candidate's pull request until it is merged or closed and reports check failures to a human gate. ONM-100 extends the original monitor-only decision with selected repairs and superseding publication receipts (2026-09-12).

## Decision

- The Release 2 stage plan becomes `intent, rebase, review, test, document, lint, push, pr, ci`. Earlier v2 attestations whose frozen plan ends `push, pr` still verify; migrated Release 1 plans are unchanged.
- `pr` publishes the managed report on the exact candidate's pull request, notifies the originating terminal, and settles immediately with an open pull-request binding (`state: 'open'`, title and body hashes, pipeline evidence root). It no longer awaits merge.
- CI polling is coordinator-owned. Each poll observes the exact pull request by route and candidate head, fails closed with `pull-request facts changed while monitoring CI` if title, body, head, or draft state drift from the `pr` receipt, then reads state, mergeability, base tip, and the head commit's check rollup bucketed as pass, fail, pending, cancel, or skip.
- Decision table: `MERGED` with matching facts rereads exact-candidate checks and rejects failing, cancelled, pending, or mismatched-head checks before upgrading the receipt. Merge cannot waive a failure. `CLOSED` fails without a gate. While any check is pending, open-PR monitoring produces no verdict. With nothing pending, each failed or cancelled check yields an `ask-user` finding identified by a digest of its stable check ID, with its details URL. `CONFLICTING` adds a `merge-conflict` finding. Unrecognised conclusions fail; `NEUTRAL` and `SKIPPED` skip; `CANCELLED` and `STALE` cancel. All-pass/skip and no-checks-yet log and keep polling.
- Greptile is the supported review bot: its check must carry GitHub App ID `867647` and slug `greptile-apps`. Paginated unresolved, non-outdated threads and nested comment pages retain comment/thread IDs and file/line context. Only current-candidate comments by the Greptile bot are included. Comments are deduplicated; empty/unavailable details never remove the failed-check blocker. This does not imply universal bot support.
- The `ci` gate offers `fix [ids][: guidance]` and `stop`. Selected check or review concerns dispatch the existing isolated fixer; a monitoring-only timeout or unavailable-review finding retries monitoring. Exact selected check output is read against its stable ID and candidate. GitHub Actions logs additionally join check-suite/run/job identities, never display names. External text is bounded and framed as untrusted data alongside selected findings, guidance, and decision history.
- An idle timeout (`ci.timeout_ms`, default seven days, `0` unlimited) opens a gate with a single `ci-timeout` finding, `CI monitoring timed out before PR was merged or closed`, and no other findings. It re-arms whenever the pull request's base branch tip advances, so a long-lived but moving PR is not abandoned.
- `ci.no_ci: true` treats an empty check set as passed and is honored only from the trusted base-branch policy, never from the proposed branch or a local bypass.
- Polling backs off from 30 seconds to 60 and then 120 seconds, with a branch-lease heartbeat per poll. Stage-log placement is described in docs/current-architecture.md ("Evidence").
- A `passed` verdict on a nine-stage plan requires the merged receipt; the completion attestation binds that upgraded receipt digest.

## Consequences

Repair attempts are durable before worker launch. A guarded repair candidate is recorded before custody, then its checkpoint and completed-attempt state settle together. Fresh review, test, document, and lint evidence is required after repair; prior candidate-bound approval or validation evidence cannot authorize republication. Disabled or optional stages retain their frozen policy requirements. There is no continuity-only optimization.

Publication remains compare-and-swap: the first push uses the admitted baseline, while a repaired push replaces only the immediately preceding publication receipt's candidate. New push/PR rounds and disposition supersessions preserve old evidence; the publication receipt explicitly names its predecessor. The managed PR report is refreshed for the new candidate and includes CI repair history before monitoring resumes. Post-read reconciliation handles lost publication responses; a missing PR update receipt cannot be replaced by the old head's binding.

Interrupted attempts consume their recorded budget across resume. Failed or wedged repairs return to an explicit decision; existing `auto_fix.max_rounds` and fixer timeouts apply. Human waits and total run lifetime remain unbounded. Recovery refs preserve worker commits on cancellation. A failed run can reconcile a candidate recorded before custody and already present at HEAD, then revalidate; adopting an abandoned `in-progress` run remains the separate Release 4 limitation.

Transient check reruns and gate auto-reconciliation remain deferred. Trusted check-set completeness, guarded merge, and delivered-tree verification remain with ADR-0002 and ADR-0010; a lowercase `passed` run is not target assurance `Passed`.
