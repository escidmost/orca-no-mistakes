# Orca No-Mistakes

Orca No-Mistakes validates a proposed Git change before delivery. Its domain language distinguishes current pipeline execution from the evidence and custody required for the target `Passed` guarantee.

## Language

**Pipeline completion**:
An execution result indicating that every configured stage reached completion under the runner's current rules. Pipeline completion alone is not `Passed`.
_Avoid_: Passed, proven, safely merged

**Passed**:
The target terminal outcome proving that the exact delivered tree satisfied every required validation, review, pull-request, CI, and delivery policy. A required policy cannot be waived into Passed.
_Avoid_: Completed, green, worker succeeded

**Checks-passed**:
An intermediate target milestone proving that required local validation and remote CI are complete on the exact candidate commit, before delivery is verified.
_Avoid_: Passed, ready enough, all green

**Proposed change**:
The submitted Git commit and commit set being considered for validation and delivery.
_Avoid_: Working tree, current files

**Candidate commit**:
The exact commit produced after rebase and any fix rounds, against which stage and CI evidence is evaluated.
_Avoid_: Branch, latest HEAD

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

**Passed attestation**:
A portable, tamper-evident manifest binding target Passed evidence to the candidate and delivered commits. It does not independently prove authenticity unless a future trust anchor is added.
_Avoid_: Signature, immutable certificate, badge

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
The target durable store for proposed-change identity, leases, stage checkpoints, custody state, and evidence metadata.
_Avoid_: Orca scheduler database, run cache

**Branch semantic lease**:
An exclusive reservation preventing concurrent pipeline ownership of one repository branch.
_Avoid_: Worktree lock, process mutex

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
