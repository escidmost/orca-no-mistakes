---
status: accepted
date: 2026-08-21
scope: target architecture
implementation: partially implemented
---

# Unified Agent Launch Adapter for Heterogeneous Harnesses

The runner must launch worker agents across diverse agent harnesses without compromising isolation, terminal readiness detection, or untrusted data framing.

## Decision

- **Tri-Modal Launch Dispatch Strategy**:
  1. *Native Orchestration*: Native Orca `worker-start` preferences are used for supported harnesses (`claude`, `codex`, `cursor`).
  2. *Terminal Spawn + Injected Dispatch*: For CLI harnesses (`opencode`, `grok`, `gemini`), the adapter spawns an isolated terminal, sends the agent startup command formatted with configured model, effort/variant, and `agent_args_override`, awaits readiness, and dispatches instructions via `orca orchestration dispatch --task <taskId> --to <terminalHandle> --inject --return-preamble`.
  3. *ACP Target Execution*: For `acp:<target>` harnesses, the adapter invokes the `acpx` execution runner against the target server.

- **Modular Readiness Detection**:
  - Readiness for CLI-injected terminals is detected via per-harness matchers inspecting terminal title state and preview content (e.g., verifying `OpenCode` / `OC |` titles and absence of active interrupt markers for OpenCode, and dedicated prompt signatures for Grok/Gemini).
  - A configurable startup deadline (`WORKER_AGENT_READY_TIMEOUT_MS`) prevents unbounded hangs; failure immediately triggers clean worker termination and worktree deallocation.

- **Prompt Guardrails and Untrusted Data Framing**:
  - Coordinator-owned system instructions and stage prompts are framed as untrusted data in injected dispatches. Worker outputs are ingested strictly as JSON stage reports.

## Consequences

Enables multi-harness worker delegation and prepares the runtime for sequential agent fallback chains (ONM-32).
