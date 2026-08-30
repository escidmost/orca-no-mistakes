---
status: accepted
date: 2026-08-30
scope: target architecture
implementation: not implemented
---

# Run TUI Presentation and Control Boundary

The Run TUI runs in the coordinator process rather than as an attachable sidecar. The pipeline emits immutable presentation snapshots to both the interactive TUI and the plain status renderer, avoiding a daemon, socket protocol, or second source of control truth. Both renderers write exclusively to stderr, preserving the existing stdout JSON unchanged for direct attached runs.

## Decision

- The domain ledger remains authoritative for durable domain facts and copies canonical Orca gate facts for evidence. It additionally records semantic milestones such as stage and round boundaries, gate lifecycle, resumable errors, cancellation, and Auto-fix mode changes; each milestone is persisted before a snapshot claims it occurred.
- Raw worker output remains in durable stage logs, but activity previews, elapsed time, cursor position, pane selection, and other presentation state remain transient.
- Controls call the pipeline engine directly. Inline decisions resolve the canonical Orca gate, with the first authorized resolution winning and the ledger retaining its audit.
- When the pipeline declares a resumable error, Resume explicitly starts a new run attempt under the same run identity only after the interrupted attempt is durably settled and its attempt-scoped resources are cleaned up.
- Cancel durably records the `Cancel` action, performs orderly reaping, then settles the terminal outcome as `cancelled`. Settlement releases the `(repo_root, branch)` lease before a terminal-status snapshot is published.
- Force stop durably records the `Force stop` action, marks every active stage log incomplete without an exhaustive terminal drain, and transfers ownership of attempt settlement and resource cleanup to marker-based recovery before exiting immediately. That recovery owner preserves partial artifacts, settles the attempt as `cancelled`, releases the `(repo_root, branch)` lease, and removes remaining attempt-scoped resources; Resume remains unavailable until the handoff completes, and no retained partial log is presented as complete.
- A TUI initialization failure falls back silently to plain status. A later renderer failure warns once, switches permanently to plain status, and does not fail the pipeline.

## Consequences

The design is small, keeps safety semantics in the coordinator, and lets both renderers share one projection. It deliberately cannot attach a second UI process or recreate the exact prior screen after a crash; adding those capabilities later would require a persisted live model and an IPC contract.
