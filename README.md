# orca-no-mistakes

An Orca-native eight-stage adversarial validation and publication pipeline:

`intent -> rebase -> review -> test -> document -> lint -> push -> pr`

The runner creates an Orca Run, acquires an exclusive semantic lease on the branch in a repository-local SQLite domain ledger (`<git-common-dir>/orca-no-mistakes/ledger.sqlite`), validates through disposable child worktrees, publishes the exact candidate, publishes the owned title/body pull-request report, notifies the origin of readiness, remains active while the pull request is open, and cannot succeed until an authoritative matching MERGED observation settles the receipt. Stage and remote evidence lands under `~/.orca-no-mistakes/artifacts/<run-id>/`, outside the branch. A migrated Release 1 failure resumes under its frozen six-stage local plan and produces a v1.3 manifest only if it later passes; new initialized runs use the eight-stage Release 2 plan and v2 completion attestation.

For Release 2 runs, successful completion means all eight required stages and both remote receipts settled durably in a v2 completion attestation; migrated Release 1 resumes complete successfully when their six local stages pass and produce a v1.3 manifest under `attestation`. CI and delivery-proof orchestration remain future work. See [Current Architecture](docs/current-architecture.md) for implemented behavior and [the ADRs](docs/adr/) for accepted target decisions.

## Install

Requires Node.js 24+, Git, a running Orca app, and authenticated CLI tooling for the configured worker agents (`opencode` by default). New Release 2 runs additionally require the GitHub CLI (`gh`) with existing authentication (`GH_TOKEN`, `GITHUB_TOKEN`, or stored `gh` auth); migrated Release 1 resumes do not require GitHub publication initialization or credentials.

```bash
npm install
npm link
```

During installation, a default configuration template is automatically copied to `~/.config/orca-no-mistakes/config.yaml` (from [`templates/config.yaml`](templates/config.yaml)) if no configuration exists.

## Run

New direct runs require successful `orca-no-mistakes init` to configure GitHub publication and persist the repository route before execution. Direct invocation returns a meaningful process exit status:

```bash
orca-no-mistakes run --repo /path/to/repo --intent "Add X without changing Y"
orca-no-mistakes run --repo /path/to/repo --resume <failed-run-id>
```

New runs require an explicit single-line `--intent` and prior `orca-no-mistakes init`; failed runs can instead use `--resume` without repeating the intent. The runner requires a clean committed named feature branch, refuses the default base branch, and requires a configured `origin`. It rebases onto the detected default branch unless `--base` is supplied, publishes the validated candidate with an exact force-with-lease, publishes the owned title/body report, notifies the origin of readiness, and remains active while the pull request is open until an authoritative matching MERGED observation settles the receipt. Detached resume reuses the failed run's ledger and evidence, reconstructs the isolated gate worktree at its last durable checkpoint, and skips completed stages whose commit-bound evidence is still valid. Leave the clean initiating checkout at the failed run's original submission commit so successful custody transfer can advance it automatically.

## Local gate

Install or repair the repository-local bare gate and its managed remote:

```bash
orca-no-mistakes init --repo /path/to/repo
# Fork publication:
orca-no-mistakes init --repo /path/to/repo --fork owner/repo --head-branch feature
```

Submit one feature-branch update with one encoded intent option. The gate admits the update before Git mutates its permanent ref, then launches the same detached pipeline used by direct `run`:

```bash
intent=$(node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64url"))' 'Add X without changing Y')
git -C /path/to/repo push --push-option="no-mistakes.intent=$intent" orca-no-mistakes HEAD:refs/heads/feature
```

When the upstream remote parses as GitHub, `init` also verifies GitHub authentication and persists the stable base/head repository route; provider-neutral init installs the local gate without a publication route. New Release 2 runs require the persisted GitHub publication route before they can complete the remote push and pr stages. Use `--upstream`, `--fork`, `--base-branch`, and `--head-branch` to override the detected route. Tags, deletes, the default branch, multi-ref pushes, malformed intent, and unsafe transport state are rejected before admission. Gate and direct submissions with the same repository, ref, candidate, and intent converge on one durable submission identity and run the same remote delivery stages.

Useful direct-run options:

```text
--base <branch>
--head <sha>            refuse to run unless HEAD matches
--force-lease           reclaim a branch lease held by another run
--reviewer-model <model>
--fixer-model <model> --fixer-effort <level>
--max-fix-rounds <count>
--tui                   render an interactive Rail with inline decision-gate resolution; default for detached runs
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

For migrated Release 1 v1.3 manifests, `verify` recomputes every stage-evidence hash, rebuilds the Merkle root over the manifest header and every stage digest, and cross-checks the intent hash; for Release 2 v2 manifests, `verify` recomputes the canonical full-manifest Merkle root after omitting `merkleRoot` (while checking pipeline evidence roots and stage evidence) — rewriting a stage hash, a commit SHA, the policy hash, or the run ID fails loudly and exits non-zero. An exported manifest is self-verifying, so it can be carried to a machine that never ran the pipeline and checked there — it is tamper-evident, not signed, so that check proves internal integrity rather than authorship; where the local ledger does hold the run, `verify` additionally requires the stored record to match and re-reads each retained stage artifact to recompute its artifact digest. Evidence is retained indefinitely — nothing is evicted by age or count — until you explicitly `prune` it. `prune` deletes completed runs matching the filters (`--repo` names a checkout, matching that root and anything nested under it) together with their artifact directories. It never touches Git history: preserved commits under `refs/no-mistakes/recover/` outlive the runs that produced them. It keeps any run that still holds a branch lease, any run whose repository root is unavailable unless `--repo` names that exact root, and any run with a recovery ref — including a fixer round's `-fixer-<stage>-<round>` child — whose commits are not yet contained in its branch or base — those are the runs whose ledger row is the operator's only record of preserved work. `prune --stranded` cannot be combined with `--before`; it instead scans the repository's recovery markers (`.orca/no-mistakes/gate-*.json`) and reaps gate or direct-run resources whose coordinator terminal or process is dead — a gate reaping anchors the run's last committed HEAD to its recovery ref, releases the branch lease, and removes the worktree, gate branch, terminal, and marker; a direct-run Force-stop marker is settled and removed without touching the checkout (below). Anything it cannot prove safe to reap (live pid, live terminal, unreadable marker, or an in-progress run whose gate ownership is absent or unverifiable) is retained, so it cannot tear down a live run. For terminal runs, including passed, failed, and cancelled runs, prune preserves the ledger outcome while finishing any stranded resource cleanup that a prior attempt left incomplete; it removes without `--force`, so Orca refuses a workspace that became live mid-reap instead of tearing it down.

Pruning also removes every submission admission bound to the deleted run, so an identical later submission is admitted again instead of replaying evidence that no longer exists.

## Gates and outcomes

Finding gates offer `approve`, `fix [ids][: guidance]`, `skip`, or `stop`, while durable resume-decision gates offer `resume` or `stop`; unknown resolutions fail closed. With `--tui`, finding gates show each open finding: use Up/Down to select a finding, `F` for Fix, `A` for Approve as is, and Page Up/Down to scroll long descriptions. Choose for every finding, then press Enter to review the fix/approval counts and Enter again to submit. Findings sharing an ID share a choice. Other gates retain their offered choices. Esc returns unanswered and `G` reopens the gate; outside the finding editor, `A` toggles the local gate auto-responder and synchronizes durable Auto-fix mode to the resulting state (see [Findings and gates](docs/current-architecture.md#findings-and-gates)); when the error panel reports a resumable stage failure, `R` starts the next attempt of the same run from its durable checkpoint (offered only after the failed attempt is durably settled and its workers cleaned), while confirming Cancel from the error panel leaves the already-settled run stopped for a later detached `--resume`; `C` opens the Cancel confirmation (Enter confirms Cancel, Esc dismisses it), raw Ctrl-Z suspends the TUI and restores the terminal (continuing the process re-enters it with a redraw), the first Ctrl-C requests an orderly Cancel, and a second Ctrl-C Force stops, leaving marker-based recovery that `prune --stranded` later settles as cancelled. TUI `R`/`C` choices resolve the same durable resume gate used by remote agents. Agents must answer detached decisions with the supplied `orca orchestration send` command rather than injecting terminal input. The bundled [`/orca-no-mistakes` skill](skills/orca-no-mistakes/SKILL.md) contains the commands.

For a detached gate run, stranded recovery owns the gate worktree and its workers. For a direct-attached run, Force stop writes a direct-run marker containing the exact HEAD and worker state; recovery preserves that HEAD, reaps owned workers, settles the run cancelled, releases its lease, and removes only the marker, never the operator's checkout or branch.

A newly admitted direct `run` starts a detached coordinator in an Orca terminal by default and returns its handle immediately; pass `--attached` to keep the pipeline running inside the invoking process. When its deterministic admission is already being handled or accepted, `run` instead returns `{"admissionId":"...","replayed":true,"runId":"..."}` immediately without launching another coordinator; `runId` can be `null` until the live launch binds its run. `--no-tui` writes one bounded semantic status line per durable transition to stderr without cursor motion, spinners, heartbeats, or raw worker output. An attached run blocks until completion or failure — including, when the TUI renders, the durable post-failure resume decision on a resumable error (an attached `--no-tui` run stops at the failure instead) — and keeps stdout reserved for JSON containing the Orca Run ID, completed stages, custody note, and the full attestation manifest. On success the coordinator anchors `refs/no-mistakes/recover/<run-id>` at the terminal commit before returning custody of the branch: a clean checkout still at the submitted commit is fast-forwarded, while a diverged or dirty checkout is left alone and the custody note tells you how to recover the validated commits from that ref. Failed and cancelled runs attach the same recovery instructions only when the checkout's HEAD differs from the anchored commit; a HEAD already carrying that commit gets no recovery instruction.

## Release acceptance

See [Release 2 acceptance](docs/release-2-acceptance.md) for the macOS/Linux local matrix, live fixture requirements, evidence and recovery procedures. Release 2 acceptance remains incomplete until both local platforms and a protected live same-repository/fork run pass.

## Development

```bash
npm test
npm run typecheck
```

GitHub Actions runs on same-repository pull requests and on pushes to `main`; fork pull requests are skipped.
