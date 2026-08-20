# Define the Proof Carried by Passed

Linear: [ONM-12](https://linear.app/escidmore/issue/ONM-12/define-the-proof-carried-by-passed)

Type: grilling
Status: resolved
Blocked by:

## Question

Which exact Git, review, validation, pull-request, and CI facts must be coordinator-proven before the pipeline may report Passed, and which original guarantees may be weakened without making that outcome misleading?

## Answer

`Passed` is the terminal proof outcome certifying that the exact delivered commit satisfied all required local validation, adversarial review, pull request, CI, and non-bypass delivery policies:

1. **Deterministic Coordinator Invariants**:
   - **Local Validation**: Deterministic execution of test, lint, format, and doc suites derived from trusted base policy, requiring exit code `0` and capturing output hashes.
   - **Adversarial Review**: Diff review executed with untrusted data framing against declared `--intent`; requires 0 unaddressed blocking/ask-user findings. Approved design findings and operator waivers (`--action skip`) are recorded as signed audit entries.
   - **Policy Provenance**: Sourced immutably from trusted base commit SHA and coordinator engine.
   - **Dual-Anchored CI Completeness**: Authoritative GitHub check runs and commit statuses on the candidate OID are complete with `success`/`neutral` conclusion (0 failed/cancelled).
   - **Delivery Proof**: PR merge is proven via authoritative GitHub Pull Request API status fields (`merged: true`, `merged_at`, `merge_commit_sha`, `base_ref`, `head_sha`).
   - **Base Drift & Auto-Rebase**: If target base drift invalidates CI or creates conflicts, the coordinator auto-rebases, creates a new candidate commit OID, re-validates, and updates PR head before `Passed`.
2. **Passed Attestation**:
   - An immutable Merkle tree root over `{ candidate_commit_sha, base_commit_sha, policy_sha256, intent_hash, stage_evidence_manifest, pr_delivery_proof, coordinator_version }`.
   - Persisted in the local SQLite domain ledger (`~/.orca-no-mistakes/ledger.db`) and rendered as a collapsible comment on the PR.
3. **`checks-passed` vs `passed`**:
   - `checks-passed`: Non-terminal milestone proving local validation and remote CI on the candidate OID are 100% green and ready for merge.
   - `passed`: Terminal outcome reached only after authoritative GitHub API confirmation of non-bypass merge completion.
4. **Orca-Native and Platform Replacements (Allowed Guarantee Weakenings)**:
   - Standalone supervisor daemon & TUI -> Orca durable Runs, Tasks, Dispatches, and AXI.
   - Isolated linked worktree duplication -> Orca workspaces with branch semantic leases.
   - Local post-merge raw git fetch / tree verification -> Authoritative GitHub API PR merge status fields (`merged: true`, `merge_commit_sha`).
   - Synchronous terminal blocking -> Asynchronous Orca DecisionGates.

Documented in ADR: `docs/adr/0005-proof-carried-by-passed.md` and terms in `CONTEXT.md`.
