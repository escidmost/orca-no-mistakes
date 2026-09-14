# Workflow guide

These maps describe the current implementation. Download the HTML files or open them from your checkout in a browser; GitHub's file viewer shows their source. Each HTML is self-contained, starts with motion off, and includes light/dark themes, zoom, search, and node inspection.

## From committed change to merged PR

[Open the pipeline diagram](run-to-merge.html) · [Editable specification](run-to-merge.workflow.json)

Follow the nine numbered stages from left to right. The lanes distinguish coordinator operations from worker evaluations. The coordinator records `intent`; it appears in the worker lane only for layout. The `pr` stage combines a worker-drafted title and summary with coordinator-owned publication and receipt settlement.

Before this flow, initialize the repository's publication route and submit a clean feature-branch commit with intent. Both direct `run` and local-gate admission launch the same isolated pipeline. Trusted-base command gates can extend the local stages before publication.

The `pr` notification means the PR is ready. The `ci` stage continues until it observes the exact matching merged PR. An external operator handles failed checks, conflicts, and merge; the pipeline records the resulting facts. Completion includes custody return and an unsigned, tamper-evident attestation. It does not establish required-check completeness or delivered-tree integrity.

Sources: [stage order](../../scripts/config.ts), [pipeline coordinator](../../scripts/orca-no-mistakes.ts), [CI monitor](../../scripts/ci.ts), and [orchestration contract](../current-architecture.md#orchestration).

## Findings and repairs

```text
Check candidate -> classify report
  No actionable findings -> settle stage with evidence
  Eligible automatic repair -> fixer -> custody checks -> check again
  Decision needed -> finding gate
    fix          -> fixer -> custody checks -> check again
    approve/skip -> record the decision and settle the stage
    stop         -> cancel the run and preserve recovery work
```

Automatic repair requires enabled Auto-fix, only `auto-fix` findings, remaining rounds, and stage policy that permits it. Review repairs require the trusted-policy `allow_review_autofix` opt-in. An `ask-user` finding, blocked automation, or exhausted rounds opens the finding gate. Human decision waits have no deadline.

`fix` without IDs targets all actionable findings. Selecting IDs approves the other open findings for that candidate; it does not defer them. A repair must produce a clean, tree-changing commit, pass the applicable policy and exact-commit custody checks, then face fresh evaluation. A changed candidate invalidates candidate-bound approvals. No-change repairs and strict-policy rejections require further decisions.

Other gates have different meanings:

- **CI:** `fix` resumes monitoring after external action; it never dispatches a CI fixer.
- **Rebase conflict:** resolve it externally, then choose `fix` to retry rebase.
- **Failed command gate:** `fix` authorizes the fixer path and reruns the required command; approval cannot certify a failed command.
- **Worker question:** send `reply: <actual answer>` or `stop`.

For detached runs, respond through the exact authenticated `orca orchestration send` command in the notification.

Sources: [finding and gate behavior](../current-architecture.md#findings-and-gates) and the [coordinator's finding loop](../../scripts/orca-no-mistakes.ts).

The [interactive finding-loop source](findings-and-fixes.workflow.json) remains an unpublished draft. After a further authorized layout pass, validation still reports `workflow/explicit-pin-conflict`: `clean-report-settles` shares a route corridor with `choice-authorizes-fix`. There is no accepted HTML for this draft; use the text walkthrough above.

## Failure recovery and custody return

[Open the recovery diagram](recovery-and-custody.html) · [Editable specification](recovery-and-custody.workflow.json)

The upper path starts with a durably failed run that has a checkpoint. `run --resume <run-id>` reconstructs the isolated worktree, reacquires the lease, and continues the frozen plan with only still-valid evidence. The run ID and evidence history stay the same. Eligible settled failures can also offer Resume in the active TUI.

After successful execution, anchor the terminal commit at `refs/no-mistakes/recover/<run-id>` before custody transfer. A clean initiating checkout still at the submitted commit can advance. A dirty or diverged checkout remains intact, with recovery instructions returned to the operator.

The disconnected crash-cleanup path is deliberate: `prune --stranded` proves coordinator death and resource ownership before preserving work, reaping owned resources, and releasing the lease. It does not automatically adopt or resume an abandoned `in-progress` run. Run it before `abandon` whenever a direct-run or gate marker remains; abandonment refuses marker-owned resources because closing ledger ownership first would prevent safe cleanup. Then use `abandon --run-id <id> --reason <text>` only if dead local `in-progress` or resumable-failed ledger state still blocks publication-route changes. A resume claim records the successor coordinator before activation and proves ownership until its new attempt starts, so interruption on either side of activation can be closed only when that PID is absent and the claim, lease, and attempt generation agree. Uncertain, legacy, stale, or mismatched ownership retains resources; direct-run cleanup leaves the operator's checkout intact.

Sources: [resume behavior](../current-architecture.md#orchestration), [custody return](../current-architecture.md#custody-return), and [stranded cleanup](../../README.md#attestations-and-retention).

## Editing and verification

Edit the `.workflow.json` sources, then generate the HTML with an installed Archify skill. `ARCHIFY_HOME` below is the skill's installation directory; run these commands from the repository root. The workflow schema number describes the diagram format, not an application release.

```bash
node "$ARCHIFY_HOME/bin/archify.mjs" validate workflow docs/workflows/run-to-merge.workflow.json --quality showcase --json
node "$ARCHIFY_HOME/bin/archify.mjs" deliver workflow docs/workflows/run-to-merge.workflow.json docs/workflows/run-to-merge.html --quality showcase --json
node "$ARCHIFY_HOME/bin/archify.mjs" visual-check docs/workflows/run-to-merge.html --json
```

Use the recovery file names for the second diagram. Unlabeled arrows express the next step already identified by their endpoints; decision and notification edges retain their meaningful labels. Keep the accepted HTML generated from its source rather than editing the embedded viewer.

Browser screenshots and detailed receipts are local `*.visual-check.*` sidecars, excluded from Git. Deterministic delivery, browser measurements, and image-based visual review are separate checks; the [delivery record](delivery.json) binds their reported results to the source and HTML hashes.
