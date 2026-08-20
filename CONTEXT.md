# Orca No-Mistakes

Orca No-Mistakes provides adversarial validation of a proposed Git change before delivery. Its domain is the evidence and custody needed to justify a pipeline outcome.

## Language

**Passed**:
A pipeline outcome proving that the exact delivered commit satisfied the required local, review, pull-request, and CI policies.
_Avoid_: Completed, green, worker succeeded

**Safety-semantic parity**:
Parity with the original safety guarantees and meaning of Passed, without recreating functionality that Orca replaces with sufficiently equivalent guarantees.
_Avoid_: Feature parity, command parity, workflow similarity

**Orca-native replacement**:
An Orca capability that replaces an original capability with an acceptable level of authority, durability, recovery, and auditability. Materially weaker guarantees require an explicit decision about whether to strengthen Orca or this project.
_Avoid_: Built-in equivalent, similar UI

**Shippable parity release**:
An independently useful release whose guarantees, limitations, and live end-to-end acceptance evidence are explicit.
_Avoid_: Phase, priority bucket

**Proposed change**:
The exact submitted Git ref and commit set being considered for validation and delivery.
_Avoid_: Current branch, working tree, HEAD

**Decision gate**:
A blocking Orca checkpoint where pipeline execution suspends until an authorized human or delegated agent selects an explicit resolution.
_Avoid_: Pause, prompt, confirmation dialog

**Fix round**:
A single execution of a durable repair worker on the active worktree targeting a specified set of actionable findings, followed by a committed fix and re-verification.
_Avoid_: Patch iteration, retry loop

**Actionable finding**:
A defect, contradiction, test failure, lint error, or review concern that requires an explicit repair, approval, or skip before a stage may pass.
_Avoid_: Bug, warning, issue

**Exhaustion gate**:
A decision gate raised when a stage reaches its configured maximum fix rounds with unresolved actionable findings remaining.
_Avoid_: Timeout, failure cutoff

**Approval**:
A durable human gate decision verifying that flagged findings are acceptable or intentional design choices, satisfying the stage's policy.
_Avoid_: Override, pass-through, ignore

**Waiver**:
An explicit human bypass of a validation stage without verification, recorded in the evidence ledger.
_Avoid_: Skip-pass, exception


