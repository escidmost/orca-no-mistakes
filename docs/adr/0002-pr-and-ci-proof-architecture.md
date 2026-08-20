# PR and CI Proof Architecture

To restore safety-semantic parity for the Passed outcome on GitHub, the pipeline separates deterministic proof evaluation from adversarial agent analysis through a typed GitHub provider seam (`PrProofProvider`). The deterministic coordinator executes exact OID reconciliation queries, proves check completeness via dual-anchored manifests and forge rulesets, executes guarded delivery transitions with non-bypass credentials, and verifies delivered tree integrity, while adversarial agent tasks are restricted to diagnosing failures and generating fixes.

## Status

Accepted

## Considered Options

- **CLI Wrapper (`gh`) vs Direct Typed GraphQL/REST Client**: Wrapping the `gh` CLI was rejected because CLI commands lack atomic commit-bound checks and merge proofs, discarding essential provenance.
- **Agent-Assisted Verdicts vs Strict Deterministic Coordinator**: Delegating check evaluation or policy waiver decisions to agents was rejected to ensure adversarial separation; agents remain diagnostic and generative.
- **Open-World Observation vs Dual-Anchored Check Completeness**: Trusting dynamic check registrations without a trusted manifest was rejected because unobserved or delayed checks could silently pass.
- **Admin Bypass Merge vs Non-Bypass Guarded Transition**: Using bypass credentials was rejected because it avoids GitHub's server-side branch protection rules, defeating the auditability of the merge transition.

## Consequences

- The coordinator requires direct GitHub API access with scoped non-bypass credentials (GitHub App or fine-grained PAT).
- Check suites and legacy commit statuses are tracked by full lifecycle tuples (`check_run_id`, `completed_at`, `status`, `conclusion`) against exact candidate commit OIDs.
- Post-merge verification must confirm parent ancestry (for merge commits) or tree SHA equality (for squash/rebase) before issuing a Passed outcome.
