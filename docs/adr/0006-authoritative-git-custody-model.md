# 6. Authoritative Git Custody Model

To restore safety-semantic parity and prevent data loss or split-brain validation, `orca-no-mistakes` establishes an authoritative Git custody model where proposed changes are isolated from active author checkouts, concurrent executions are serialized via domain ledger semantic leases, and custody transitions are verified using deterministic commit checkpoints and three-way containment proof.

## Status

Accepted

## Decision

1. **Custody Object and Ref Isolation**:
   - Proposed changes submitted via `orca-no-mistakes push` or `orca-no-mistakes run` are captured into an immutable submission record in the SQLite domain ledger (`~/.orca-no-mistakes/ledger.db`).
   - The coordinator manages internal Git refs under `refs/no-mistakes/heads/<run_id>` and `refs/no-mistakes/recover/<run_id>`.
   - Worker tasks (diagnostics, linters, tests, and fixers) execute in isolated Orca workspaces checked out at detached commit HEADs without mutating or reading from dirty uncommitted working tree files in the operator's active checkout.
   - Each validation stage and fix round checkpoint records `(stage_id, round, input_commit_oid, output_commit_oid)` in the ledger, guaranteeing tamper-evident commit binding.

2. **Branch Semantic Leases and Concurrency Serialization**:
   - Concurrent runs on the same repository and branch are serialized through exclusive branch semantic leases in `ledger.db`.
   - Each lease carries an active `run_id`, a monotonic generation token, and a heartbeat timestamp.
   - Any new invocation targeting an actively leased branch fails closed immediately unless the active run has terminated, its lease has expired, or the operator explicitly passes `--force-lease`.
   - Generation fencing ensures that stale or orphaned coordinator instances cannot push updates or mutate stage state after a lease is superseded.

3. **Terminal Custody Return and Three-Way Containment Proof**:
   - Upon terminal settlement (`Passed`, `Failed`, or `Cancelled`), the coordinator evaluates a three-way containment proof between:
     1. The initial submission commit OID ($C_{sub}$),
     2. The current operator branch HEAD OID ($C_{op}$), and
     3. The terminal pipeline commit OID ($C_{term}$).
   - **Contained / Fast-Forward Path**: If $C_{op} = C_{sub}$ (the operator has not modified the branch locally while the pipeline ran), the coordinator safely advances the operator's local branch ref to $C_{term}$ upon custody return.
   - **Diverged / Operator Edit Path**: If $C_{op} \neq C_{sub}$ (the operator committed new work during execution), the coordinator will never overwrite or clobber the author's checkout. The pipeline commit is securely anchored at `refs/no-mistakes/recover/<run_id>`, and the operator is provided explicit instructions to reconcile via `orca-no-mistakes axi sync --recover` or standard Git merge/rebase tools.

## Consequences

- The coordinator does not depend on, alter, or lock the author's active working tree during pipeline execution.
- All pipeline-created commits (fixes, auto-rebases) are bound to durable Git refs and ledger checkpoints before advancing stages.
- No operator changes can be silently discarded or overwritten on coordinator restart, cancellation, or failure.
