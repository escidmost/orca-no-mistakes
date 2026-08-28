---
name: orca-no-mistakes
description: Validate committed code changes through the Orca no-mistakes pipeline before delivery. Use when the user asks to run orca-no-mistakes, validate or gate changes, push safely, or invokes /orca-no-mistakes.
user-invocable: true
---

# Orca No-Mistakes

Drive the implemented `orca-no-mistakes` CLI. It runs the six local validation stages:

`intent -> rebase -> review -> test -> document -> lint`

Release 1 is local-only: it does not push, create PRs, or wait for CI. Success produces a Passed Attestation bound to the validated commit.

If your assigned task explicitly says you are already a no-mistakes stage worker, complete only that stage and return its structured report. Do not start a nested pipeline.

## Preconditions

- Work is committed on a clean, named feature branch.
- The branch is not the detected default branch.
- The repository has an `origin` remote.
- Orca is running and CLI tooling for the configured worker agents (`opencode` by default) is authenticated.
- No other run holds the branch semantic lease. A conflicting run fails closed with `branch <name> is already leased by run <id>`; reclaim it with `--force-lease` only after confirming the other run is dead.

## Invocation

For a bare `/orca-no-mistakes`, validate the user's already-committed changes. For `/orca-no-mistakes <task>`, complete and commit only that task first, preserving unrelated work, then validate it.

Pass the user's objective and constraints as an explicit single-line intent, not a file-list summary:

```bash
orca-no-mistakes run --repo /path/to/repo --intent "<user objective and constraints>"
```

The coordinator launches detached in a dedicated Orca terminal and returns immediately with `{"detached":true,"terminalHandle":"..."}`. This avoids blocking the caller and allows the originating session to receive and resolve decision gates via `orca orchestration gate-resolve`.

Available direct-run controls are `--base`, `--head`, `--force-lease`, `--notify`, `--reviewer-model`, `--fixer-model`, `--fixer-effort`, and `--max-fix-rounds`. Workers launch with the `opencode` agent on model `openai/gpt-5.6-luna` at max reasoning effort by default; the default maximum is 3 automated fix rounds, after which an exhaustion gate opens.

## Gates

The detached run returns immediately. When an Orca gate is pending, inspect and resolve the gate from the Orca app or a separate terminal:

```bash
orca orchestration gate-list --run <run-id> --status pending --json
orca orchestration gate-resolve --id <gate-id> --resolution <decision> --json
```

Decisions are `approve`, `fix`, `skip`, and `stop`; anything else fails closed.

A `fix` resolution supports targeted finding selection, per-finding instructions, and global guidance:

- Plain text syntax: `--resolution "fix: id1, id2: guidance"` or `--resolution "fix [id1, id2] - guidance"`.
- JSON syntax: `--resolution '{"action":"fix","findingIds":["id1"],"instructions":{"id1":"instruction"},"guidance":"global guidance"}'`.
- Resolving with `fix` without IDs targets all actionable findings. Unselected findings are evaluated in subsequent re-review passes.
- Copy IDs exactly from the gate question. If none of the supplied IDs match a reported finding, the run stops with `<stage> fix gate resolved with no matching findings`.
- Single-word guidance following `fix` without brackets (e.g. `--resolution "fix urgently"`) is parsed as a finding ID candidate and can fail closed if no such finding exists. For global guidance across all findings, use bracket syntax (e.g. `--resolution "fix [] - urgently"`), multi-word text (e.g. `--resolution "fix please handle urgently"`), or JSON.

Escalate every `ask-user` finding to the user before resolving it. Relay its ID, file and line when present, and full description. Do not choose `approve` or `skip` on the user's behalf.

Approving or skipping a stage records the decision in the domain ledger's gate audit and binds it into the attestation as a waiver — it never silently disappears.

## Result

On direct success the CLI prints JSON containing the attestation manifest:

```json
{"runId":"<orca-run-id>","steps":["intent","rebase","review","test","document","lint"],"custodyNote":"...","attestation":{"version":"1.3.0","guardrailMode":"strict","merkleRoot":"..."}}
```

Export and verify attestations, and prune retained evidence:

```bash
orca-no-mistakes attestation export <run-id-or-commit-sha> [--out manifest.json]
orca-no-mistakes attestation verify <manifest-file|run-id|commit-sha>
orca-no-mistakes prune [--before <date>] [--repo <path>] [--stranded]
```

On failure, report the error and Orca Run ID when available; retry only after addressing the blocker or receiving the user's decision.
