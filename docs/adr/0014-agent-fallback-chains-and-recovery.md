---
status: accepted
date: 2026-08-21
scope: target architecture
implementation: not implemented
---

# Agent Fallback Chains and Preflight Failure Recovery

The runner must reliably resolve ordered agent fallback chains (e.g. `agent: [claude, codex, acp:gemini]`) during worker instantiation while guaranteeing clean resource teardown and unambiguous evidence provenance.

## Decision

- **Fallback Trigger Scope**:
  - Advancing along a fallback chain is strictly triggered by *preflight and infrastructure errors*: missing agent binary (`ENOENT`), authentication/credential failure, terminal readiness startup timeout (`WORKER_AGENT_READY_TIMEOUT_MS`), or initial dispatch rate-limit/quota errors (429).
  - Task execution errors (e.g., test failures, actionable review findings, or malformed stage reports emitted after task acceptance) do *not* trigger harness fallback.

- **Resource Settlement and Worktree Hygiene**:
  - Before attempting the next agent candidate, the failed worker is synchronously settled: the failed terminal is closed, any associated child worktree is deleted/pruned, and uncommitted modifications on the current worktree (for fixer roles) are cleanly reset.
  - The subsequent agent candidate receives a completely clean, isolated terminal and worktree instance.

- **Evidence Provenance & Diagnostics**:
  - Stage evidence records a structured `fallback_attempts` log containing candidate specifications, elapsed attempt duration, and structured error classifications.
  - The successful candidate is recorded in `resolved_agent`.

- **Exhaustion Handling**:
  - If all candidates in a configured fallback chain fail preflight, the coordinator fails closed, formats an aggregated diagnostic report across all failed candidates, and halts the stage (or opens an Orca exhaustion/error gate).
  - The runtime never silently substitutes an unconfigured baseline harness.

## Consequences

Guarantees high agent launch availability in heterogeneous developer environments while preventing worktree leaks, zombie worker execution, or corrupted evidence custody.
