# 1. Coordinator Recovery Model

We persist pipeline state and Git custody in a dedicated SQLite domain ledger while delegating durable worker, task, and gate lifecycle to Orca orchestration. On coordinator restart, the coordinator rebinds the Orca Run with generation fencing, opportunistically adopts healthy in-flight workers (falling back to checkpoint restarts for failed or interrupted fixers), reattaches to durable Orca decision gates, and preserves unpublished pipeline commits under recovery refs with three-way containment proof for custody return. This achieves safety-semantic parity with original no-mistakes without duplicating generic orchestration infrastructure.

## Considered Options

- **Stateless Adapter / Reconstruct on demand**: Querying Orca DB and Git refs without a local ledger proved insufficient to guarantee atomic branch leases and commit-bound stage verification checkpoints.
- **Fenced Invalidate-and-Rerun on all workers**: Discarding all in-flight workers on restart was simpler, but opportunistic adoption leverages Orca's native worker durability to survive coordinator updates and CLI detachments without interrupting long-running test suites.
- **Unconditional branch reset on recovery**: Overwriting working branches on failure or cancellation risks silent data loss; three-way containment proof guarantees operator edits are never dropped.

## Consequences

- The adapter requires a lightweight SQLite domain ledger at `~/.orca-no-mistakes/ledger.db` tracking branch leases, proposed change metadata, stage commit checkpoints, and custody states.
- Orca native `bindRun` generation fencing prevents split-brain execution across multiple coordinator invocations.
- Stranded pipeline commits are anchored to `refs/no-mistakes/recover/<run_id>`, enabling safe recovery via `orca-no-mistakes axi sync --recover`.
