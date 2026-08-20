# Orca's Native Guarantee Boundary

## Executive conclusion

Current Orca is an Orca-native replacement for **durable agent coordination custody**, not for **Git change and delivery custody**. Orca 1.4.185 natively provides durable Run, Task, Dispatch, mailbox, question, decision-gate, worker-lifecycle, and recovery identities with strong fencing around which terminal or Dispatch may act. It does not natively bind those identities to an exact proposed Git change, reserve a branch or worktree for that change, preserve pipeline-authored commits, or prove that the exact delivered commit satisfied local, review, pull-request, and CI policy. Those remain adapter responsibilities if the replacement is to preserve the meaning of **Passed**. [O1][O2][O3][N1][N2]

The safest boundary is therefore:

- **Use Orca directly** for orchestration identity, durable dispatch, mailbox delivery, worker questions, decision-gate mechanics, lifecycle fencing, terminal release, and worker recovery. [O1][O2][O3][O4][O5]
- **Keep in the adapter** the domain ledger for exact proposed-change identity, branch/worktree custody, policy state, delivery evidence, cancellation reconciliation, and the final Passed attestation. [N1][N2][N3][N4][N5]
- **Fix in Orca upstream** generic resource-placement gaps that no adapter can solve cleanly: worktree occupancy leases/conflict rejection, reliable selection of externally created linked worktrees, durable resolver provenance for decision gates, and control-plane durability for AFK direct-SSH orchestration. [O6][O7][O8]

## Scope and authority

This report treats the installed runtime contract as authoritative and source as corroboration:

- `orca status --json` reported a ready runtime at version **1.4.185** with orchestration enabled.
- The version-matched `orca skills get orchestration` contract was inspected for Run, Task, Dispatch, Delivery, worker lifecycle, recovery, placement, and decision-gate semantics. [O1]
- `/Users/host/repo/orca` was inspected at commit `0f26ff4ad83e9ca736f6ad3bae6937cd0cdab7fc`. Its `package.json` identifies `1.4.178-rc.2`, and no `1.4.185` source tag was available locally. Where the checkout and live contract differ, this report relies on the live 1.4.185 contract.
- `/Users/host/repo/no-mistakes` was inspected at commit `975487a344584be16c68ae00ae3abc68235f18a6` only to identify safety-semantic differences relevant to replacement.
- As an empirical placement check, Orca 1.4.185 could not target the requested externally created linked worktree with `worker-start --worktree current` or `--worktree path:<absolute-path>`, even after registering the temporary path and its Git common checkout. Both attempts returned `selector_not_found`. This is evidence for the upstream worktree-discovery gap, not a general claim that Orca cannot use worktrees it created itself. [O6]

## Boundary summary

| Concern | Current Orca guarantee | Relative to no-mistakes | Boundary |
| --- | --- | --- | --- |
| Run ownership | Durable coordinator binding and mailbox-consumer fencing | Materially weaker for exact proposed-change and branch ownership | Orca-native coordination; adapter-owned Git/domain run |
| Worktree isolation | Native worktree creation and explicit worker placement | Materially weaker because isolation and exact commit selection are not dispatch invariants | Adapter policy; upstream occupancy/discovery improvements |
| Dispatch durability | Durable Dispatch authority, idempotent settlement, replayable mail | Stronger and more general than the original process-local executor tracking | Proven Orca-native replacement |
| Decision gates | Durable task-blocking gate with explicit resolution | Mechanism is native; policy, actor, and exact-change binding are weaker | Orca mechanism plus adapter domain record; upstream resolver provenance |
| Cancellation | Exact Dispatch fencing and conservative terminal stop/release | Stronger terminal safety, weaker Git custody and whole-run quiescence | Orca lifecycle plus adapter reconciliation |
| Recovery | Durable identities, replay, adoption, retry lineage, conservative unknown states | Strong orchestration recovery, weaker proposed-change/custody recovery | Orca lifecycle plus adapter domain recovery; upstream direct-SSH durability |
| Locking | SQLite transactions and terminal/pane dispatch exclusion | Materially weaker for repo/branch/worktree exclusion | Adapter semantic locks; upstream generic worktree lease |
| Audit history | Durable generic messages and lifecycle rows | Materially weaker as Passed evidence because records are not commit/policy/delivery bound | Adapter evidence ledger; optional upstream export/provenance improvements |

## 1. Run ownership

### Native Orca guarantee

An Orca Run is a durable coordination namespace and coordinator inbox. Binding a coordinator increments `consumer_generation`, fences an outstanding Delivery, and prevents the superseded mailbox consumer from acknowledging later work. Historical coordinator handles are retained for routing. A Run does not itself schedule workers or own a Git ref; lifecycle authority begins with a Dispatch. [O1][O2]

The source makes the distinction concrete: `runs` stores an objective and coordinator identity but no repository, branch, or commit; `bindRun` changes coordinator authority transactionally; and `requireCurrentConsumer` rejects a stale consumer generation. [O2]

### Difference from no-mistakes

A no-mistakes run is a domain object for an exact proposed change. `InsertRunWithIntent` persists `repo_id`, `branch`, `head_sha`, `base_sha`, `submitted_head_sha`, tool version, and build SHA. `startRunWithIntentSource` serializes creation per repository and branch, cancels the prior active run for that branch, and creates the run before launching its executor. [N1][N3]

Orca's Run ownership is therefore **not** a replacement for the original branch/proposed-change ownership. It answers “which coordinator consumes this orchestration inbox?”, not “which exact commit set is under validation and who owns its branch?” [O2][N1]

### Boundary decision

The adapter must persist a domain run keyed to the exact submitted Git object IDs and link it to Orca Run, Task, and Dispatch IDs. Only that domain run may issue a Passed result. Coordinator generation and Dispatch authority should be accepted as facts from Orca rather than reimplemented. [O1][O2][N1]

## 2. Worktree isolation

### Native Orca guarantee

Orca can create Git worktrees and can start a worker in an explicitly selected worktree. Its normal worktree creation path creates or checks out a branch using `git worktree add`, usually with `--no-track -b <branch> <path> [base]`; the worker-start contract requires the coordinator to choose placement and explicitly says Orca does not schedule workers, infer filesystem conflicts, or make a fresh agent imply a fresh worktree. [O1][O6]

The orchestration schema records `worktree_id` on a worker Dispatch, but it has no uniqueness constraint or lease preventing two active Dispatches from using the same worktree. Dispatch admission excludes concurrent use of the same terminal handle or pane, not the same worktree. [O3]

### Difference from no-mistakes

no-mistakes creates a run-specific disposable path and invokes `git worktree add --detach <path> <exact-head-sha>`. Startup recovery accepts a parked run only if that worktree still exists, its HEAD equals the durable run head, and its Git common directory is the expected gate repository. [N2][N4]

This is materially stronger isolation for validation: the exact proposed change selects the worktree, the worktree does not advance with a branch name, and recovery re-verifies its identity. [N2][N4]

### Boundary decision

The adapter must choose or create one isolated worktree per validation attempt, pin it to the exact proposed commit, verify HEAD and repository identity before every resumed mutation, and refuse conflicting occupants. Orca should continue to own the terminal/Dispatch inside that worktree. [O1][N2][N4]

Two improvements belong upstream in Orca:

1. `worker-start` should support an atomic worktree occupancy lease or reject conflicting active Dispatches unless sharing is explicit. The missing invariant is generic to all agents, not specific to Passed. [O1][O3]
2. Externally created linked worktrees should be discoverable by canonical path and Git common directory. The 1.4.185 `selector_not_found` behavior forced this research task out of supervised orchestration despite a valid linked worktree. [O6]

## 3. Dispatch durability

### Native Orca guarantee

This is the clearest proven native replacement. Orca persists Tasks, Dispatch contexts, worker-start state, effects, residual resources, capabilities, questions, messages, and terminal resources in SQLite. The database uses WAL, `synchronous=NORMAL`, a busy timeout, explicit transactions, and atomic migrations. [O3][O9]

Dispatch creation atomically claims a ready Task and excludes another active Dispatch on the same terminal/pane identity. Worker lifecycle reports carry Task and Dispatch IDs and are rejected when unknown, mismatched, stale, or inactive. A valid `worker_done` transaction settles both the Dispatch and Task, revokes capability, closes questions, promotes dependants on success, and treats an exact duplicate as already settled. [O3][O4]

Coordinator `check` consumes durable FIFO Delivery batches. An outstanding batch is replayed until explicitly acknowledged; coordinator takeover increments the generation and fences the prior batch. Mutation receipts and federation relay uniqueness provide additional idempotency for retried control operations. [O1][O2][O3]

### Difference from no-mistakes

no-mistakes durably records domain run and step state, but its live executor, cancellation function, and completion channel are process-local maps guarded by `RunManager.mu`. After a crash, only a strictly validated parked decision can resume; other active work is failed and reconciled from durable state. [N3][N4]

For generic agent dispatch custody, Orca is stronger and should replace adapter-side worker registries, retry mailboxes, heartbeats, and ad hoc completion protocols. Recreating those mechanisms would weaken safety by introducing two authorities. [O1][O3][O4]

## 4. Decision gates

### Native Orca guarantee

Orca persists a decision gate against a Task. Creating a gate verifies that the requester owns the active Dispatch, refuses to open it while a supervised worker is still active, completes active Dispatch contexts, and blocks the Task. Resolving the gate stores the resolution and returns the Task to ready; pending gates are re-applied as blocked during coordinator reconciliation. The live contract distinguishes these coordinator-managed gates from worker `ask`/coordinator `reply` threads. [O1][O5]

### Difference from no-mistakes

The Orca row contains `task_id`, free-text question, options, status, resolution, and timestamps. It does not record the exact proposed commit, policy step/round, decision class, resolver identity, or evidence that made the option admissible. [O5]

no-mistakes accepts a response only while exactly one known step is awaiting approval and rejects a mismatched step. Crash recovery validates the parked run's exact durable step order, gate status, findings, rounds, reviewed head, and remaining work before resuming; ambiguity fails rather than guessing. Unclassified findings default to human decision. [N4][N5]

### Boundary decision

Use Orca's gate to stop and resume orchestration, but have the adapter persist a domain decision record bound to the exact proposed change, policy step, round, admissible actions, and Orca gate ID. Gate resolution must not itself imply policy approval or Passed. [O5][N4][N5]

Resolver principal and resolution provenance are generic audit facts and are plausible Orca upstream additions. Until then, the adapter should record them at its trust boundary rather than modifying Orca's stored resolution. [O5]

## 5. Cancellation

### Native Orca guarantee

Orca cancellation is deliberately Dispatch-scoped and conservative. `worker-stop` fences capability before stopping the exact supervised terminal and settles only after process stop is proven. Unknown stop outcomes remain `stop_unknown`; `worker-abandon` fences the Dispatch without claiming the process or filesystem stopped; `worker-release` closes a terminal only after re-proving exact Dispatch ownership and otherwise retains or reports pending/unknown. Worktrees, setup terminals, unrelated processes, and unproven terminals are not broadly destroyed. [O1][O7]

This is a strong native replacement for terminal lifecycle safety and should not be wrapped with broad terminal-kill behavior. [O7]

### Difference from no-mistakes

no-mistakes cancellation targets a domain run. `HandleCancel` cancels the run context; the run goroutine later closes the agent, sweeps processes rooted in the run worktree, removes the disposable worktree, clears active maps, and persists terminal run state. Its CLI separately refuses to claim terminal quiescence from a cancellation request alone. [N3]

The original also classifies whether the submitted head remained unchanged or unpublished pipeline commits must stay in gate custody. Orca stop/abandon has no Git-head or branch-custody meaning. [N6]

### Boundary decision

The adapter should request Orca stop or abandon, wait for an authoritative lifecycle result, then reconcile the domain run's worktree, Git refs, and durable head before declaring it cancelled. It must preserve any new commits under an adapter-owned ref and expose a custody-recovery action. Orca remains authoritative about whether the worker terminal was fenced or stopped. [O7][N6]

## 6. Recovery

### Native Orca guarantee

Orca has strong orchestration recovery semantics. Pending Deliveries replay until acknowledgement. Questions remain pending across timeout/disconnect and resume by original message ID. Worker retry requires a proven failed/stopped predecessor and explicit placement. Adoption can preserve the live process, PTY/session, terminal, workspace, Task, and Dispatch; ambiguous liveness, principal, capability, or terminal identity degrades to read-only. Legacy terminal recovery requires a unique worktree, pane, terminal, and process-incarnation match. [O1][O2][O7]

### Difference from no-mistakes

no-mistakes recovery is narrower but domain-aware. It resumes only a fully consistent parked gate. All other stale active runs are failed transactionally along with in-progress steps, while parked duration is preserved. Branch recovery anchors preserved pipeline commits, verifies current refs and worktree cleanliness, uses compare-and-swap for gate updates, and records custody only after the final Git state is proven. [N4][N6]

Orca recovery does not prove which Git commit an agent produced, whether a worktree still represents the proposed change, or whether validation may safely continue. Those checks are materially outside its current model. [O3][N4][N6]

### Boundary decision

The adapter must reconcile its domain ledger against Orca Run/Task/Dispatch state and Git state after restart. Unknown or inconsistent combinations must fail closed, preserve reachable commits, and require a fresh validation attempt rather than converting liveness into Passed. Orca's recovery IDs and read-only degradation should be reused directly. [O1][O7][N4][N6]

For direct SSH, Orca's orchestration control plane is client-resident: remote `orca` commands fail while the owning client is disconnected even though the PTY may remain live, and only a bounded transcript tail is replayed. AFK work that must keep coordinating should use the peer/headless-runtime model today. Making direct-SSH orchestration host-resident or otherwise continuously available is an Orca upstream concern, not an adapter workaround. [O8]

## 7. Locking

### Native Orca guarantee

Orca provides database serialization and narrow resource exclusion: SQLite `BEGIN IMMEDIATE` transactions, one outstanding Delivery per Run, idempotency keys for mutations, and no second active Dispatch on the same terminal/pane identity. The schema has no unique active lease on `worktree_id`, repository, branch, or proposed change. [O2][O3][O9]

### Difference from no-mistakes

no-mistakes acquires a process-lifetime exclusive OS lock per `NM_HOME` before database opening, stale-run recovery, orphan cleanup, and socket binding. Within that single daemon, `startRunWithIntentSource` serializes by repository and branch so concurrent pushes cannot create competing runs. Git custody recovery also uses expected-old-object compare-and-swap and re-checks branch, HEAD, and cleanliness immediately before mutation. [N3][N6][N7]

The original therefore has materially stronger exclusion over the domain resources that determine delivery safety. Orca's SQLite locks protect orchestration rows, not Git ownership. [O9][N3][N7]

### Boundary decision

The adapter must own an atomic semantic lease keyed by repository plus branch or exact proposed-change identity and must re-validate Git object IDs at mutation time. A process-global singleton is not necessarily required, but equivalent exclusion and crash-expiry semantics are. [N3][N7]

A generic active-worktree lease belongs upstream in Orca because worker placement already records `worktree_id`; branch and delivery locks remain adapter policy because Orca cannot know their domain meaning. [O3]

## 8. Audit history

### Native Orca guarantee

Orca durably stores ordered messages, Delivery acknowledgements, Tasks and results, Dispatch attempts and failure counts, gate resolutions, worker-start effects/residual resources, terminal ownership transfers, and terminal output archives. These records are valuable orchestration history and should be referenced by ID from adapter evidence. [O2][O3][O4][O5]

The records are operational state, not a Passed attestation. A Run has no commit or policy identity; Task results are free-form strings; gate resolution lacks resolver identity; terminal archives are retained during release; and the supported recovery command `orca orchestration reset` can destructively clear selected orchestration state. [O1][O2][O5]

### Difference from no-mistakes

no-mistakes records the exact submitted/current/review-approved/pushed commit identities, tool version and build, push target fingerprint/ref/generation, PR/CI state, step results and rounds, findings, parked time, terminal-head verification, and custody return. Its product contract requires inspectable evidence attached to the change without contaminating the delivered branch. [N1][N8]

Orca's history is therefore useful provenance but materially insufficient to justify Passed. The missing information is domain evidence, not more worker transcript. [O2][N1][N8]

### Boundary decision

The adapter must emit one durable evidence record for each proposed change and final delivered commit. It should reference Orca Run, Task, Dispatch, gate, message, and archive IDs rather than copy their lifecycle implementation. The record must include policy inputs, exact Git object IDs, decisions, local/review/PR/CI outcomes, delivery target, and the authority that observed each fact. [O2][N1][N8]

Generic export, retention policy, and resolver-principal fields would improve Orca upstream, but an Orca audit export must still not be treated as Passed without the adapter's commit- and policy-bound proof. [O2][O5]

## Recommended ownership

### Proven Orca-native replacement

- Run mailbox ownership and coordinator-generation fencing. [O2]
- Durable Task and Dispatch identity, retry lineage, capability fencing, failure counting, and exact worker settlement. [O3][O4]
- FIFO coordinator Delivery replay and explicit acknowledgement. [O2]
- Durable worker questions and replies. [O1]
- Decision-gate blocking and resumption mechanics. [O5]
- Exact terminal stop, abandon, retain, transfer, release, and conservative unknown outcomes. [O7]
- Live-worker adoption and identity-based recovery where authority can be proven. [O7]

### Adapter responsibility

- Exact proposed-change identity and the definition of Passed. [N1][N8]
- Repository/branch semantic leases and delivery compare-and-swap. [N3][N6][N7]
- One isolated, exact-commit worktree per validation attempt, including resumed verification. [N2][N4]
- Mapping policy steps and human decisions to Orca Tasks and gates. [O5][N4][N5]
- Cancellation and restart reconciliation of Git heads, refs, worktrees, and custody. [N4][N6]
- Durable local/review/PR/CI/delivery evidence bound to the exact delivered commit. [N1][N8]

### Plausible Orca upstream changes

1. Add an atomic worktree occupancy lease to worker start, with explicit opt-in sharing. [O1][O3]
2. Resolve external linked worktrees reliably by canonical path and Git common directory. [O6]
3. Record decision-gate resolver principal and resolution provenance. [O5]
4. Provide a stable orchestration audit export/retention surface that survives ordinary lifecycle cleanup. [O2][O3]
5. Make AFK direct-SSH orchestration control-plane availability explicit and durable, or fail early by requiring a peer/headless runtime for work that depends on remote `orca` calls while disconnected. [O8]

## Consequence for the parity roadmap

Do not recreate no-mistakes' executor or terminal manager in the adapter. The smallest safety-semantic design is a thin, durable Git/policy ledger around Orca orchestration:

1. Admit an exact proposed change and acquire its semantic lease.
2. Create and verify its isolated worktree.
3. Create an Orca Run and Tasks, storing all cross-identifiers in the domain ledger.
4. Let Orca own Dispatch, communication, gates, cancellation fencing, and worker recovery.
5. Reconcile every Orca lifecycle outcome back into exact Git and policy state.
6. Publish Passed only from commit-bound evidence after delivery state is proven.

That division preserves Orca's stronger generic orchestration guarantees without pretending they prove a Git delivery outcome they do not model. [O1][O3][N1][N8]

## Sources

### Orca 1.4.185 runtime contract

- **[O1]** Installed runtime `orca status --json` and version-matched `orca skills get orchestration`, especially “Core Model”, “Durability and Delivery”, “Dispatch”, “Worker lifecycle”, “Decision gates”, “Recovery and retained work”, and “Placement”. The contract states that Runs are durable namespaces rather than schedulers; Dispatches hold lifecycle authority; state and Delivery batches are durable; worker lifecycle is Dispatch-scoped; and Orca does not schedule workers, infer conflicts, or choose placement.
- **[O2]** `/Users/host/repo/orca/src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts:createCoreTablesSql`; `/Users/host/repo/orca/src/main/runtime/orchestration/db/runs/run-binding.ts:bindRun`; `/Users/host/repo/orca/src/main/runtime/orchestration/db/runs/run-delivery.ts:getOrCreateRunDelivery,acknowledgeRunDelivery,requireCurrentConsumer`; `/Users/host/repo/orca/src/main/runtime/orchestration/db/runs/run-lookup.ts:fenceOutstandingDelivery`.
- **[O3]** `/Users/host/repo/orca/src/main/runtime/orchestration/db/schema/create-graph-tables-sql.ts:createGraphTablesSql`; `/Users/host/repo/orca/src/main/runtime/orchestration/db/dispatch-context/dispatch-context-store.ts:createDispatchContext,DISPATCH_CONTEXT_CLAIM_SQL`; `/Users/host/repo/orca/src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-outcome.ts:markWorkerDispatchReady,failWorkerStart,markWorkerStartUnknown`; `/Users/host/repo/orca/src/main/runtime/orchestration/db/attach-orchestration-db-methods.ts:attachOrchestrationDbMethods`.
- **[O4]** `/Users/host/repo/orca/src/main/runtime/orchestration/db/dispatch-context/worker-report-settlement.ts:settleWorkerReport,settleWorkerReportInTransaction`; `/Users/host/repo/orca/src/cli/handlers/orchestration-worker-settlement.ts:requireWorkerDoneSettlement,isExactWorkerReport`.
- **[O5]** `/Users/host/repo/orca/src/main/runtime/orchestration/db/decision-gates/decision-gate-store.ts:createGate,resolveGate`; `/Users/host/repo/orca/src/main/runtime/orchestration/coordinator-decision-gates.ts:openDecisionGateFromMessage,reblockTasksWithPendingGates`.
- **[O6]** `/Users/host/repo/orca/src/main/git/worktree.ts:addWorktree,performAddWorktree`; installed 1.4.185 `orca orchestration worker-start` selector behavior observed in this research Run `run_0e9fd225195d`, Tasks `task_68f6ecc06162` and `task_895014576d79` (both remained ready and undispatched after `selector_not_found`).
- **[O7]** `/Users/host/repo/orca/src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-stop.ts:beginWorkerStop,settleWorkerStop`; `/Users/host/repo/orca/src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-abandon.ts:abandonWorkerDispatch`; `/Users/host/repo/orca/src/main/runtime/orchestration/orchestration-legacy-worker-terminal-recovery.ts:planLegacyWorkerTerminalRecovery`; `/Users/host/repo/orca/src/main/runtime/rpc/methods/orchestration-worker-release-completion.ts:completeWorkerTerminalRelease`.
- **[O8]** `/Users/host/repo/orca/docs/reference/ssh-execution-boundary.md`, especially “Control plane”, “Distinguishing `unverifiable` from `exited`”, and “One host, one model”.
- **[O9]** `/Users/host/repo/orca/src/main/runtime/orchestration/db/orchestration-db.ts:OrchestrationDbCore.constructor`; `/Users/host/repo/orca/src/main/runtime/orchestration/db/schema/migrate.ts:migrate`.

### no-mistakes comparison

- **[N1]** `/Users/host/repo/no-mistakes/internal/db/run.go:InsertRunWithIntent,SetRunPushActive,UpdateRunReviewApprovedHeadSHA`; `/Users/host/repo/no-mistakes/internal/db/schema.go:schemaSQL`; `/Users/host/repo/no-mistakes/internal/ipc/protocol.go:RunInfo`.
- **[N2]** `/Users/host/repo/no-mistakes/internal/daemon/manager.go:startRunWithIntentSource`; `/Users/host/repo/no-mistakes/internal/git/git.go:WorktreeAdd,WorktreeRemove`.
- **[N3]** `/Users/host/repo/no-mistakes/internal/daemon/manager.go:RunManager,startRunWithIntentSource,HandleCancel`; `/Users/host/repo/no-mistakes/internal/daemon/daemon.go:Run`.
- **[N4]** `/Users/host/repo/no-mistakes/internal/daemon/manager.go:recoverableParkedRuns,prepareRecoveredRun`; `/Users/host/repo/no-mistakes/internal/pipeline/executor.go:ValidateRecoveredRun,Resume,recoveredGate`; `/Users/host/repo/no-mistakes/internal/db/run.go:RecoverStaleRunsExcept`.
- **[N5]** `/Users/host/repo/no-mistakes/internal/pipeline/executor.go:RespondWithOverrides`; `/Users/host/repo/no-mistakes/internal/types/findings.go:Finding.ActionOrDefault`.
- **[N6]** `/Users/host/repo/no-mistakes/internal/branchsync/sync.go:Recover,recoverKeepLocal,recoverFastForward,classifyPipelineOwned,releasedSubmittedHeadRun`; `/Users/host/repo/no-mistakes/skills/no-mistakes/SKILL.md`, branch-custody guidance at lines 236-247.
- **[N7]** `/Users/host/repo/no-mistakes/internal/daemon/lock.go:acquireSingletonLock`; `/Users/host/repo/no-mistakes/internal/daemon/daemon.go:Run`; `/Users/host/repo/no-mistakes/internal/branchsync/sync.go:duplicateBranchCheckout,recoverKeepLocal,recoverFastForward`.
- **[N8]** `/Users/host/repo/no-mistakes/VISION.md`, “Never lose work”, “Independent, adversarial validation”, and “Evidence over confidence”; `/Users/host/repo/no-mistakes/internal/db/schema.go:schemaSQL`.
