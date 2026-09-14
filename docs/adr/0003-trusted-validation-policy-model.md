---
status: accepted
date: 2026-08-20
scope: target architecture
implementation: partially implemented
---

# Trusted Validation Policy Model

The proposed branch is untrusted input, but legitimate changes may need to add tests or alter validation configuration. The target pipeline therefore derives an effective policy from the trusted base plus an explicitly approved policy delta.

## Decision

- Coordinator-owned prompts, execution constraints, and required check definitions come from the trusted base and coordinator engine. Branch diffs, repository instructions, and task text are framed as untrusted data.
- Changes that add, remove, or weaken existing tests, lint rules, documentation rules, reviewer prompts, or required checks form a policy delta.
- The coordinator reconciles that delta against declared intent. Unexplained relaxations fail closed at an `ask-user` gate.
- Approval records a precise policy delta. The coordinator computes a new effective-policy hash and reruns every affected validation stage against that policy before `checks-passed` is available.
- Fixers may alter an existing policy artifact only when the approved delta specifically authorizes that change. Malformed policy never silently falls back to base defaults.

## Consequences

Evidence records the trusted base SHA, approved delta, effective-policy hash, intent, and commands executed. This resolves policy evolution without treating either the base or proposed branch as the sole authority.
