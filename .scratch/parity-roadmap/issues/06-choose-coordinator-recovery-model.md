# Choose the Coordinator Recovery Model

Linear: [ONM-3](https://linear.app/escidmore/issue/ONM-3/choose-the-coordinator-recovery-model)

Type: grilling
Status: resolved
Blocked by: 02, 05

## Question

Which pipeline state must survive coordinator death, how should Orca resume or reconcile workers and gates, and how are pipeline-created commits recovered or synchronized after cancellation and failure?

## Answer

Pipeline state and Git custody are persisted in a dedicated SQLite domain ledger (`~/.orca-no-mistakes/ledger.db`), tracking branch semantic leases, proposed change metadata, stage commit checkpoints, and custody states, while delegating durable worker, task, and gate lifecycle to Orca orchestration.

On coordinator restart, the coordinator rebinds the Orca Run with monotonic generation fencing, opportunistically adopts healthy in-flight workers (falling back to clean commit-checkpoint restarts if a worker died or a fixer crashed mid-edit), reattaches to durable Orca decision gates, and preserves unpublished pipeline commits under `refs/no-mistakes/recover/<run_id>`. Branch custody return employs three-way containment proof to safely auto-adopt rebased/fixed commits without ever dropping operator changes.

Decision context: ADR `docs/adr/0001-coordinator-recovery-model.md`.
