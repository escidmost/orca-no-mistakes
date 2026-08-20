## Standards

- **Code reviews** Skip a separate `/code-review`, but run `/ponytail-review` before making commits unless the user explicitly requests another review workflow.
- **Push through no-mistakes** When instructed to push, use `orca-no-mistakes push --intent "<intent for this exact commit set>"`. Do not push unless told to, and do not start a duplicate pipeline while the same proposed change already has an active Orca Run.
- **Post-merge cleanup** When the PR for a Linear issue is merged, remove readiness and process labels such as `ready-for-*` and `wayfinder:*`. PR titles begin with the Linear issue identifier: `ONM-##: <title>`.

## Agent skills

### Issue tracker

Issues are tracked in Linear team `orca no-mistaes` (`ONM`) through `linear-axi`. See `docs/agents/issue-tracker.md`.

### Planning maps

Wayfinder maps and their child tickets are tracked in Linear. Existing `.scratch/` maps are migration artifacts until explicitly published there. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage-role labels unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository: `CONTEXT.md` and `docs/adr/` live at the repository root. See `docs/agents/domain.md`.
