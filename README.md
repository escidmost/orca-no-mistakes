# orca-no-mistakes

An Orca-native pipeline that reviews committed changes, runs validation in isolated worktrees, and publishes the validated candidate to GitHub.

```text
intent -> rebase -> review -> test -> document -> lint -> push -> pr -> ci
```

The pipeline owns the pull request's title and body, notifies the originating session when it is ready, and monitors CI and mergeability until the exact matching pull request is merged. Successful completion records the stage evidence, publication receipts, and custody result in a portable completion attestation. Trusted repositories can add [command gates](docs/current-architecture.md#repository-command-gates) before publication.

The [workflow guide](docs/workflows/README.md) includes interactive pipeline and recovery diagrams, plus a walkthrough of finding decisions and repairs.

CI monitoring reports failures for human action; it does not repair or merge the pull request. Completion records the observed merge, but does not prove required-check completeness or delivered-tree integrity. The stronger target `Passed` guarantee is defined in the [ADRs](docs/adr/).

## Install

Requires Node.js 24+, Git, a running Orca app, authenticated worker-agent tooling, and the GitHub CLI (`gh`) with existing authentication (`GH_TOKEN`, `GITHUB_TOKEN`, or stored `gh` auth). Git push authentication must also work.

From this package checkout:

```bash
npm install
npm link
```

Installation creates `~/.config/orca-no-mistakes/config.yaml` from the [configuration template](templates/config.yaml) if no configuration exists. The template selects `claude`; without an agent setting, the runner falls back to `opencode`. Configure and authenticate the agents you intend to use.

## Run

Initialize each repository once, then submit a clean, committed feature branch with a single-line intent:

```bash
orca-no-mistakes init --repo /path/to/repo
orca-no-mistakes run --repo /path/to/repo --intent "Add X without changing Y"
```

Initialization persists the GitHub publication route for every worktree and branch in that repository. The checkout must have an `origin` remote and be on a named branch other than the detected default branch. The runner rebases onto the default branch unless you pass `--base <branch>`.

A newly admitted run starts a detached coordinator in an Orca terminal and returns its handle immediately. Handle its notifications and decisions in the originating session; command return and PR readiness do not mean the pipeline has completed. An identical submission already being handled returns its admission identity instead of starting another coordinator.

To continue a failed run:

```bash
orca-no-mistakes run --repo /path/to/repo --resume <failed-run-id>
```

Resume reconstructs the isolated worktree at the last durable checkpoint and reuses evidence that is still valid for that commit. Leave the clean initiating checkout at the original submission commit so successful custody transfer can advance it automatically. Automatic adoption of an abandoned `in-progress` run is unavailable; see [recovery](#attestations-and-retention).

Useful options:

```text
--base <branch>          select the run's base branch
--head <sha>             refuse to run unless HEAD matches
--notify <handle>        send decisions and outcomes to an Orca terminal
--reviewer-model <model>
--fixer-model <model> --fixer-effort <level>
--max-fix-rounds <count>
--tui                    interactive run view; default for detached runs
--no-tui                 line-oriented progress on stderr
--attached               run in the invoking process and wait for the result
--force-lease            reclaim a branch lease after confirming its owner is dead
--allow-local-config     read working-tree policy; marks the run uncertified
--config <path>          read an explicit policy file; marks the run uncertified
```

## Local gate

`init` also installs a repository-local bare gate and the managed `orca-no-mistakes` Git remote. To configure fork publication:

```bash
orca-no-mistakes init --repo /path/to/repo --upstream owner/repo --fork contributor/repo
```

Submit the checked-out feature branch with one encoded intent option:

```bash
intent=$(node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64url"))' 'Add X without changing Y')
git -C /path/to/repo push --push-option="no-mistakes.intent=$intent" orca-no-mistakes HEAD:refs/heads/feature
```

The gate admits the update before Git changes its permanent ref, then launches the same detached pipeline as `run`. Tags, deletes, the default branch, multi-ref pushes, malformed intent, and unsafe transport state are rejected before admission.

Use `init --upstream` and `--fork` to select repositories. Its `--base-branch` and `--head-branch` options set initial route coordinates; each run uses its own selected base and checked-out feature branch. To select a non-default base, use direct `run --base`.

Initialization with a non-GitHub upstream installs the local gate only. The publication pipeline requires a persisted GitHub route. See [Entry points](docs/current-architecture.md#entry-points) for admission and replay behavior.

## Configuration

Repository validation policy comes from `.orca/no-mistakes.yaml` on the trusted base ref. An absent file uses built-in defaults. CLI overrides take precedence over repository and user-global agent settings; `--allow-local-config` and `--config` bypass trusted-base loading and mark the run uncertified.

Each stage and role can select a native (`cursor`), terminal (`claude`, `codex`, `opencode`, `grok`, `gemini`, `kimi`, `agy`, `pi`), or `acp:<target>` agent. Workers use the agent's own model unless configured otherwise. The default fix-round limit is three. Compatible fixers retain their terminal and child worktree across rounds.

The [configuration template](templates/config.yaml) lists settings and defaults; [configuration precedence](docs/adr/0011-hierarchical-configuration-and-precedence.md) and [validation policy](docs/current-architecture.md#validation-policy) explain how they resolve.

Environment overrides:

- `ORCA_CLI_COMMAND`: Orca executable; defaults to `orca` on macOS and `orca-ide` on Linux.
- `WORKER_AGENT_READY_TIMEOUT_MS`: agent-startup deadline, default 60 seconds.
- `WORKER_SHELL_STARTUP_DELAY_MS`: shell-startup grace period, default 20 seconds for fish and zero otherwise.
- `ORCA_NO_MISTAKES_HOME`: artifact home, default `~/.orca-no-mistakes`; repository ledgers remain under the Git common directory.

## Gates and outcomes

Worker finding gates offer `approve`, `fix`, `skip`, or `stop`. A targeted `fix [id1,id2] - guidance` repairs the selected findings and approves unselected open findings for that candidate. Approvals and skips are recorded in evidence. See [Findings and gates](docs/current-architecture.md#findings-and-gates) for selection, auto-fix, and guardrail rules.

Other gates have narrower choices:

- CI: `fix` resumes monitoring after external action; `stop` ends the run.
- Required command failure or rebase conflict: `fix` or `stop`.
- Resumable failure: `resume` or `stop`.
- Worker question: `reply: <your answer>` or `stop`.

Agents must use the exact `orca orchestration send` command supplied in the notification, substituting only the chosen resolution. Do not inject terminal input into a detached coordinator. The bundled [agent skill](skills/orca-no-mistakes/SKILL.md) describes this workflow.

In the TUI, use Up/Down to select findings, `F` to fix, `A` to approve, and Enter to review and submit choices. `G` reopens a gate. Outside the finding editor, `A` toggles the local gate auto-responder and durable Auto-fix mode. A resumable error offers `R` to resume; `C` opens Cancel confirmation. The first Ctrl-C requests orderly cancellation; a second forces a stop for later stranded recovery. See [Run TUI](docs/adr/0015-run-tui-presentation-and-control-boundary.md) for the control contract.

Human decision waits and the pipeline have no total deadline. Worker-attempt deadlines are independent. CI's idle timeout opens a decision gate rather than terminating the run.

An attached run waits for completion and returns a nonzero status on failure or cancellation. Its stdout is reserved for JSON containing the run ID, completed stages, verdict, custody note, and `completionAttestation`. Detached runs deliver their outcome through Orca notifications.

On success, the coordinator preserves the terminal commit under `refs/no-mistakes/recover/<run-id>` and advances a clean initiating checkout still at the submitted commit. If the checkout has changed, it leaves it alone and returns recovery instructions. See [Custody return](docs/current-architecture.md#custody-return).

## Live Test evidence

Test checker reports require `liveValidation`: an overall `verdict`, a nonempty `reason`, and named `scenarios` whose trimmed names are nonempty and unique. Each scenario records `result` (`pass`, `fail`, or `untested`), a boolean `live`, an `evidence` string array, and a `limitation` string.

Pass/fail requires live execution and nonempty evidence. Untested requires `live: false` and a nonempty limitation. Live means driving the real product during this run; unit tests, mocks, recordings, and source inspection are supporting checks.

- `go` requires a live pass and no failed scenario. An individually untested scenario need not block a justified overall `go`.
- `no-go` creates an actionable failure; every failed scenario requires that verdict.
- `inconclusive` and `no-surface` require an explicit human decision.
- `no-surface` requires `scenarios: []` and a reason explaining why no runtime surface applies. Every other verdict requires at least one scenario.

Put startup and focused end-user test instructions in the inline `test_runbook` string in trusted-base `.orca/no-mistakes.yaml` (default: empty). It is included in the effective policy hash; proposed-branch and user-global runbooks do not override it. Checkers stay read-only; fixers submit separate repair reports.

Scenarios and verdicts are retained in commit-bound evidence, Test stage details, and the managed PR report. Candidate changes require fresh Test evidence. Screenshots and recordings reach the PR only through the opt-in [media-attachment contract](docs/current-architecture.md#orchestration).

## Attestations and retention

```bash
orca-no-mistakes attestation export <run-id-or-commit-sha> [--out manifest.json] [--repo <path>]
orca-no-mistakes attestation verify <manifest-file|run-id|commit-sha> [--repo <path>]
orca-no-mistakes prune [--before <date>] [--repo <path>]
orca-no-mistakes prune --stranded [--repo <path>]
orca-no-mistakes abandon --run-id <id> --reason <text> [--repo <path>]
```

Run metadata lives in `<git-common-dir>/orca-no-mistakes/ledger.sqlite`; stage and remote artifacts live in `<artifact-home>/artifacts/<run-id>/`, where `<artifact-home>` is `ORCA_NO_MISTAKES_HOME` or, by default, `~/.orca-no-mistakes`. `--repo` selects the repository ledger explicitly.

Exported manifests can be verified offline. Verification checks internal hashes; when the local ledger holds the run, it also checks the stored record and retained stage artifacts at their recorded paths. Manifests are tamper-evident and unsigned: they prove internal integrity, not authorship. See [Evidence](docs/current-architecture.md#evidence) for the schema and verification contract.

Evidence remains until explicitly pruned. Ordinary `prune` deletes eligible terminal run records and artifacts, including their submission admissions. It preserves Git recovery refs and retains runs with active leases, unavailable repositories, or recovery commits not yet contained in the branch or base. `--repo` matches the named checkout and nested roots; the exact-root override for an unavailable repository is described in [retention rules](docs/current-architecture.md#entry-points).

Prune locates artifacts under the current artifact home. Use the same `ORCA_NO_MISTAKES_HOME` setting that created them; changing it does not relocate existing evidence or rewrite recorded artifact paths.

`prune --stranded` recovers resources whose coordinator is proven dead; it cannot be combined with `--before`. It preserves the recorded HEAD, reaps owned workers, and releases the lease. Gate recovery removes owned gate resources; direct-run recovery leaves the operator's checkout and branch intact. Uncertain liveness or ownership keeps resources for diagnosis.

`abandon` explicitly ends a failed or orphaned run's resumability while retaining its evidence, attempt outcomes, artifacts, and Git refs. Run it on the machine that ran the coordinator: it requires the latest recorded coordinator PID to be absent, rejects pending resume claims and unrecorded lease generations, records the reason, marks the run cancelled, and releases only its lease. It also releases the run's bound submission admission, allowing the identical branch, candidate, and intent to start a fresh run. It does not remove worktrees or stop workers; use stranded recovery for those resources. This also removes that run's publication-route dependency. The route blocker counts retained in-progress and resumable failed records, not live processes.

## Development

```bash
npm test
npm run typecheck
```

The package executes its TypeScript directly; use `./bin/orca-no-mistakes` to run this checkout. [Test organization](tests/README.md) covers focused test commands.

The self-hosted CI workflow runs on same-repository pull requests and pushes to `main`; fork pull requests are skipped. The hosted macOS/Linux [local acceptance matrix](docs/acceptance.md#local-matrix) runs on path-filtered pull requests, including forks. Full acceptance still requires current local results and protected live same-repository/fork evidence; see the [acceptance runbook](docs/acceptance.md).

## Reference

- [Current architecture](docs/current-architecture.md): implementation, evidence, orchestration, and recovery.
- [Domain glossary](CONTEXT.md): pipeline terminology and assurance claims.
- [Architecture decisions](docs/adr/): accepted design decisions and historical roadmap.
- [Review evaluation](docs/review-evaluation.md): local model comparisons using fixed Git cases and human finding labels.
