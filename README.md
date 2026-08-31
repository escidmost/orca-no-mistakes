# orca-no-mistakes

An Orca-native, six-stage local adversarial validation pipeline:

`intent -> rebase -> review -> test -> document -> lint`

The current runner creates an Orca Run, acquires an exclusive semantic lease on the branch in a repository-local SQLite domain ledger (`<git-common-dir>/orca-no-mistakes/ledger.sqlite`), compiles its validation policy from the trusted base commit, and drives fresh reviewers plus retained fixers across disposable child worktrees while the coordinator runs in an isolated gate worktree and applies fixer commits. The first repository command transactionally imports that repository's history from the legacy `~/.orca-no-mistakes/ledger.db` archive when present, then removes that repository's migrated runs from the legacy archive. The worker agent for each stage and role comes from the resolved validation policy configuration. Human decisions use Orca gates; every approval or skip is recorded as an audit row and bound into the final local evidence manifest. Stage evidence (reports, logs, exit codes, content hashes) lands under `~/.orca-no-mistakes/artifacts/<run-id>/`, outside the branch. Release 1 is deliberately local-only: it excludes remote `push`, `pr`, and `ci` stages and terminates with a tamper-evident local v1.3 evidence manifest instead of publishing a candidate or creating a pull request.

Successful completion means all six stages completed with a tamper-evident Merkle evidence manifest binding the recorded stage history and terminal candidate commit, plus the base commit, policy hash, and declared intent. It does not prove that every stage ran against one unchanged candidate. Remote delivery verification and forge adapters remain future releases. See [Current Architecture](docs/current-architecture.md) for implemented behavior and [the ADRs](docs/adr/) for accepted target decisions.

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
orca-no-mistakes run --repo /path/to/repo --resume <failed-run-id>
```

New runs require an explicit single-line `--intent`; failed runs can instead use `--resume` without repeating the intent. The runner requires a clean committed named feature branch, refuses the default base branch, and requires a configured `origin`. It rebases onto the detected default branch unless `--base` is supplied. Detached resume reuses the failed run's ledger and evidence, reconstructs the isolated gate worktree at its last durable checkpoint, and skips completed stages whose commit-bound evidence is still valid. Leave the clean initiating checkout at the failed run's original submission commit so successful custody transfer can advance it automatically.

Useful direct-run options:

```text
--base <branch>
--head <sha>            refuse to run unless HEAD matches
--force-lease           reclaim a branch lease held by another run
--reviewer-model <model>
--fixer-model <model> --fixer-effort <level>
--max-fix-rounds <count>
--tui                   render an interactive read-only Rail when the terminal supports it
--no-tui                emit line-oriented semantic progress on stderr
--resume <failed-run-id>
--allow-local-config
--config <path>
```

Validation policy comes from `.orca/no-mistakes.yaml` on the trusted base ref, not from the proposed branch; an absent file means built-in defaults. It selects the worker agent per stage and role across native (`cursor`), terminal (`claude`, `codex`, `opencode`, `grok`, `gemini`, `kimi`, `agy`, `pi`), and `acp:<target>` harnesses. `--allow-local-config` and `--config <path>` read policy locally instead and mark the run uncertified. Compatible fixers retain their terminal and child worktree across rounds; `agy` and `pi` therefore continue the same interactive process instead of selecting a saved session through user-supplied CLI flags.

Workers launch with the `opencode` agent on the agent's own default model by default; the default maximum is three fix rounds. `ORCA_CLI_COMMAND` overrides the Orca executable and `WORKER_AGENT_READY_TIMEOUT_MS` overrides the 60-second agent-startup deadline. Fresh terminal workers wait 20 seconds when `$SHELL` is fish so hidden panes can finish fish's terminal query and settle before command delivery; `WORKER_SHELL_STARTUP_DELAY_MS` overrides that grace period.

## Attestations and retention

```bash
orca-no-mistakes attestation export <run-id-or-commit-sha> [--out manifest.json] [--repo <path>]
orca-no-mistakes attestation verify <manifest-file|run-id|commit-sha> [--repo <path>]
orca-no-mistakes prune [--before <date>] [--repo <path>]
orca-no-mistakes prune --stranded [--repo <path>]
```

Both attestation commands accept `--repo <path>` to name the repository ledger; passing `--repo` fails closed rather than falling back to the legacy archive.

`verify` recomputes every stage-evidence hash, rebuilds the Merkle root over the manifest header and every stage digest, and cross-checks the intent hash — rewriting a stage hash, a commit SHA, the policy hash, or the run ID fails loudly and exits non-zero. An exported manifest is self-verifying, so it can be carried to a machine that never ran the pipeline and checked there — it is tamper-evident, not signed, so that check proves internal integrity rather than authorship; where the local ledger does hold the run, `verify` additionally requires the stored record to match and re-reads each retained stage log to recompute its artifact digest. Evidence is retained indefinitely — nothing is evicted by age or count — until you explicitly `prune` it. `prune` deletes completed runs matching the filters (`--repo` names a checkout, matching that root and anything nested under it) together with their artifact directories. It never touches Git history: preserved commits under `refs/no-mistakes/recover/` outlive the runs that produced them. It keeps any run that still holds a branch lease, any run whose repository root is unavailable unless `--repo` names that exact root, and any run with a recovery ref — including a fixer round's `-fixer-<stage>-<round>` child — whose commits are not yet contained in its branch or base — those are the runs whose ledger row is the operator's only record of preserved work. `prune --stranded` cannot be combined with `--before`; it instead scans the repository's gate markers (`.orca/no-mistakes/gate-*.json`) and reaps gate workspaces whose coordinator terminal or process is dead — anchoring the run's last committed HEAD to its recovery ref, releasing the branch lease, and removing the worktree, gate branch, terminal, and marker. Anything it cannot prove safe to reap (live pid, live terminal, unreadable marker, or an in-progress run whose gate ownership is absent or unverifiable) is retained, so it cannot tear down a live run. For terminal runs, including passed, failed, and cancelled runs, prune preserves the ledger outcome while finishing any stranded resource cleanup that a prior attempt left incomplete; it removes without `--force`, so Orca refuses a workspace that became live mid-reap instead of tearing it down.

## Gates and outcomes

Decision gates offer `approve`, `fix [ids][: guidance]`, `skip`, or `stop`; unknown resolutions fail closed. Resolve pending gates through Orca's native gate interface; the bundled [`/orca-no-mistakes` skill](skills/orca-no-mistakes/SKILL.md) contains the commands.

A direct `run` starts a detached coordinator in an Orca terminal by default and returns its handle immediately; pass `--attached` to keep the pipeline running inside the invoking process. `--no-tui` writes one bounded semantic status line per durable transition to stderr without cursor motion, spinners, heartbeats, or raw worker output. An attached run blocks until completion or failure and keeps stdout reserved for JSON containing the Orca Run ID, completed stages, custody note, and the full attestation manifest. On success the coordinator anchors `refs/no-mistakes/recover/<run-id>` at the terminal commit before returning custody of the branch: a clean checkout still at the submitted commit is fast-forwarded, while a diverged or dirty checkout is left alone and the custody note tells you how to recover the validated commits from that ref. Failed and cancelled runs attach the same recovery instructions only when the checkout's HEAD differs from the anchored commit; a HEAD already carrying that commit gets no recovery instruction.

## Development

```bash
npm test
npm run typecheck
```

GitHub Actions runs on same-repository pull requests and on pushes to `main`; fork pull requests are skipped.
