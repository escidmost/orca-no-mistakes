# Choose the Trusted Validation Policy Model

Linear: [ONM-6](https://linear.app/escidmore/issue/ONM-6/choose-the-trusted-validation-policy-model)

Type: grilling
Status: resolved
Blocked by: 01

## Question

Which test, lint, format, documentation, review-path, agent, and CI policies must come from a trusted base commit, what may agents choose dynamically, and how should unreadable or conflicting policy fail?

## Answer

* **Guarded Policy Evolution**: Validation policies operate under a guarded evolution model. The coordinator's enforcement harness, reviewer prompt templates, agent model/budget constraints, and CI check requirements (`no_ci: true`) are immutably sourced from the trusted base commit and coordinator engine. Feature branches are permitted to add new tests, modify configurations, and update documentation.
* **Untrusted Data Framing**: The coordinator compiles reviewer and checker prompts using trusted engine definitions, framing the proposed branch diff, `AGENTS.md`, and task instructions strictly as untrusted data payloads to prevent prompt injection and policy subversion.
* **Adversarial Intent Reconciliation**: All branch modifications or deletions of existing test assertions, linter rules, or validation constraints are cross-referenced against the user's declared `--intent` by an adversarial review agent. Unexplained or undocumented policy relaxations surface as blocking `ask-user` findings (`severity: error`).
* **Fixer Guardrails & Discretion**: Fixer agents may modify implementation code and author new regression tests, but are strictly forbidden from altering pre-existing test assertions, lint configurations, or coordinator prompts. Agents possess bounded diagnostic discretion for focused triage, but final `Passed` requires deterministic coordinator suite execution.
* **Gated Fail-Closed Semantics**: Malformed, missing, unparseable, or conflicting policy configurations fail closed, halting automated progression and parking at an explicit `ask-user` decision gate detailing the exact syntax error or policy conflict for operator resolution.
* **Ledger Attestation**: The local domain ledger permanently records the trusted base commit SHA, candidate commit SHA, policy diff summary, verified execution commands, declared user intent, and audit records of all approved policy decision gates.

Decision context: ADR `docs/adr/0003-trusted-validation-policy-model.md`.

