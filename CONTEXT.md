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

**Semantic lease**:
An exclusive reservation acquired on a Git ref or workspace preventing concurrent pipeline validation runs.
_Avoid_: Mutex, worktree lock, workspace lease

**Preserved head**:
A Git ref anchoring unmerged pipeline or auto-fix commits after a run terminates, enabling deterministic recovery.
_Avoid_: Orphan commit, lost commit, backup branch

**Validation ledger**:
The authoritative local store recording runs, tasks, gate decisions, actor provenance, and Passed attestations.
_Avoid_: Audit log, database cache, status table
