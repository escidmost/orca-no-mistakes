# Current Architecture

This document describes implemented behavior in version `0.1.0`. The ADRs under `docs/adr/` describe accepted target architecture; their `implementation` metadata states that they are not current guarantees.

## Entry points

`orca-no-mistakes` supports three commands:

- `install` creates a bare local gate under the repository's Git directory and configures the `orca-no-mistakes` remote.
- `run` launches the coordinator detached in a dedicated Orca terminal tab and returns `{"detached":true,"terminalHandle":"..."}`. If `--notify <handle>` is passed or `ORCA_TERMINAL_HANDLE` is set, the coordinator also notifies that terminal when a decision gate opens. Pass `--attached` to run synchronously in the foreground.
- `push` sends one single-line intent as a Git push option to the installed gate.

The runner requires a clean, committed, named feature branch, rejects the detected default branch, verifies an `origin` remote, and optionally checks an expected `--head` SHA. It fetches and rebases onto the selected base before validation continues.

## Orchestration

The coordinator creates one Orca Run and an ordered nine-task DAG:

`intent -> rebase -> review -> test -> document -> lint -> push -> pr -> ci`

`intent` records the supplied objective. `rebase` and `push` are coordinator-run Git operations. The other stages are worker evaluations that return structured reports.

Reviewers run as fresh opencode workers in disposable child worktrees. Fixes run through one retained opencode terminal on the operator's current worktree. Every fixer round must leave a clean worktree and create a new commit. Workers default to model `openai/gpt-5.6-luna` at max reasoning effort; `--reviewer-model`, `--fixer-model`, and `--fixer-effort` override per role.

## Findings and gates

Findings are `auto-fix`, `ask-user`, or `no-op`. Reports containing only actionable `auto-fix` findings enter the fix loop automatically. The default maximum is three automated fix rounds, configurable via `--max-fix-rounds`. When the fix-round limit is reached with actionable findings remaining, the coordinator opens an exhaustion decision gate.

An `ask-user` finding or fix exhaustion opens an Orca decision gate. Validation stages offer `approve`, `fix`, `skip`, and `stop`; delivery stages offer only `retry` and `stop`. `approve` and `skip` currently let a validation stage complete with unresolved findings.

PR and CI stages are adversarial worker reports. They are not deterministic GitHub API reconciliation, exact-check completeness proof, guarded merge, or delivered-tree verification.

## Evidence

Worker JSON reports and declared artifacts are confined to `~/.orca-no-mistakes/evidence/<run-id>/`. The coordinator validates report shape and prevents report or artifact paths from escaping that directory.

The current store has no SQLite ledger, content hashes, Merkle manifest, signature, automatic retention policy, export command, or prune command.

## Git delivery and custody

Delivery to `origin` uses `git push --force-with-lease --set-upstream origin HEAD:refs/heads/<branch>`. If a PR or CI fixer creates a commit, the coordinator pushes again before rechecking that stage.

Fixers mutate the active worktree. There is no branch semantic lease, duplicate-run rejection, internal submission ref, crash-safe checkpoint, preserved recovery ref, custody synchronization command, or coordinator restart recovery. Operators must avoid concurrent runs for the same repository, branch, and HEAD.

## Outcome

An attached run prints `{"runId":...,"steps":[...]}` after every stage task completes. A detached run prints `{"detached":true,"terminalHandle":"..."}` immediately, and the stage result appears in the dedicated Orca terminal. The coordinator attempts to mark the Orca worktree completed; on failure it throws, sets a nonzero direct-run exit status, and attempts to mark the worktree in review. Worktree-status update failures are logged as warnings rather than changing the pipeline result.

Current completion is not the domain `Passed` outcome. It does not prove that required commands ran deterministically, that policy came from a trusted base, that CI was complete on an exact commit, or that the delivered target-branch tree preserved the tested candidate.

Most subprocess commands time out after 120 seconds; worker orchestration uses longer waits. Gate polling inside the detached coordinator waits for human resolution or pipeline completion, while CLI commands return immediately to prevent agent deadlocks. `ORCA_CLI_COMMAND` overrides the Orca executable; the default is `orca` on macOS and `orca-ide` on Linux.
