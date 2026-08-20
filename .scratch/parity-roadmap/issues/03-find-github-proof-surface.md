# Find GitHub's Authoritative PR and CI Proof Surface

Linear: [ONM-10](https://linear.app/escidmore/issue/ONM-10/find-githubs-authoritative-pr-and-ci-proof-surface)

Type: research
Status: resolved
Blocked by:

## Question

Which GitHub API facts and transitions can deterministically prove pull-request identity, exact head and base, check-set completeness, mergeability, terminal CI state, closure, and merge, and which races must the coordinator defend against?

## Answer

The smallest authoritative GitHub surface is a fully paginated reconciliation snapshot bound to repository, PR, head, base, and tested commit identities; a guarded expected-head merge or merge-queue transition performed by a proven non-bypass identity; and a post-transition merged and resulting-commit snapshot.

Checks API runs and legacy statuses must both be reconciled against the exact tested object. Webhooks are signed, deduplicated wakeups only. GitHub cannot prove open-world check completeness, atomically pin a direct merge to an expected base SHA, prove that bare `merged=true` traversed policy, or prove that an asserted CI result reflects real execution. Trusted policy must close those gaps.

Research context: branch `research/github-proof-surface`, commit `f53c9652b738a8ac755ebb06b76ee9d42e23ef71`, report `.scratch/parity-roadmap/research/03-github-proof-surface.md`.
