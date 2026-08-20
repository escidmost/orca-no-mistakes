# orca-no-mistakes

An Orca-native, nine-stage adversarial validation pipeline:

`intent -> rebase -> review -> test -> document -> lint -> push -> pr -> ci`

The coordinator creates an Orca Run and ordered Task DAG. Fresh Claude workers review disposable child worktrees; one retained Codex terminal fixes the current worktree and commits each repair. Human decisions use Orca gates. Structured evidence stays under `~/.orca-no-mistakes/evidence/`, outside the branch.

## Install

Requires Node.js 24+, Git, a running Orca app, and authenticated `claude`, `codex`, and repository-host tooling.

```bash
npm install
npm link
orca-no-mistakes install --repo /path/to/repo --intent "The change's standing intent"
```

The installer creates a local bare gate under the repository's Git directory and configures the `no-mistakes` remote. It never replaces an unrelated remote unless `--force` is supplied. The gate receives the local push, runs the pipeline synchronously, and leaves delivery to `origin` exclusively to the pipeline's push stage.

## Run

Direct invocation:

```bash
orca-no-mistakes run --repo /path/to/repo --intent "Add X without changing Y"
```

Git entry point:

```bash
git push no-mistakes
```

Set a one-off push intent with `ORCA_NO_MISTAKES_INTENT`; otherwise the installer-configured intent is used. Orca automations can invoke the same `run` command. The bundled `skills/no-mistakes/SKILL.md` provides `/no-mistakes` instructions for skill hosts.

The runner requires a clean, committed feature branch and a configured `origin`. Rewrites are delivered with `--force-with-lease`. A failed push, PR, or CI delivery stage can only be retried or stopped; it cannot be approved as successful.

## Development

```bash
npm test
npm run typecheck
```
