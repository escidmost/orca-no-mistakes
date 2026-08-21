# orca-no-mistakes

An Orca-native, six-stage local adversarial validation pipeline:

`intent -> rebase -> review -> test -> document -> lint`

Release 1 is deliberately local-only: it excludes remote `push`, `pr`, and `ci` stages and terminates with a signed-off **Passed Attestation** instead of a push.

The runner creates an Orca Run, acquires an exclusive semantic lease on the branch in a SQLite domain ledger (`~/.orca-no-mistakes/ledger.db`), compiles its validation policy from the trusted base commit, and drives fresh reviewer workers over disposable child worktrees while one retained fixer terminal repairs the current worktree. Human decisions use Orca gates; every approval or skip is recorded as an audit row and bound into the final attestation. Stage evidence (reports, logs, exit codes, content hashes) lands under `~/.orca-no-mistakes/artifacts/<run-id>/`, outside the branch.

Successful completion means all six stages completed with a tamper-evident Merkle attestation binding stage evidence to the exact candidate commit, base commit, policy hash, and declared intent. Remote delivery verification, crash resumption, and forge adapters remain future releases. See [Current Architecture](docs/current-architecture.md) for implemented behavior and [the ADRs](docs/adr/) for accepted target decisions.

## Install

Requires Node.js 24+, Git, a running Orca app, and authenticated `opencode` tooling.

```bash
npm install
npm link
```

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
```

Workers launch with the `opencode` agent on model `openai/gpt-5.6-luna` at max reasoning effort by default; the default maximum is three fix rounds. `ORCA_CLI_COMMAND` overrides the Orca executable.

## Attestations and retention

```bash
orca-no-mistakes attestation export <run-id-or-commit-sha> [--out manifest.json]
orca-no-mistakes attestation verify <manifest.json>
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
