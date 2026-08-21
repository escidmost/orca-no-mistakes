---
status: accepted
date: 2026-08-20
scope: target architecture
implementation: not implemented
---

# Proof Carried by Passed

`Passed` is reserved for a deterministic proof that the exact delivered tree satisfied every required policy. Current pipeline completion is deliberately named differently and must not be presented as Passed.

## Decision

Passed requires all of the following:

- Required local validation commands completed successfully under the effective trusted policy.
- Adversarial review has no unresolved blocking or `ask-user` findings. An approval may satisfy a policy that requires human judgment; it cannot waive a failed required check.
- Any waiver applies only to a policy explicitly classified as optional and records scope, reason, actor, and time.
- Required CI is complete and successful on the exact candidate commit under ADR-0002.
- The pull request was delivered through a non-bypass expected-head transition.
- Post-delivery Git verification proves delivered-tree integrity; GitHub PR fields alone are insufficient.
- Evidence is bound into the tamper-evident manifest defined by ADR-0004.

`checks-passed` is the intermediate state after required local validation, review, and CI succeed on the candidate commit but before delivery is verified. Closing a pull request without merge is neither `checks-passed` nor Passed.

## Consequences

A required stage cannot offer a waiver that still leads to Passed. Releases lacking an invariant may report narrower completion or delivery facts, but the full Passed outcome remains unavailable until Release 4 under ADR-0010.
