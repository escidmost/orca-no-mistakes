# Trusted Validation Policy Model

To prevent untrusted proposed changes from silently weakening or subverting validation while enabling routine project evolution, the pipeline enforces a guarded policy evolution model. Reviewer prompts, agent execution constraints, and CI check requirements are immutably compiled from the trusted base commit and coordinator engine with untrusted data framing, while branch modifications to test assertions, linter configurations, and documentation are reconciled against the user's declared intent and gated on any unexplained relaxation.

## Status

Accepted

## Considered Options

- **Strict Base-Only Policy Locking**: Sourcing all test files, linter scripts, and configs exclusively from the base commit was rejected because feature branches frequently need to add new tests, bump dependencies, update linters, and evolve documentation.
- **Unchecked Branch-Owned Policy**: Allowing proposed changes to freely define and alter test suites, linter scripts, and review prompts was rejected because untrusted branches or compromised agents could disable checks, weaken assertions, or inject prompt overrides.
- **Zero Agent Discretion vs Full Agent Discretion**: Giving agents zero discretion slowed diagnostic triage, while full discretion allowed hallucinated or unchecked pass summaries; bounded diagnostic discretion with deterministic coordinator invariant execution at stage boundaries was chosen instead.
- **Silent Fallback on Malformed Policy**: Silently falling back to base defaults on unparseable configs was rejected because it masks configuration errors; failing closed at an explicit decision gate ensures full auditability.

## Consequences

- The coordinator constructs reviewer and checker prompts from trusted engine definitions, treating the branch diff, `AGENTS.md`, and instructions strictly as untrusted data payloads.
- Automated fixer agents are constrained to modifying implementation source code and adding new regression tests; they are forbidden from mutating existing test assertions, lint configs, or coordinator prompts.
- Any deletion or weakening of existing test assertions or linter rules must align with declared user intent; unexplained relaxations surface as `ask-user` findings (`severity: error`).
- The local validation ledger records the trusted base SHA, verified test execution commands, intent string, policy diff summary, and audit records of any approved policy gates.
