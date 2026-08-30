---
status: accepted
date: 2026-08-30
scope: target architecture
implementation: not implemented
---

# Run TUI Presentation and Control Boundary

The Run TUI runs in the coordinator process rather than as an attachable sidecar. The pipeline emits immutable presentation snapshots to both the interactive TUI and the plain status renderer, avoiding a daemon, socket protocol, or second source of control truth.

## Decision

- The domain ledger remains authoritative for durable domain facts and copies canonical Orca gate facts for evidence. It additionally records semantic milestones such as stage and round boundaries, gate lifecycle, resumable errors, cancellation, and Auto-fix mode changes; each milestone is persisted before a snapshot claims it occurred.
- Raw worker output remains in durable stage logs, but activity previews, elapsed time, cursor position, pane selection, and other presentation state remain transient.
- Controls call the pipeline engine directly. Inline decisions resolve the canonical Orca gate, with the first authorized resolution winning and the ledger retaining its audit.
- When the pipeline declares a resumable error, Resume explicitly starts a new run attempt under the same run identity after the interrupted attempt settles and its attempt-scoped resources are cleaned up. Cancel uses orderly reaping; Force stop records cancellation evidence, durably marks every active stage log incomplete without an exhaustive terminal drain, then exits immediately. Marker-based cleanup preserves those partial artifacts while removing remaining resources, and no retained partial log is presented as complete.
- A TUI initialization failure falls back silently to plain status. A later renderer failure warns once, switches permanently to plain status, and does not fail the pipeline.

## Consequences

The design is small, keeps safety semantics in the coordinator, and lets both renderers share one projection. It deliberately cannot attach a second UI process or recreate the exact prior screen after a crash; adding those capabilities later would require a persisted live model and an IPC contract.
