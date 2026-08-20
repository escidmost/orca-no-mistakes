# orca-no-mistakes

An Orca-native, nine-stage adversarial validation pipeline:

`intent -> rebase -> review -> test -> document -> lint -> push -> pr -> ci`

The coordinator creates an Orca Run and ordered Task DAG. Fresh Claude workers review disposable child worktrees; one retained Codex terminal fixes the current worktree and commits each repair. Human decisions use Orca gates. Structured evidence stays under `~/.orca-no-mistakes/evidence/`, outside the branch.

## Install

Requires Node.js 24+, Git, a running Orca app, and authenticated `claude`, `codex`, and repository-host tooling.

```bash
npm install
npm link
orca-no-mistakes install --repo /path/to/repo
```

The installer creates a local bare gate under the repository's Git directory and configures the `no-mistakes` remote. It never replaces an unrelated remote unless `--force` is supplied. The gate receives the local push, runs the pipeline synchronously, and leaves delivery to `origin` exclusively to the pipeline's push stage.

## Run

Direct invocation:

```bash
orca-no-mistakes run --repo /path/to/repo --intent "Add X without changing Y"
```

Git entry point:

```bash
orca-no-mistakes push --repo /path/to/repo --intent "Add X without changing Y"
```

The push command sends the intent as a native Git push option. Intent is never stored in repository config or passed through the shell environment, and a plain `git push no-mistakes` is rejected. Git waits for the gate's `post-receive` pipeline, but it does not turn a pipeline failure into a nonzero push exit; check the Orca Run for the outcome. Use `/no-mistakes` or direct `run` when the caller needs the pipeline's exit status. Orca automations can invoke the same `run` command. The bundled `skills/no-mistakes/SKILL.md` provides `/no-mistakes` instructions for skill hosts.

The runner requires a clean, committed feature branch and a configured `origin`. Rewrites are delivered with `--force-with-lease`. A failed push, PR, or CI delivery stage can only be retried or stopped; it cannot be approved as successful.

## Development

```bash
npm test
npm run typecheck
```
