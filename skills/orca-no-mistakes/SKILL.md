---
name: orca-no-mistakes
description: Validate committed code changes through the Orca no-mistakes pipeline before delivery. Use when the user asks to run orca-no-mistakes, validate or gate changes, push safely, or invokes /orca-no-mistakes.
user-invocable: true
---

# Orca No-Mistakes

Drive the implemented `orca-no-mistakes` CLI. It runs the nine core validation and delivery stages, plus any command gates the trusted base declares ([Repository command gates](../../docs/current-architecture.md#repository-command-gates)):

`intent -> rebase -> review -> test -> document -> lint -> push -> pr -> ci`

The run validates candidate changes, publishes them to GitHub, publishes the owned title/body report, and notifies the originating session of readiness. It then monitors CI checks and mergeability until an authoritative matching MERGED observation upgrades the receipt. Success produces a completion attestation manifest (`completionAttestation`) bound to the validated commit.

If your assigned task explicitly says you are already a no-mistakes stage worker, complete only that stage and return its structured report. Do not start a nested pipeline.

## Preconditions

- Work is committed on a clean, named feature branch.
- The branch is not the detected default branch.
- The repository has an `origin` remote.
- The repository has one successful `orca-no-mistakes init` (shared by every worktree and branch) with a persisted GitHub publication route whose forge, stable base/head repository identities, owner, identity fingerprint, and canonical transport match the run. The GitHub CLI (`gh`) is installed with configured authentication (`GH_TOKEN`, `GITHUB_TOKEN`, or stored `gh` account), and Git push authentication works.
- Orca is running and CLI tooling for the configured worker agents is authenticated. The installed template selects `claude`; the runner falls back to `opencode` if no agent is configured.
- No other run holds the branch semantic lease. A conflicting run fails closed with `branch <name> is already leased by run <id>`; reclaim it with `--force-lease` only after confirming the other run is dead.

## Invocation

Run `orca-no-mistakes init --repo /path/to/repo` once per repository to install repository-local admission and persist the publication route. New worktrees and branches need no further init; follow the [Local gate](../../README.md#local-gate) workflow.

For a bare `/orca-no-mistakes`, validate the user's already-committed changes. For `/orca-no-mistakes <task>`, complete and commit only that task first, preserving unrelated work, then validate it.

Pass the user's objective and constraints as an explicit single-line intent, not a file-list summary:

```bash
orca-no-mistakes run --repo /path/to/repo --intent "<user objective and constraints>"
orca-no-mistakes run --repo /path/to/repo --resume <failed-run-id>
```

A newly admitted direct run launches detached in a dedicated Orca terminal and returns `{"detached":true,"terminalHandle":"..."}`. If its admission is already being handled or accepted, the command returns `{"admissionId":"...","replayed":true,"runId":"..."}` immediately instead (`runId` can be `null` until binding); see [Gates and outcomes](../../README.md#gates-and-outcomes). A detached launch avoids blocking the caller and allows the originating session to receive decision notifications and resolve gates via `orca orchestration send`.

Use `--resume` only for a failed run whose clean initiating checkout is still at its original submission commit. Detached resume reconstructs the isolated gate worktree at the last durable checkpoint, retains the original evidence and resolved gate decisions, and runs only the stages that still need validation. Keeping the initiating checkout at the submission commit lets successful custody transfer advance it automatically.

Available direct-run controls are `--base`, `--head`, `--force-lease`, `--notify`, `--resume`, `--tui`, `--no-tui`, `--reviewer-model`, `--fixer-model`, `--fixer-effort`, and `--max-fix-rounds`. `--no-tui` emits bounded semantic progress on stderr while attached stdout remains reserved for the final JSON result. Workers use their configured agent's model and effort defaults unless explicitly overridden. The default maximum is 3 automated fix rounds, after which an exhaustion gate opens.

## Gates

The detached run returns immediately. When an Orca gate is pending, the coordinator sends a gate notification to the originating terminal with the exact `orca orchestration send` command to resolve it. The coordinator generates an authenticated `question` message addressed with `--to`/`--run`, the exact subject `no-mistakes gate response`, and a JSON body containing `gateId` and `resolution`. Agents must run that emitted command verbatim, substituting only the chosen `<resolution>`. Do not use static or handwritten command templates.

Finding-gate choices are `approve`, `fix`, `skip`, and `stop`. The `ci` stage gate offers only `fix` and `stop`. Its triggers are the decision table in [ADR-0016](../../docs/adr/0016-ci-stage-monitoring-and-merge-settlement.md): check findings open only once nothing is pending (pending or absent checks keep polling), and the separate idle-timeout gate carries a single `ci-timeout` finding. Nothing is auto-fixed, so relay the findings to the user, and answer `fix` once they have acted externally (reran checks, resolved the conflict, or merged) to resume monitoring. Durable resume-gate choices (opened when an attempt stops after a resumable failure) are `resume` and `stop`. A worker-question relay gate offers `reply` and `stop`: answer `reply: <the actual answer>` to reply to the running worker in place, since a separate status message is not forwarded (see [Findings and gates](../../docs/current-architecture.md#findings-and-gates)). Anything else fails closed.

A `fix` resolution supports targeted finding selection and global guidance:

- Plain text syntax: `fix: id1, id2: guidance` or `fix [id1,id2] - guidance`.
- Resolving with `fix` without IDs targets all actionable findings. When explicit IDs are selected, unselected open findings are immediately approved for the current candidate rather than deferred (see [Findings and gates](../../docs/current-architecture.md#findings-and-gates)).
- Before sending explicit IDs, escalate every actionable `ask-user` finding, including any you intend to leave unselected. Obtain an explicit fix or approve-as-is decision for each; do not send a targeted resolution while any such decision is outstanding. Omitting an `ask-user` ID is an approval, not a way to defer its decision.
- Copy IDs exactly from the gate question. If none of the supplied IDs match a reported finding, the run stops with `<stage> fix gate resolved with no matching findings`.
- Single-word guidance following `fix` without brackets (e.g. `fix urgently`) is parsed as a finding ID candidate and can fail closed if no such finding exists. For global guidance across all findings, use bracket syntax (e.g. `fix [] - urgently`) or multi-word text (e.g. `fix please handle urgently`).

Escalate every `ask-user` finding to the user before resolving it. Relay its ID, file and line when present, and full description. Do not choose `approve` or `skip` on the user's behalf.

Approving or skipping a stage records the decision in the domain ledger's gate audit and binds it into the attestation as a waiver — it never silently disappears.

## Result

The attached coordinator prints JSON on success, including the completion attestation under `completionAttestation`. Detached callers receive the outcome through Orca notifications. This abbreviated example shows a run without additional command gates; `version` identifies the manifest schema:

```json
{"runId":"<orca-run-id>","steps":["intent","rebase","review","test","document","lint","push","pr","ci"],"verdict":"passed","custodyNote":"...","completionAttestation":{"version":"2.0.0","assuranceClaims":["configured-pipeline-completed","candidate-publication-verified","pull-request-bound"],"merkleRoot":"..."}}
```

Export and verify attestations, and prune retained evidence:

```bash
orca-no-mistakes attestation export <run-id-or-commit-sha> [--out manifest.json] [--repo <path>]
orca-no-mistakes attestation verify <manifest-file|run-id|commit-sha> [--repo <path>]
orca-no-mistakes prune [--before <date>] [--repo <path>]
orca-no-mistakes prune --stranded [--repo <path>]
```

`prune --stranded` reaps gate or direct-run resources only when their owning coordinator is proven gone. It first anchors the recorded HEAD at `refs/no-mistakes/recover/<run-id>` and retains the marker if ownership or preservation cannot be verified; direct recovery never removes the operator checkout or branch.

On failure, report the error and Orca Run ID when available; retry only after addressing the blocker or receiving the user's decision.
