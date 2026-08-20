# Choose the PR and CI Proof Architecture

Linear: [ONM-2](https://linear.app/escidmore/issue/ONM-2/choose-the-pr-and-ci-proof-architecture)

Type: grilling
Status: resolved
Blocked by: 01, 03, 05

## Question

Which PR and CI operations must be deterministic coordinator logic, which may remain adversarial agent analysis, and what GitHub-first provider seam preserves exact commit and check provenance?

## Answer

PR and CI validation separates deterministic coordinator logic from adversarial agent tasks via a typed `PrProofProvider` seam on GitHub:

1. **Deterministic Coordinator Boundary**: The coordinator owns immutable reconciliation snapshots (bound to exact repository, PR number, candidate commit SHA, `headRefOid`, and `baseRefOid`), dual-anchored check completeness verification (matching default-branch policy manifests and branch rulesets), guarded delivery transitions (`expected_head_sha` direct merge or merge queue), post-delivery tree integrity verification, and issuing the `Passed` attestation.
2. **Adversarial Agent Boundary**: Orca worker tasks diagnose check/test failures, generate proposed code fixes, resolve rebase conflicts, and inspect intent conformance. Agent outputs remain strictly untrusted and generative; the coordinator always re-verifies resulting commits deterministically.
3. **GitHub Provider Seam**: A direct typed GraphQL and REST client queries exact commit OIDs (`object(oid: ...)`), tracks check runs by full lifecycle tuples (`check_run_id`, `completed_at`, `status`, `conclusion`), executes guarded merges using non-bypass credentials, and treats webhooks as signed reactive wakeup triggers only.

Decision context: ADR `docs/adr/0002-pr-and-ci-proof-architecture.md`.
