# Current Architecture

This document describes implemented behavior for Release 1 (Local Adversarial Validation Core). The ADRs under `docs/adr/` describe accepted target architecture; their `implementation` metadata states how much is current guarantee.

## Entry points

`orca-no-mistakes` supports three commands:

- `run` launches the coordinator detached in an isolated child gate worktree and dedicated Orca terminal tab and returns `{"detached":true,"terminalHandle":"..."}`. If `--notify <handle>` is passed or `ORCA_TERMINAL_HANDLE` is set, the coordinator also notifies that terminal when a decision gate opens and notifies and wakes the originating session on terminal run outcomes (`passed`, `failed`, or `cancelled`). (The internal `--attached` flag runs synchronously inside the spawned terminal tab).
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
- `passed_attestations` — one row per passed run keyed by run ID, holding the manifest JSON and Merkle root; lookups by candidate commit OID return the most recent attestation.

Set `ORCA_NO_MISTAKES_HOME` to relocate `~/.orca-no-mistakes` (used by tests and sandboxes).

## Orchestration

The coordinator creates one Orca Run and an ordered six-task DAG:

`intent -> rebase -> review -> test -> document -> lint`

`intent` records the supplied objective behind `<untrusted_instruction>` framing. `rebase` is a coordinator-run Git operation; the other stages are worker evaluations returning structured reports. Release 1 executes no remote push, PR creation, or CI reconciliation.

Reviewers and fixers run as fresh workers in disposable child worktrees; fixer commits are applied back to the coordinator's isolated gate worktree. Every fixer round must leave a clean worktree and create a new commit; review-stage fixers are forbidden from weakening existing test assertions or linter configurations.

Each stage and role resolves its own agent from the configuration tiers, and the launch adapter dispatches on the resolved harness:

- `claude`, `codex`, and `cursor` launch through native `orca orchestration worker-start`, which receives the resolved model, effort, and timeout as flags.
- `opencode`, `grok`, and `gemini` launch in a spawned terminal by sending a shell-quoted startup command carrying the resolved model, variant, and any `agent_args_override` entries, then dispatching instructions by injection. `agy` receives its authenticated preamble through a protected prompt file passed to `--prompt-interactive`; its adapter also provides custom readiness matching and automatic workspace trust configuration in `~/.gemini/antigravity-cli/settings.json`.
- `acp:<target>` harnesses run through the `acpx` runner (`acpx --format quiet --approve-all <target> exec "<prompt>"`) and must return a JSON stage report.

Terminal-launched harnesses use per-harness readiness matchers; startup waits up to `WORKER_AGENT_READY_TIMEOUT_MS` milliseconds (default 60000) before the terminal and any allocated worktree are torn down. With no configuration the default remains one `opencode` worker per role on the agent's own default model; `--reviewer-model`, `--fixer-model`, and `--fixer-effort` override per role at the highest precedence.

## Validation policy

Two provenance rules bind every run. First, repository agent configuration is read from `.orca/no-mistakes.yaml` on the trusted base ref (`git show origin/<base>:.orca/no-mistakes.yaml`); an absent file resolves to an empty policy, and an unresolvable base ref fails the run. Second, the coordinator hashes its own script files as they exist at `origin/<base>` and records that digest in the ledger and attestation. Reviewer prompts frame repository content, diffs, and instructions as untrusted data; policy changes may only come from the coordinator prompt itself.

The extracted configuration supplies per-stage and per-role agent selection and is merged under the CLI flags. `--allow-local-config` reads the same path from the working tree instead, and `--config <path>` reads an explicit file that must exist. Either bypass marks the run uncertified: the Orca worktree status is prefixed `[uncertified: local config bypass]` and the artifacts manifest records `local_bypass`.

## Findings and gates

Findings are `auto-fix`, `ask-user`, or `no-op`. Reports containing only actionable `auto-fix` findings enter the fix loop automatically. The default maximum is three automated fix rounds, configurable via `--max-fix-rounds`. When the fix-round limit is reached with actionable findings remaining, the coordinator opens an exhaustion decision gate.

An `ask-user` finding or fix exhaustion opens an Orca decision gate offering `approve`, `fix [ids][: guidance]`, `skip`, and `stop`. Unknown resolutions fail closed. `approve` and `skip` complete the stage with unresolved findings and are recorded in `gate_audit` and bound into the attestation as a waiver on that stage's final evidence entry. The adversarial review stage reconciles the diff against the declared intent: unexplained relaxation of tests or linter policy surfaces as a blocking `ask-user` finding.

## Evidence

Worker JSON reports, coordinator stage logs, and declared artifacts are confined to `~/.orca-no-mistakes/artifacts/<run-id>/`. The coordinator validates report shape and prevents report or artifact paths from escaping that directory. Coordinator-written logs larger than 50 MB are capped to head + tail with an explicit truncation marker.

Each stage execution produces a `stage_evidence` row whose SHA-256 digest covers stage, round, candidate commit OID, base commit OID, worker identity, exit code, and summary. Each run also writes `manifest.json` beside its reports, recording `base_ref`, `base_ref_sha`, `local_bypass`, the effective policy configuration snapshot with resolved CLI overrides, and its `effective_policy_hash` (SHA-256 over key-sorted canonical JSON).

## Custody return

On success the coordinator evaluates the three-way containment proof between the submitted head (`C_sub`), the operator's branch head (`C_op`), and the terminal validated commit (`C_term`). It always anchors `refs/no-mistakes/recover/<run-id>` at `C_term` first. If the operator checkout equals the submission and the terminal history is append-only, it fast-forwards the branch to the terminal commit. Rewritten or otherwise divergent history is never reset automatically; the branch is left untouched and the recovery ref preserves the validated commits. Failed and cancelled runs likewise anchor their terminal gate head before teardown. Evidence is retained until explicit `prune`.

## Outcome

An attached run prints `{"runId":...,"steps":[...],"attestation":{...}}` after completion; the attestation manifest carries the run ID, candidate/base commit OIDs, trusted-policy hash, intent + intent hash, ordered stage-evidence entries (including waivers), Merkle root, and coordinator version. On failure the coordinator anchors the terminal gate head, throws, marks the run `failed` (or `cancelled` for a `stop` resolution), releases the lease, sets a nonzero exit status, and attempts to mark the worktree in review. If recovery anchoring fails, the gate and lease are retained instead of deleting the only reachable copy. Worktree-status update failures are logged as warnings rather than changing the pipeline result.

Not yet implemented from the target architecture: remote push/PR/CI stages, crash resumption of interrupted runs, canonical signatures over manifests, forge-side delivery verification, and guarded merge transitions. See ADRs 0003, 0004, 0006, 0007, and 0010.

Most subprocess commands time out after 120 seconds; worker orchestration uses longer waits. Gate polling inside the detached coordinator waits for human resolution or pipeline completion, while CLI commands return immediately to prevent agent deadlocks. `ORCA_CLI_COMMAND` overrides the Orca executable; the default is `orca` on macOS and `orca-ide` on Linux.
