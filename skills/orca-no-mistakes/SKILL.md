---
name: orca-no-mistakes
description: Validate committed code changes through the Orca no-mistakes pipeline before delivery. Use when the user asks to run orca-no-mistakes, validate or gate changes, push safely, or invokes /orca-no-mistakes.
user-invocable: true
---

# Orca No-Mistakes

Drive the implemented `orca-no-mistakes` CLI. It runs:

`intent -> rebase -> review -> test -> document -> lint -> push -> pr -> ci`

If your assigned task explicitly says you are already a no-mistakes stage worker, complete only that stage and return its structured report. Do not start a nested pipeline.

## Preconditions

- Work is committed on a clean, named feature branch.
- The branch is not the detected default branch.
- The repository has an `origin` remote.
- Orca is running and `opencode` and repository-host tooling are authenticated.
- The current CLI has no branch lease. Before starting, inspect `orca orchestration run-list --json` and the Orca Runs view for an active run on the same repository, branch, and HEAD.

Install the local Git gate once per repository when needed:

```bash
orca-no-mistakes install --repo /path/to/repo
```

Use `--force` only to replace an existing unrelated `orca-no-mistakes` remote intentionally.

## Invocation

For a bare `/orca-no-mistakes`, validate the user's already-committed changes. For `/orca-no-mistakes <task>`, complete and commit only that task first, preserving unrelated work, then validate it.

Pass the user's objective and constraints as intent, not a file-list summary:

```bash
orca-no-mistakes run --repo /path/to/repo --intent "<user objective and constraints>"
```

Use the local Git gate only when the user asked to push:

```bash
orca-no-mistakes push --repo /path/to/repo --intent "<user objective and constraints>"
```

Direct `run` and the Git gate launch the coordinator detached in a dedicated Orca terminal and return immediately with `{"detached":true,"terminalHandle":"..."}`. This avoids blocking the caller and allows the originating session to receive and resolve decision gates via `orca orchestration gate-resolve`. (Pass `--attached` to run synchronously in the foreground).

Available direct-run controls are `--attached`, `--base`, `--head`, `--notify`, `--reviewer-model`, `--fixer-model`, `--fixer-effort`, and `--max-fix-rounds`. Runs are detached by default; passing `--attached` provides synchronous execution. Workers launch with the `opencode` agent on model `openai/gpt-5.6-luna` at max reasoning effort by default; the default maximum is 3 automated fix rounds, after which an exhaustion gate opens.

## Gates

A detached run returns before any gate opens; an `--attached` run waits while an Orca gate is pending. Inspect and resolve the gate from the Orca app or a separate terminal:

```bash
orca orchestration gate-list --run <run-id> --status pending --json
orca orchestration gate-resolve --id <gate-id> --resolution <decision> --json
```

Validation-stage decisions are `approve`, `fix`, `skip`, and `stop`. Delivery-stage decisions are only `retry` and `stop`.

A `fix` resolution supports targeted finding selection, per-finding instructions, and global guidance:
- Plain text syntax: `--resolution "fix: id1, id2: guidance"` or `--resolution "fix [id1, id2] - guidance"`.
- JSON syntax: `--resolution '{"action":"fix","findingIds":["id1"],"instructions":{"id1":"instruction"},"guidance":"global guidance"}'`.
- Resolving with `fix` without IDs targets all actionable findings. Unselected findings are evaluated in subsequent re-review passes.
- Copy IDs exactly from the gate question. If none of the supplied IDs match a reported finding, the run stops with `<stage> fix gate resolved with no matching findings`.

Escalate every `ask-user` finding to the user before resolving it. Relay its ID, file and line when present, and full description. Do not choose `approve` or `skip` on the user's behalf.

Current behavior automatically fixes reports whose actionable findings are all `auto-fix`. After the configured fix-round limit, the coordinator opens an exhaustion gate for operator direction. Current `approve` and `skip` decisions allow a validation stage to complete with findings; they do not establish the target architecture's `Passed` proof.

## Result

On direct success the CLI prints JSON:

```json
{"runId":"<orca-run-id>","steps":["intent","rebase","review","test","document","lint","push","pr","ci"]}
```

This means the current pipeline completed all stages. It is not the target commit-bound `Passed` attestation described by the ADRs. On failure, report the error and Orca Run ID when available; retry only after addressing the blocker or receiving the user's decision.
