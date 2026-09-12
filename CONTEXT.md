# Orca No-Mistakes

Orca No-Mistakes validates a proposed Git change before delivery. Its domain language distinguishes current pipeline execution from the evidence and custody required for the target `Passed` guarantee.

## Language

**Pipeline completion**:
The historical execution fact that every required stage in a run's frozen stage plan reached an accepted terminal disposition. Pipeline completion alone does not determine which assurance claims are available.
_Avoid_: Passed, proven, safely merged

**Run verdict**:
The lowercase terminal status `passed`, `failed`, or `cancelled` recorded for a run against its frozen stage plan. A `passed` verdict is historical execution state, not the target `Passed` assurance claim.
_Avoid_: Assurance level, guarantee, current-policy judgment

**Frozen stage plan**:
The immutable ordered stage identities and requirement levels captured when a run starts. Later configuration or stage additions do not reinterpret it.
_Avoid_: Current pipeline, latest configuration, inferred stage list

**Assurance claim**:
A versioned, closed-vocabulary statement derived from trusted policy and exact attested evidence. Claims state what a run proved independently of its run verdict.
_Avoid_: Status label, stage-name inference, free-form badge

**Local submission gate**:
The repository-scoped Git endpoint that accepts one proposed feature-ref update with explicit intent as the primary pipeline ingress.
_Avoid_: Publication remote, delivery branch, scheduler

**Submission admission**:
The durable normalization of one direct invocation or local-gate update into one exact submission identity, which may remain pending or launched before later binding to a run.
_Avoid_: Process launch, hook success, branch push

**Accepted gate submission**:
A gate submission whose exact proposed ref update is visible in permanent Git state and anchored to its admitted run. Coordinator launch alone does not make a gate submission accepted.
_Avoid_: Pre-receive success, quarantined object, startup receipt

**Passed**:
The target terminal outcome proving that the exact delivered tree satisfied every required validation, review, pull-request, CI, and delivery policy. A required policy cannot be waived into Passed.
_Avoid_: Completed, green, worker succeeded

**Checks-passed**:
An intermediate target milestone proving that required local validation and remote CI are complete on the exact candidate commit, before delivery is verified. CI monitoring logs this state when every check is pass or skip but does not settle it.
_Avoid_: Passed, ready enough, all green

**Proposed change**:
The submitted Git commit and commit set being considered for validation and delivery.
_Avoid_: Working tree, current files

**Candidate commit**:
The exact commit produced after rebase and any fix rounds, against which stage and CI evidence is evaluated.
_Avoid_: Branch, latest HEAD

**Candidate publication**:
A guarded update that places the exact candidate commit on the remote pull-request head branch. It does not deliver the proposed change to the base branch or prove CI, merge, or Passed.
_Avoid_: Delivery, merge, ordinary force-push

**Publication route**:
The immutable per-run identity of the forge, stable base and head repositories, head owner, fully qualified publication ref, base branch, route fingerprint, and canonical credential-free transport used for candidate publication and pull-request binding.
_Avoid_: Origin, current remotes, push URL

**Repository publication route**:
The durable, mutable publication route persisted once per repository, keyed by the Git common dir so every worktree shares it, and bound to the authenticated actor, backend, forge, stable repository identities, owner, identity fingerprint, and canonical credential-free transport identity. It is guarded against authenticated-actor drift and against repository-identity change while active runs or resumable failed runs depend on it. Every Release 2 run snapshots it at start, with the run's own head and base branches, as its immutable per-run Publication route; legacy and provider-neutral runs do not.
_Avoid_: Per-run route, origin, ambient remote

**Publication head ref**:
The fully qualified feature-branch ref in the publication route's head repository. It receives the candidate commit and becomes the pull request's head ref.
_Avoid_: Remote HEAD, default branch, base branch

**Publication baseline**:
The exact remote pull-request head commit, or authoritative absence, recorded when a run starts. Initial candidate publication may replace only this recorded state; a repair publication may replace only the candidate in its immediately preceding publication receipt.
_Avoid_: Remote-tracking branch, latest fetched head, inferred lease

**Candidate publication receipt**:
A durable record that binds a publication route, publication baseline or superseded publication receipt, candidate commit, immediate remote observations, and publication outcome. It proves only the observed pull-request head state, not final delivery.
_Avoid_: Push log, delivery proof, PR URL

**Forge repository identity**:
The stable forge host, repository object identifiers, and fork-network identity used to distinguish a publication route from mutable repository names and URLs.
_Avoid_: Owner/name string, remote URL, current repository

**Forge authentication observation**:
A time-bound record of the authenticated forge actor and the exact repositories that actor could access. It does not contain credentials or prove that a later mutation will remain authorized.
_Avoid_: Token, login configuration, permanent permission

**Forge authority observation**:
A complete, typed, timestamped set of repository or pull-request facts obtained from an explicit forge host and validated against stable object identities.
_Avoid_: CLI success, truncated summary, ambient repository, raw API payload

**Pull-request binding**:
The association of a publication route and candidate commit with one exact pull request identified by stable forge repository, pull-request, base-ref, and head-ref identities, retained until the forge reports that pull request merged.
_Avoid_: PR URL, branch-name match, latest pull request

**Managed pull-request report**:
The Orca No-Mistakes-owned title and original pull-request body containing the bounded run intent, final-diff change summary, risk assessment, testing evidence, and pipeline attestation under a 63,488-byte budget, truncating oversized intent or What Changed sections with an explicit marker (`_[truncated to fit GitHub PR body limits]_`) when necessary. Pipeline details present analysis findings, applied fixer summaries, approvals, and clean re-checks as a concise narrative instead of raw report dumps; the attestation includes completed stages plus the running PR and pending CI lifecycle states. The coordinator creates or refreshes this report and notifies the originating terminal that the pull request is ready; the `ci` stage then awaits merge. It does not move pipeline detail into a comment.
_Avoid_: Managed comment, trust anchor, remote evidence store

**Pull-request binding receipt**:
A durable local record binding the exact pull request and managed report hashes to the publication route, candidate commit, forge observations, and operation outcome. It is settled open by the `pr` stage and upgraded to merged by the `ci` stage.
_Avoid_: PR URL, body text, create response

**Open pull-request binding**:
The `pr` stage's settled pull-request binding receipt with `state: 'open'`, recording the published title and body hashes and the pipeline evidence root before any merge observation.
_Avoid_: PR created, merged binding, provisional receipt

**Merged pull-request binding**:
The `ci` stage's upgrade of the open pull-request binding to `state: 'merged'` after an authoritative MERGED observation whose head, route, title hash, and body hash still match. Required for a `passed` verdict on a nine-stage plan.
_Avoid_: PR merged, merge SHA recorded, delivered tree

**CI monitoring**:
The observation of an exact candidate's pull-request state, mergeability, checks, and supported review-bot concerns until merge or closure. Actionable failures require a repair or stop decision; monitoring alone does not change the candidate.
_Avoid_: CI proof, check completeness, auto-fix

**CI repair attempt**:
A selected response to CI findings that may produce a new candidate. Its consumed worker budget, original publication receipt, and candidate transition remain part of the run's history. A repaired candidate requires fresh validation and guarded publication before monitoring resumes.
_Avoid_: Check rerun, review waiver, new run

**Required policy**:
A validation or delivery rule that must be satisfied for Passed to be available.
_Avoid_: Recommendation, optional check

**Optional policy**:
A declared rule whose omission may be explicitly waived without misrepresenting Passed.
_Avoid_: Required check, best effort

**Trusted validation policy**:
The required rules, reviewer prompts, execution constraints, and CI requirements sourced from the trusted base and coordinator rather than the proposed change.
_Avoid_: Branch config, local preference

**Effective validation policy**:
The trusted validation policy plus any proposed policy delta explicitly approved through guarded policy evolution.
_Avoid_: Current branch policy, merged settings

**Guarded policy evolution**:
The process for reviewing, approving, and revalidating a proposed change to tests, configuration, documentation rules, or other validation policy.
_Avoid_: Free config editing, silent fallback

**Intent reconciliation**:
Adversarial verification that changes to existing validation constraints are justified by the user's declared intent.
_Avoid_: Diff summary, automatic test update

**Untrusted data framing**:
Treating proposed code, repository instructions, and diffs as data inside coordinator-owned prompts rather than as trusted pipeline instructions.
_Avoid_: Prompt concatenation, inherited authority

**Actionable finding**:
A reported concern requiring repair or an explicit decision before its stage can proceed.
_Avoid_: Informational note, console message

**Decision gate**:
A blocking Orca checkpoint awaiting one explicit authorized resolution.
_Avoid_: Pause, prompt, implicit approval

**Run TUI**:
An optional, human-facing terminal interface for observing and safely controlling one pipeline run. Direct invocations select it with `--tui`; Orca-native launches select it by default.
_Avoid_: Multi-run dashboard, worker shell, policy editor

**Plain status renderer**:
A non-interactive, line-oriented view of meaningful transitions in one pipeline run. Direct invocations select it with `--no-tui`, which is mutually exclusive with `--tui`; it is also used when the Run TUI is unavailable.
_Avoid_: Raw subprocess stream, static final report, screen-reader-only mode

**Auto-fix mode**:
A durable run-level mode that automatically starts fix rounds for findings eligible for automatic repair, distinct from the Run TUI's local gate auto-responder; see [Findings and gates](docs/current-architecture.md#findings-and-gates). Resumed attempts inherit the run's latest durable setting. It never waives required policy or answers decision gates that require human judgment.
_Avoid_: YOLO mode, unattended approval, policy bypass

**Run cancellation**:
The terminal outcome when an operator stops a run before it passes or fails. Cancel requests an orderly stop; Force stop escalates immediately. Both produce the same outcome, while retaining which action occurred as evidence.
_Avoid_: Abort status, failed run

**Resumable error**:
An error the pipeline explicitly identifies as safe to continue from a durable checkpoint. Operators may resume only when the pipeline declares this condition.
_Avoid_: Retry any error, restart stage

**Approval**:
An authorized decision satisfying a policy that explicitly requires human judgment. Approval is not a waiver of a failed required policy.
_Avoid_: Override, bypass

**Waiver**:
An explicit decision not to execute or satisfy an optional policy, recorded with its scope and reason.
_Avoid_: Approval, skip-pass

**Fix round**:
One repair attempt against a specified finding set, followed by a committed change and re-evaluation.
_Avoid_: Retry, patch iteration

**Exhaustion gate**:
A target decision gate raised after the configured fix-round limit while actionable findings remain.
_Avoid_: Timeout, automatic failure

**Stage evidence**:
Captured facts and artifacts identifying a stage, round, candidate commit, actor, result, and output digest.
_Avoid_: Console dump, task status

**Run attempt**:
One generation-fenced coordinator execution of a run. Explicit resume creates a new attempt under the same run identity without erasing earlier attempt outcomes.
_Avoid_: New run, retry counter, worker session

**Attempt outcome**:
An immutable, digestible settlement record for one run attempt, including its verdict, stopping point, custody facts, remote-receipt references, actors, and timestamps.
_Avoid_: Current status row, mutable failure message, console exit

**Pipeline evidence root**:
A deterministic root binding the frozen stage plan and evidence through candidate publication. Its stage facts are published in the managed pull-request report before the pull-request binding receipt exists.
_Avoid_: Completion-attestation root, remote trust anchor, raw evidence link

**Pipeline completion attestation**:
A portable, tamper-evident manifest using the version 2 completion schema for a run with a `passed` verdict. It binds the frozen stage plan, recorded stage dispositions and evidence, candidate-publication and pull-request-binding receipt digests, all attempt-outcome digests (explicitly including the terminal passed attempt; only pipelineEvidenceRoot excludes that final digest), custody facts, and explicit assurance claims to the candidate commit. It proves historical observations, not current remote state or independent authenticity.
_Avoid_: Passed, signature, live-status certificate

**Passed attestation**:
A pipeline completion attestation carrying the target `Passed` assurance claim and binding its required evidence to the candidate and delivered commits. Release 2 cannot produce one.
_Avoid_: Any passed-verdict attestation, signature, badge

**Reconciliation snapshot**:
A recorded set of pull-request, candidate-commit, and check-run facts queried against exact forge and Git object identifiers.
_Avoid_: Status poll, API cache

**Dual-anchored check completeness**:
Proof that every required CI check ran, based on both trusted policy and applicable forge branch rules.
_Avoid_: Nonempty check list, all visible checks green

**Guarded delivery transition**:
A non-bypass forge operation that fails if the candidate head or target base no longer matches the verified state.
_Avoid_: Ordinary merge, push-on-green

**Delivered tree integrity**:
Post-delivery proof that the target branch contains the exact tested candidate tree, with ancestry verified where the merge form preserves it.
_Avoid_: PR merged, merge SHA recorded

**Domain ledger**:
The repository-scoped durable store for proposed-change identity, leases, stage checkpoints, custody state, and evidence metadata.
_Avoid_: Orca scheduler database, run cache

**Branch semantic lease**:
An exclusive reservation preventing concurrent pipeline ownership of one repository branch.
_Avoid_: Worktree lock, process mutex, Git force-with-lease

**Branch custody**:
Responsibility for advancing and preserving the proposed-change branch while pipeline commits may be created.
_Avoid_: Checkout ownership, Git lock

**Preserved head**:
A Git ref anchoring pipeline-created commits that have not been safely returned to the operator.
_Avoid_: Backup branch, orphan commit

**Custody recovery**:
Returning or exposing a preserved pipeline head without silently discarding operator commits.
_Avoid_: Force reset, automatic overwrite

**Safety-semantic parity**:
Preserving the meaning and guarantees of Passed while replacing implementation machinery with Orca-native or forge-native capabilities.
_Avoid_: Feature parity, command parity

**Shippable parity release**:
An independently useful roadmap release with explicit guarantees, limitations, and acceptance evidence.
_Avoid_: Unqualified Passed release, priority bucket
