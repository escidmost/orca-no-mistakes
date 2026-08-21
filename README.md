# orca-no-mistakes

An Orca-native, nine-stage adversarial validation pipeline:

`intent -> rebase -> review -> test -> document -> lint -> push -> pr -> ci`

The current runner creates an Orca Run and ordered Task DAG. Fresh Claude workers inspect disposable child worktrees; one retained Codex terminal fixes the current worktree and commits each repair. Human decisions use Orca gates. Structured worker reports stay under `~/.orca-no-mistakes/evidence/`, outside the branch.

Successful completion currently means that all nine stages completed under the worker-report model. It does not yet provide the target architecture's commit-bound `Passed` proof, branch leases, crash recovery, trusted-policy execution, or authoritative GitHub delivery verification. See [Current Architecture](docs/current-architecture.md) for implemented behavior and [the ADRs](docs/adr/) for accepted target decisions.

## Install

Requires Node.js 24+, Git, a running Orca app, and authenticated `opencode` and repository-host tooling.

```bash
npm install
npm link
orca-no-mistakes install --repo /path/to/repo
```

The installer creates a local bare gate under the repository's Git directory and configures the `no-mistakes` remote. It never replaces an unrelated remote unless `--force` is supplied. The gate receives the local push, runs the pipeline synchronously, and leaves delivery to `origin` exclusively to the pipeline's push stage.

## Run

Direct invocation returns a meaningful process exit status:

```bash
orca-no-mistakes run --repo /path/to/repo --intent "Add X without changing Y"
```

The Git entry point submits through the installed local gate:

```bash
orca-no-mistakes push --repo /path/to/repo --intent "Add X without changing Y"
```

The runner requires a clean, committed, named feature branch and a configured `origin`. It rebases onto the detected default branch unless `--base` is supplied and delivers rewritten history with `--force-with-lease`.

Useful direct-run options:

```text
--base <branch>
--reviewer-model <model>
--fixer-model <model> --fixer-effort <level>
--max-fix-rounds <count>
```

Workers launch with the `opencode` agent on model `opencode-go/ox-alpha-free` at max reasoning effort by default; the default maximum is three fix rounds. `ORCA_CLI_COMMAND` overrides the Orca executable.

## Gates and outcomes

Validation gates offer `approve`, `fix`, `skip`, or `stop`. Delivery gates (`push`, `pr`, and `ci`) offer only `retry` or `stop`. Resolve pending gates through Orca's native gate interface; the bundled [`/orca-no-mistakes` skill](skills/orca-no-mistakes/SKILL.md) contains the commands.

Direct `run` blocks until completion or failure and prints JSON containing the Orca Run ID and completed stage names. `push` sends the intent as a native Git push option; a plain `git push no-mistakes` is rejected. Git waits for the gate's `post-receive` hook, but hook failure may not become a nonzero push exit, so inspect the Orca Run for the authoritative current-run status.

## Development

```bash
npm test
npm run typecheck
```
