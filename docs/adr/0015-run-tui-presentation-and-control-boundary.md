---
status: accepted
date: 2026-08-30
scope: target architecture
implementation: partially implemented
---

# Run TUI Presentation and Control Boundary

The Run TUI runs in the coordinator process rather than as an attachable sidecar. The pipeline emits immutable presentation snapshots to both the interactive TUI and the plain status renderer, avoiding a daemon, socket protocol, or second source of control truth. Both renderers write exclusively to stderr, preserving the existing stdout JSON unchanged for direct-attached runs.

## Decision

- The domain ledger remains authoritative for durable domain facts and copies canonical Orca gate facts for evidence. It records the effective Auto-fix mode at run creation and every change, restores the latest value before a resumed suffix begins, and makes later stages use that restored value for the same run identity.
- Both renderers consume one snapshot contract containing the current stage and round, at most one active worker, recent activity, stage-log references or bounded tails with an incomplete indicator, canonical gate state, finding counts by disposition, and available controls. Stage and round boundaries, gate lifecycle, finding decisions, Auto-fix mode changes, resumable errors, cancellation actions, terminal outcomes, and incomplete-log markers are persisted before a snapshot claims the transition occurred.
- Raw worker output remains in durable stage logs, but activity previews, elapsed time, cursor position, pane selection, and other presentation state remain transient.
- Controls call the pipeline engine directly. Inline decisions resolve the canonical Orca gate, with the first authorized resolution winning and the ledger retaining its audit.
- The in-process TUI owns terminal mode only after compatibility checks succeed. It enters raw-input and alternate-screen modes, then restores input mode, cursor, and screen exactly once before normal exit, handled renderer fallback, errors, orderly Cancel completion, or immediate Force stop; it also restores before `SIGTSTP` and re-enters and redraws after `SIGCONT`. Tab and Shift-Tab move between regions, arrows move within a region, Enter acts or opens, Escape returns, `G` reopens an open decision gate from the rail, inside a gate Enter selects a choice and an explicit second Enter confirms its resolution while Escape returns to the rail leaving the gate unanswered and restoring the pinned stage and focus state, `A` toggles the durable Auto-fix mode from the rail and from inside an open gate, `R` — offered only when the error panel shows a resumable error — starts the next attempt of the same run, `C` opens Cancel confirmation, the first Ctrl-C requests orderly Cancel, a second Ctrl-C Force stops, and raw Ctrl-Z suspends the TUI through that same SIGTSTP/SIGCONT restore-and-re-enter contract.
- When the pipeline declares a resumable error, Resume explicitly starts a new run attempt under the same run identity only after the interrupted attempt is durably settled and its attempt-scoped resources are cleaned up.
- Cancel durably records the `Cancel` action, performs orderly reaping, then settles the terminal outcome as `cancelled`. Settlement releases the `(repo_root, branch)` lease before a terminal-status snapshot is published.
- Force stop durably records the `Force stop` action, marks every active stage log incomplete without an exhaustive terminal drain, and transfers ownership of attempt settlement and resource cleanup to marker-based recovery before exiting immediately. That recovery owner preserves partial artifacts, settles the attempt as `cancelled`, releases the `(repo_root, branch)` lease, and removes remaining attempt-scoped resources; Resume remains unavailable until the handoff completes, and no retained partial log is presented as complete.
- A TUI initialization failure falls back silently to plain status. A later renderer failure warns once, switches permanently to plain status, and does not fail the pipeline.

## Consequences

The design is small, keeps safety semantics in the coordinator, and lets both renderers share one projection. It deliberately cannot attach a second UI process or recreate the exact prior screen after a crash; adding those capabilities later would require a persisted live model and an IPC contract.
