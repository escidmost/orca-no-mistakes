# Current Architecture

This document describes implemented behavior for Release 1 (Local Adversarial Validation Core). The ADRs under `docs/adr/` describe accepted target architecture; their `implementation` metadata states how much is current guarantee.

## Entry points

`orca-no-mistakes` supports three commands:

- `run` launches the coordinator detached in a dedicated Orca terminal tab and returns `{"detached":true,"terminalHandle":"..."}`. If `--notify <handle>` is passed or `ORCA_TERMINAL_HANDLE` is set, the coordinator also notifies that terminal when a decision gate opens. Pass `--attached` to run synchronously in the foreground.
- `attestation export|verify` reads or checks Passed Attestation manifests against the domain ledger and retained evidence.
- `prune [--before <date>] [--repo <substring>]` deletes completed runs (cascading checkpoints, evidence, gate audit rows, attestations) plus their artifact directories.

The runner requires an explicit single-line `--intent`, a clean, committed, named feature branch, rejects the detected default branch, verifies an `origin` remote, and optionally checks an expected `--head` SHA. It fetches and rebases onto the selected base before validation continues.

## Domain ledger

All identity and provenance state lives in SQLite at `~/.orca-no-mistakes/ledger.db` (WAL mode, foreign keys on), created via `node:sqlite`. Tables:

- `runs` — one row per pipeline attempt with submission commit OID, base branch/OID, intent + intent hash, trusted-policy hash, and terminal status (`in-progress`, `passed`, `failed`, `cancelled`).
- `branch_leases` — one exclusive semantic lease per `(repo_root, branch)` with a monotonically increasing generation token and heartbeat timestamp. A second run on a leased branch fails closed; `--force-lease` reclaims it. The lease heartbeat is checked before every stage and each fix round; losing the lease aborts the run. The lease is released when the run passes or fails.
- `stage_checkpoints` — the intent stage records a reconciliation snapshot at round 0; every fixer round records its input and output commit OIDs (each fixer must commit a distinct change).
- `stage_evidence` — one row per stage execution binding stage id, round, candidate/base commit OIDs, worker identity, exit code, summary, artifact path, and the SHA-256 evidence digest.
- `gate_audit` — every human gate resolution with question, offered options, raw resolution, parsed decision, and guidance.
- `passed_attestations` — the manifest JSON and Merkle root for each passed candidate commit.

Set `ORCA_NO_MISTAKES_HOME` to relocate `~/.orca-no-mistakes` (used by tests and sandboxes).

## Orchestration

The coordinator creates one Orca Run and an ordered six-task DAG:

`intent -> rebase -> review -> test -> document -> lint`

`intent` records the supplied objective behind `<untrusted_instruction>` framing. `rebase` is a coordinator-run Git operation; the other stages are worker evaluations returning structured reports. Release 1 executes no remote push, PR creation, or CI reconciliation.

The validation policy (reviewer/fixer prompt templates) is compiled from the trusted base commit: the coordinator hashes its own script files as they exist at `origin/<base>` and records that digest in the ledger and attestation. Reviewer prompts frame repository content, diffs, and instructions as untrusted data; policy changes may only come from the coordinator prompt itself.

Reviewers run as fresh opencode workers in disposable child worktrees. Fixes run through one retained opencode terminal on the operator's current worktree. Every fixer round must leave a clean worktree and create a new commit; review-stage fixers are forbidden from weakening existing test assertions or linter configurations. Workers default to model `openai/gpt-5.6-luna` at max reasoning effort; `--reviewer-model`, `--fixer-model`, and `--fixer-effort` override per role.

## Findings and gates

Findings are `auto-fix`, `ask-user`, or `no-op`. Reports containing only actionable `auto-fix` findings enter the fix loop automatically. The default maximum is three automated fix rounds, configurable via `--max-fix-rounds`. When the fix-round limit is reached with actionable findings remaining, the coordinator opens an exhaustion decision gate.

An `ask-user` finding or fix exhaustion opens an Orca decision gate offering `approve`, `fix [ids][: guidance]`, `skip`, and `stop`. Unknown resolutions fail closed. `approve` and `skip` complete the stage with unresolved findings and are recorded in `gate_audit` and bound into the attestation as a waiver on that stage's final evidence entry. The adversarial review stage reconciles the diff against the declared intent: unexplained relaxation of tests or linter policy surfaces as a blocking `ask-user` finding.

## Evidence

Worker JSON reports, coordinator stage logs, and declared artifacts are confined to `~/.orca-no-mistakes/artifacts/<run-id>/`. The coordinator validates report shape and prevents report or artifact paths from escaping that directory. Coordinator-written logs larger than 50 MB are capped to head + tail with an explicit truncation marker.

Each stage execution produces a `stage_evidence` row whose SHA-256 digest covers stage, round, candidate commit OID, base commit OID, worker identity, exit code, and summary.

## Custody return

On success the coordinator evaluates the three-way containment proof between the submitted head (`C_sub`), the operator's branch head (`C_op`), and the terminal validated commit (`C_term`). It always anchors `refs/no-mistakes/recover/<run-id>` at `C_term` first. If the operator checkout equals the submission it fast-forwards the branch to the terminal commit; if the operator checkout diverged, the branch is left untouched and the recovery ref preserves the validated commits. Evidence is retained until explicit `prune`.

## Outcome

An attached run prints `{"runId":...,"steps":[...],"attestation":{...}}` after completion; the attestation manifest carries the run ID, candidate/base commit OIDs, trusted-policy hash, intent + intent hash, ordered stage-evidence entries (including waivers), Merkle root, and coordinator version. On failure the coordinator throws, marks the run `failed` (or `cancelled` for a `stop` resolution), releases the lease, sets a nonzero exit status, and attempts to mark the worktree in review. Worktree-status update failures are logged as warnings rather than changing the pipeline result.

Not yet implemented from the target architecture: remote push/PR/CI stages, crash resumption of interrupted runs, canonical signatures over manifests, forge-side delivery verification, and guarded merge transitions. See ADRs 0003, 0004, 0006, 0007, and 0010.

Most subprocess commands time out after 120 seconds; worker orchestration uses longer waits. Gate polling inside the detached coordinator waits for human resolution or pipeline completion, while CLI commands return immediately to prevent agent deadlocks. `ORCA_CLI_COMMAND` overrides the Orca executable; the default is `orca` on macOS and `orca-ide` on Linux.
