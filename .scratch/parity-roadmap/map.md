# Restore Safety-Semantic Parity Through Shippable Orca Releases

Linear: [ONM-1](https://linear.app/escidmore/issue/ONM-1/restore-safety-semantic-parity-through-shippable-orca-releases) (canonical)

Label: wayfinder:map

## Destination

A decision-ready roadmap of safety-first, independently shippable releases that restores the original meaning of Passed while omitting capabilities Orca replaces with acceptably equivalent guarantees.

## Notes

Domain: adversarial Git validation and delivery through Orca Orchestration.

Consult: `grilling`, `domain-modeling`, `research`, `prototype`, and `codebase-design` as appropriate.

Standing decisions: planning only; safety-semantic parity; safety-first ordering; live Orca/Git/GitHub end-to-end proof per release; GitHub-first provider seam; macOS and Linux; reliable team use; breaking changes allowed; preserve `/no-mistakes`, direct `run`, and per-push-intent submission; treat feature branches, project instructions, commands, agent output, and remote movement as untrusted.

An Orca-native replacement is accepted only after comparing how much authority, durability, recovery, and auditability it preserves. If the gap is material, explicitly decide whether the fix belongs in Orca or this project.

## Decisions so far

- [Find Orca's Native Guarantee Boundary](https://linear.app/escidmore/issue/ONM-5/find-orcas-native-guarantee-boundary): Orca owns durable orchestration custody; this project must own exact Git change, policy, and Passed evidence, with generic occupancy and provenance gaps considered for Orca upstream.
- [Find GitHub's Authoritative PR and CI Proof Surface](https://linear.app/escidmore/issue/ONM-10/find-githubs-authoritative-pr-and-ci-proof-surface): Authoritative proof requires reconciled commit-bound API facts and a guarded non-bypass transition; webhooks and worker claims are wakeups or analysis, not evidence.
- [Choose the Coordinator Recovery Model](https://linear.app/escidmore/issue/ONM-3/choose-the-coordinator-recovery-model): Pipeline state and Git custody live in a dedicated SQLite domain ledger while delegating durable worker/gate lifecycle to Orca. On restart, the coordinator rebinds Orca runs with generation fencing, opportunistically adopts healthy workers (with clean checkpoint restart fallbacks), reattaches to durable decision gates, and preserves stranded commits under recovery refs with three-way containment proof.

## Not yet specified

- The final number, names, and boundaries of releases depend on the custody, policy, recovery, and provider-proof decisions.
- The migration path from the current prototype depends on the chosen authoritative custody and coordinator-recovery models.
- The provider interface beyond GitHub depends on what the first deterministic GitHub integration proves reusable.
- The exact migration sequence from synchronous hooks to durable submission depends on the custody and recovery decisions.

## Out of scope

- Implementing the roadmap; this effort ends when the decisions are complete and implementation tickets can be written.
- Deterministic adapters for GitLab, Forgejo, Bitbucket Cloud, and Azure DevOps; retain a provider seam but ship GitHub first.
- Windows support.
- Recreating a standalone daemon, terminal supervisor, or TUI where Orca provides an acceptable replacement.
- Public-product updater, telemetry, and broad distribution machinery.
- Transcript-based intent inference; intent remains explicit per invocation.
