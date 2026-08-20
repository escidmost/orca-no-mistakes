# Proof Carried by Passed

To restore safety-semantic parity without unnecessary duplication of Orca or GitHub capabilities, the pipeline defines `Passed` as a deterministic, coordinator-proven attestation that the exact delivered commit satisfied all required local validation, adversarial review, pull request, CI, and non-bypass merge policies.

## Status

Accepted

## Context

In the original no-mistakes architecture, `Passed` was a monolithic guarantee that a proposed change cleared local gates, passed continuous integration, and landed on the remote target branch without manual bypass. As no-mistakes migrates to Orca orchestration, we must distinguish between:
1. Non-negotiable deterministic facts that the coordinator must mathematically or cryptographically prove.
2. Adversarial agent evaluations that provide diagnostic and generative value without sovereign authority to waive policies.
3. Original local infrastructure that can be safely weakened or replaced by Orca native orchestration and GitHub platform primitives without making `Passed` misleading.

## Decision

1. **Deterministic Coordinator Invariants**:
   - **Local Validation Proof**: The coordinator harness deterministically executes all required test, lint, format, and documentation commands derived from immutable trusted base policy, requiring exit code `0` and capturing SHA-256 digests of outputs.
   - **Adversarial Review Proof**: Reviewer prompts are compiled from trusted base definitions with untrusted data framing over the candidate diff. `Passed` requires 0 unaddressed blocking/ask-user findings. Approved design findings and operator waivers (`--action skip`) are recorded as explicit, signed audit entries in the validation ledger.
   - **Policy Provenance**: Validation policies, reviewer prompts, and required CI check manifests are immutably anchored to the trusted base commit SHA and coordinator engine. Branch policy diffs are cross-referenced against declared `--intent`.
   - **Dual-Anchored CI Completeness**: The coordinator queries GitHub APIs to confirm that all required check suites and commit statuses on the exact candidate commit OID are completed with `success` or `neutral` conclusions.
   - **Delivery & Merge Proof**: PR merge is proven via authoritative GitHub Pull Request API status fields (`merged: true`, `merged_at`, `merge_commit_sha`, `base_ref`, `head_sha`).
   - **Base Drift & Invalidation Loop**: If target base drift invalidates CI or creates conflicts, the coordinator auto-rebases, creates a new candidate commit OID, re-validates, and updates the PR head ref before granting `Passed`.

2. **Attestation Structure (`Passed Attestation`)**:
   - The coordinator records a Merkle tree root over an ordered manifest containing:
     - `candidate_commit_sha`
     - `base_commit_sha`
     - `policy_sha256`
     - `intent_hash` (and verbatim declared `--intent`)
     - `stage_evidence_manifest` (array of stage, round, exit code, actor ID, evidence SHA-256, and findings/waiver records)
     - `pr_delivery_proof` (`{ pr_number, merged_at, merge_commit_sha }`)
     - `coordinator_version`
   - The attestation is stored in the local SQLite ledger (`~/.orca-no-mistakes/ledger.db`) and published as a sticky collapsible comment on the pull request.

3. **`checks-passed` vs Terminal `Passed`**:
   - `checks-passed`: A non-terminal intermediate milestone attesting that local validation and remote CI on the candidate commit OID are 100% complete and green, signalling readiness for human/team review and merge.
   - `passed`: The terminal pipeline outcome reached only after authoritative GitHub API confirmation of non-bypass merge completion.

4. **Orca-Native and GitHub-Native Replacements (Allowed Guarantee Weakenings)**:
   - **Standalone Supervisor Daemon & TUI**: Replaced by Orca durable Runs, Tasks, and Dispatches, with CLI reattachment and status queries over AXI.
   - **Isolated Linked Worktrees**: Replaced by Orca workspaces governed by adapter-enforced branch semantic leases.
   - **Local Post-Merge Raw Git Fetch / Tree Verification**: Replaced by authoritative GitHub API pull request merge proof fields (`merged: true`, `merge_commit_sha`).
   - **Synchronous Terminal Blocking**: Replaced by asynchronous Orca DecisionGates and detached execution.

5. **Non-Negotiable Guarantees (Cannot Be Weakened)**:
   - Scoped non-bypass merge delivery (no administrative force-push or branch rule circumvention).
   - Exact commit OID binding across all validation and CI stages.
   - Trusted base policy immutability.
   - Zero unreviewed code changes and mandatory explicit per-push `--intent`.

## Consequences

- The coordinator enforces deterministic exit code checks and dual-anchored CI completeness before reporting `checks-passed` or `passed`.
- Human waivers (`skip`) and approvals (`approve`) are permanently attested in the ledger and PR summary rather than silently dropped.
- The pipeline relies cleanly on Orca for worker/run lifecycle and GitHub APIs for PR/CI proof while maintaining sovereign ownership of the validation ledger and delivery attestation.
