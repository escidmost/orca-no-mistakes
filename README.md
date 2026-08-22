# orca-no-mistakes

An Orca-native, six-stage local adversarial validation pipeline:

`intent -> rebase -> review -> test -> document -> lint`

The current runner creates an Orca Run, acquires an exclusive semantic lease on the branch in a SQLite domain ledger (`~/.orca-no-mistakes/ledger.db`), compiles its validation policy from the trusted base commit, and drives fresh reviewer workers over disposable child worktrees while one retained fixer terminal repairs the current worktree. The worker agent for each stage and role comes from the resolved validation policy configuration. Human decisions use Orca gates; every approval or skip is recorded as an audit row and bound into the final attestation. Stage evidence (reports, logs, exit codes, content hashes) lands under `~/.orca-no-mistakes/artifacts/<run-id>/`, outside the branch. Release 1 is deliberately local-only: it excludes remote `push`, `pr`, and `ci` stages and terminates with a signed-off **Passed Attestation** instead of a push.

Successful completion means all six stages completed with a tamper-evident Merkle attestation binding stage evidence to the exact candidate commit, base commit, policy hash, and declared intent. Remote delivery verification, crash resumption, and forge adapters remain future releases. See [Current Architecture](docs/current-architecture.md) for implemented behavior and [the ADRs](docs/adr/) for accepted target decisions.

## Install

Requires Node.js 24+, Git, a running Orca app, and authenticated CLI tooling for the configured worker agents (`opencode` by default).

```bash
npm install
npm link
```

During installation, a default configuration template is automatically copied to `~/.config/orca-no-mistakes/config.yaml` (from [`templates/config.yaml`](templates/config.yaml)) if no configuration exists.


## Run

Direct invocation returns a meaningful process exit status:

```bash
orca-no-mistakes run --repo /path/to/repo --intent "Add X without changing Y"
```

The runner requires an explicit single-line `--intent`, a clean committed named feature branch, refuses the default base branch, and requires a configured `origin`. It rebases onto the detected default branch unless `--base` is supplied.

Useful direct-run options:

```text
--base <branch>
--head <sha>            refuse to run unless HEAD matches
--force-lease           reclaim a branch lease held by another run
--reviewer-model <model>
--fixer-model <model> --fixer-effort <level>
--max-fix-rounds <count>
--allow-local-config
--config <path>
```

Validation policy comes from `.orca/no-mistakes.yaml` on the trusted base ref, not from the proposed branch; an absent file means built-in defaults. It selects the worker agent per stage and role across native (`claude`, `codex`, `cursor`), terminal (`opencode`, `grok`, `gemini`), and `acp:<target>` harnesses. `--allow-local-config` and `--config <path>` read policy locally instead and mark the run uncertified.

Workers launch with the `opencode` agent on the agent's own default model by default; the default maximum is three fix rounds. `ORCA_CLI_COMMAND` overrides the Orca executable, and `WORKER_AGENT_READY_TIMEOUT_MS` overrides the 60-second agent-startup deadline.

## Attestations and retention

```bash
orca-no-mistakes attestation export <run-id-or-commit-sha> [--out manifest.json]
orca-no-mistakes attestation verify <manifest-file|run-id|commit-sha>
orca-no-mistakes prune [--before <date>] [--repo <name-substring>]
```

`verify` recomputes every stage-evidence hash, rebuilds the Merkle root, and cross-checks the intent hash — any tampering fails loudly. Evidence is retained indefinitely until you explicitly `prune` it.

## Gates and outcomes

Decision gates offer `approve`, `fix [ids][: guidance]`, `skip`, or `stop`; unknown resolutions fail closed. Resolve pending gates through Orca's native gate interface; the bundled [`/orca-no-mistakes` skill](skills/orca-no-mistakes/SKILL.md) contains the commands.

A direct `run` blocks until completion or failure and prints JSON containing the Orca Run ID, completed stages, custody note, and the full attestation manifest. On success the coordinator anchors `refs/no-mistakes/recover/<run-id>` at the terminal commit before returning custody of the branch.

## Development

```bash
npm test
npm run typecheck
```

GitHub Actions runs both on every pull request and on pushes to `main`.
