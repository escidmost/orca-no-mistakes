## Standards

- **Code reviews** Skip a separate `/code-review` but run `/ponytail-review` before making commits
- **Push through no-mistakes.* When it's time to push, push through no-mistakes unless otherwise instructed. Don't push unless told to. If there's a current no-mistakes run, you can attach to it with `no-mistakes axi run`, with or without the original `--intent`. Do not poll with status/sleep loops or start another run. When starting a new run, use --intent like normal to start new runs.
- **Post-merge cleanup** When the PR for a Linear issue is merged, remove any labels from the issue that indicate readiness or process (ready-for-\*, wayfinder:\*). Make sure that the PR begins with the Linear issue number ($TeamSlug-##: $title).
- **Keep example config updated.** When new features are added that have config options, be sure to add them and their default values to templates/config.yaml

## No-mistakes findings 

For each finding, verify the claim against the code at the cited location before judging it. Trace the concrete sequence it describes; do not accept it because it sounds plausible or reject it because it sounds pedantic. Some findings will be wrong or overstated.

Per finding, state your judgment in 1-3 sentences — one of:
- confirmed, should change -> fix
- confirmed, but acceptable as-is / deliberate design (say why) -> approve
- not confirmed in the code (cite what disproves it) -> approve
- design question rather than a bug: decide it on the merits as the author would, then fix or approve accordingly

Respond to no-mistakes with your verdict

When asking questions, please use your elicitation tool instead of putting them in a chat response.

## Agent skills

### Issue tracker

Issues are tracked in Linear team `orca no-mistaes` (`ONM`) through `linear-axi`. See `docs/agents/issue-tracker.md`.

### Planning maps

Wayfinder maps and their child tickets are tracked in Linear. Existing `.scratch/` maps are migration artifacts until explicitly published there. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage-role labels unchanged. They are repository setup prerequisites and may need provisioning in Linear before the workflow can run. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository: `CONTEXT.md` and `docs/adr/` live at the repository root. See `docs/agents/domain.md`.
