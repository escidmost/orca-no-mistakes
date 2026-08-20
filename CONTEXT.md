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

**Domain ledger**:
A durable local store tracking proposed change identity, branch semantic leases, commit-bound stage checkpoints, and custody states across coordinator restarts.
_Avoid_: Run cache, coordinator DB, session store

**Branch custody**:
Ownership of the proposed change Git branch and worktree, transitioning between operator-owned, pipeline-owned, and custody-returned.
_Avoid_: Git lock, branch checkout, working branch state

**Custody recovery**:
Returning custody of unpublished pipeline commits or rebased heads from a terminal run to the operator using three-way containment proof and recovery anchor refs.
_Avoid_: Force checkout, branch overwrite, git restore

**Reconciliation snapshot**:
An immutable record of pull-request, candidate commit, and check-run facts queried directly against exact forge and Git object identifiers.
_Avoid_: Status poll, PR fetch, API cache

**Guarded delivery transition**:
An atomic forge transition executed with non-bypass credentials that fails closed if the candidate head or target branch changes.
_Avoid_: PR merge, auto-merge, push-on-green

**Dual-anchored check completeness**:
The proof that all intended CI checks ran, established by matching observed check runs against both a trusted repository policy manifest and forge branch rulesets.
_Avoid_: All green, CI complete, checks passed

**Delivered tree integrity**:
The post-delivery proof confirming that the commit on the target base branch preserves the exact tree and ancestry of the tested candidate change.
_Avoid_: Merged cleanly, landed successfully
