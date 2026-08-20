# Choose the Orca Upstream Dependency Boundary

Linear: [ONM-8](https://linear.app/escidmore/issue/ONM-8/choose-the-orca-upstream-dependency-boundary)

Type: grilling
Status: resolved
Blocked by: 05, 06, 08, 09

## Question

Which identified generic gaps should become Orca upstream changes, which need safe adapter-owned fallbacks, and which parity releases may depend on new Orca versions rather than carrying weaker local substitutes?

## Answer

- **Upstream Dependency Policy**: Shippable parity releases do not hard-block on new upstream Orca versions. All essential safety guarantees are provided immediately using safe adapter-owned fallbacks in a local SQLite validation ledger.
- **Authority Boundary**: Orca owns native orchestration authority (durable Runs, Tasks, Dispatches, mailbox delivery, worker lifecycle, gate mechanics). The adapter owns the domain ledger for the exact proposed change, branch semantic leases, gate resolver provenance, findings overrides, and commit-bound Passed attestations.
- **Upstream Contributions**: Five generic gaps are identified as author-contributed upstream PRs to Orca:
  1. Atomic worktree occupancy leases at worker start.
  2. Canonical path and git-common-dir resolution for external linked worktrees.
  3. DecisionGate resolver principal and metadata persistence.
  4. Durable orchestration audit export and retention CLI.
  5. Headless / disconnected control-plane durability for SSH environments.
- **Version Gating**: The adapter enforces an Orca CLI minimum version fence (`>= 1.4.185`) and probes capabilities fail-closed at startup.

Documented in ADR: `docs/adr/0009-orca-upstream-dependency-boundary.md`
