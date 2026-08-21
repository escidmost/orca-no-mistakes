---
status: accepted
date: 2026-08-20
scope: target architecture
implementation: partially implemented
---

# Human Gates and Fix-Loop Semantics

Human decisions must distinguish adjudication from bypass, and failed delivery must never be approved as successful.

## Decision

- A validation gate may offer `approve`, `fix`, `skip`, or `stop`, but `skip` is available only when the effective policy marks that stage optional. Approval satisfies an explicit human-judgment requirement; it does not convert a failed required check into success.
- A delivery gate offers only `retry` or `stop`.
- Review findings are not automatically repaired by default. Mechanical auto-fix may be enabled by trusted policy for other stages.
- A fix response identifies the selected findings and optional guidance. The next check re-evaluates the whole stage rather than assuming unselected findings disappeared.
- When the configured fix-round limit is reached with actionable findings remaining, the coordinator opens an exhaustion gate. Passed remains unavailable until the findings are resolved under policy.

## Consequences

Gate decisions are durable evidence with gate ID, selected option, actor, time, and affected findings. Current implementation differences, including automatic all-auto-fix repairs and immediate failure on exhaustion, are documented in [`docs/current-architecture.md`](../current-architecture.md).
