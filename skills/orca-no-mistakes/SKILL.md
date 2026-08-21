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

Use `--force` only to replace an existing unrelated `no-mistakes` remote intentionally.

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

Direct `run` supplies a meaningful exit status. The Git gate runs synchronously, but Git may still report a successful push when the hook's pipeline fails; inspect the Orca Run after `push`.

Available direct-run controls are `--base`, `--head`, `--reviewer-model`, `--fixer-model`, `--fixer-effort`, and `--max-fix-rounds`. Workers launch with the `opencode` agent on model `opencode-go/ox-alpha-free` at max reasoning effort by default; the default maximum is three fix rounds.

## Gates

The direct command waits while an Orca gate is pending. Inspect and resolve it from the Orca app or a separate terminal:

```bash
orca orchestration gate-list --run <run-id> --status pending --json
orca orchestration gate-resolve --id <gate-id> --resolution <decision> --json
```

Validation-stage decisions are `approve`, `fix`, `skip`, and `stop`. A fix may include guidance, for example `--resolution "fix: preserve the public API"`. Delivery-stage decisions are only `retry` and `stop`.

Escalate every `ask-user` finding to the user before resolving it. Relay its ID, file and line when present, and full description. Do not choose `approve` or `skip` on the user's behalf.

Current behavior automatically fixes reports whose actionable findings are all `auto-fix`. After the configured fix-round limit, the run fails rather than opening an exhaustion gate. Current `approve` and `skip` decisions allow a validation stage to complete with findings; they do not establish the target architecture's `Passed` proof.

## Result

On direct success the CLI prints JSON:

```json
{"runId":"<orca-run-id>","steps":["intent","rebase","review","test","document","lint","push","pr","ci"]}
```

This means the current pipeline completed all stages. It is not the target commit-bound `Passed` attestation described by the ADRs. On failure, report the error and Orca Run ID when available; retry only after addressing the blocker or receiving the user's decision.
