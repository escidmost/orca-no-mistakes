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

**Branch semantic lease**:
An exclusive lock on a repository and branch held by an active validation run to prevent concurrent or interleaved pipeline executions on the same branch.
_Avoid_: Git lock, branch mutex, run lock

**Attestation manifest**:
An unforgeable, commit-bound record of stage executions, reviewer findings, human gate resolutions, and forge proofs justifying a Passed outcome.
_Avoid_: Run summary, pipeline report, output log

**Custody recovery**:
The safe reconciliation and return of branch ownership from the validation pipeline to the author's working branch after cancellation, failure, or divergence, anchoring pre-recovery states under dedicated ref namespaces.
_Avoid_: Git reset, branch sync, force pull
