## Standards

- **Code reviews** Skip a separate `/code-review` but run `/ponytail-review` before making commits
- **Push through orca-no-mistakes.** When told to push, run the gate through the worktree-local `./bin/orca-no-mistakes`; this package executes its TypeScript directly, so that executable is the worktree build. Do not push unless told to.
- **Dogfood repairs.** If `orca-no-mistakes` fails because of its own behavior, diagnose and fix the root cause in the current worktree, verify and commit the repair, then run every later attempt through `./bin/orca-no-mistakes` so it includes the repair. Continue through a passing gate rather than bypassing it or patching Orca.
- **Detached gates.** After starting a detached `orca-no-mistakes` run, return to chat. Do not wait on, read, or poll its terminal; Orca delivers failures and questions here, and a blocking terminal prevents those messages from being handled.
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
