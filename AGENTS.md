## Standards

- **Code reviews** Skip a separate `/code-review`. Run `/ponytail-review` before committing when that external skill is installed; otherwise perform the same minimality review over the diff and report the missing prerequisite.
- **Push through no-mistakes** When instructed to push, use `orca-no-mistakes push --intent "<intent for this exact commit set>"`. Do not push unless told to. The current CLI has no branch lease or duplicate-run guard, so inspect `orca orchestration run-list --json` and the Orca Runs view before starting; do not start another run for the same repository, branch, and HEAD.
- **Post-merge cleanup** When the PR for a Linear issue is merged, remove any readiness and process labels present, such as `ready-for-*` and `wayfinder:*`. PR titles begin with the Linear issue identifier: `ONM-##: <title>`.

When asking question, please use your elicitation tool instead of putting them in a chat response.

## Agent skills

### Issue tracker

Issues are tracked in Linear team `orca no-mistaes` (`ONM`) through `linear-axi`. See `docs/agents/issue-tracker.md`.

### Planning maps

Wayfinder maps and their child tickets are tracked in Linear. Existing `.scratch/` maps are migration artifacts until explicitly published there. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage-role labels unchanged. They are repository setup prerequisites and may need provisioning in Linear before the workflow can run. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository: `CONTEXT.md` and `docs/adr/` live at the repository root. See `docs/agents/domain.md`.
