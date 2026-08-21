---
status: accepted
date: 2026-08-21
scope: target architecture
implementation: partially implemented
---

# Hierarchical Configuration Schema and Precedence Hierarchy

The runner requires a deterministic, hierarchical configuration system allowing operators to configure defaults, stage-level rules, role-level overrides (reviewers and fixers), agent fallback chains, timeouts, and CLI argument injections.

## Decision

- **Precedence Hierarchy**: Configuration layers resolve in a 5-tier precedence order:
  1. CLI Flags (highest)
  2. Stage Role Config (`stages.<stage>.<role>`)
  3. Stage Default Config (`stages.<stage>`)
  4. Repository Config (`.orca/no-mistakes.yaml` extracted from trusted base ref)
  5. User Global Config (`~/.config/orca-no-mistakes/config.yaml`) (lowest)

- **Merge Semantics**:
  - Dictionaries/objects are deep-merged across precedence tiers.
  - Primitives, booleans, and arrays (including agent fallback lists) use scalar replacement.

- **Strict Validation & Failure Mode**:
  - Configuration files are strictly validated using Zod (`z.strictObject()`).
  - Unknown properties or invalid schemas fail closed immediately; the runner never silently falls back to base defaults (per ADR-0003).

- **Agent & Fallback Chains**:
  - Agents can be specified as a scalar string (`claude`, `acp:gemini`), a structured `AgentSpec` object, or an ordered non-empty array of specs representing a sequential fallback chain.

- **Auto-Fix & Reviewer Constraints**:
  - `auto_fix` is configured via `{ enabled: boolean, max_rounds: number, allow_review_autofix: boolean }`.
  - In adherence to ADR-0007, `allow_review_autofix` defaults to `false`.

- **CLI-Injected Harnesses**:
  - `agent_args_override` provides a typed map from harness name (`opencode`, `grok`, `gemini`, etc.) to custom CLI argument arrays or key-value environment maps.

## Consequences

This unblocks ONM-30 (unified agent launch adapter) and ONM-31 (trusted base ref config extraction and merging engine). Runtime evidence captures the effective-policy hash derived from the merged configuration.

The schema and the precedence resolver are implemented in `scripts/config.ts`. Configuration-file discovery, trusted base ref extraction, runner wiring, and effective-policy hashing are not implemented, so the runner still takes its per-role settings from CLI flags and built-in defaults; see [`docs/current-architecture.md`](../current-architecture.md).
