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
  1. *Native Orchestration*: Native Orca `worker-start` preferences are used for Cursor.
  2. *Terminal Spawn + Authenticated Dispatch*: For CLI harnesses (`claude`, `codex`, `opencode`, `grok`, `gemini`, `kimi`), the adapter spawns an isolated terminal and sends the agent startup command formatted with configured model, effort/variant, and `agent_args_override`. Fresh terminals wait 20 seconds when the controller's default shell is fish so hidden panes can finish fish's ten-second terminal-query timeout and settle before command delivery; `WORKER_SHELL_STARTUP_DELAY_MS` overrides this compatibility delay. OpenCode, Grok, and Gemini use injected dispatch. Fresh Claude, Codex, Antigravity, and Kimi workers create the authenticated dispatch without injection and store its preamble in a protected artifact. Claude, Codex, and Antigravity launch with a short instruction to read that file; Kimi uses noninteractive `--prompt` without the incompatible `--auto` flag, then briefly audits startup output so immediate argument, authentication, or terminal failures remain preflight failures. Retained CLI sessions use supervised `worker-start --terminal`, which validates that Orca still recognizes an agent process before delivering the authenticated task. Codex uses `model_reasoning_effort` plus `--dangerously-bypass-approvals-and-sandbox`. This keeps fresh-launch preambles out of native prompt-injection stalls and argv size limits without trusting a retained terminal title.
  3. *ACP Target Execution*: For `acp:<target>` harnesses, the adapter invokes the `acpx` execution runner against the target server.

- **Modular Readiness Detection**:
  - Readiness for CLI-injected terminals is detected via per-harness matchers inspecting terminal title state and preview content. Titles are primary; Codex also accepts its active working indicator plus model/effort footer because a hidden pane can retain its worktree title after Codex starts processing.
  - A configurable startup deadline (`WORKER_AGENT_READY_TIMEOUT_MS`) prevents unbounded hangs; failure immediately triggers clean worker termination and worktree deallocation.

- **Prompt Guardrails and Untrusted Data Framing**:
  - Coordinator-owned system instructions and stage prompts are framed as untrusted data in injected dispatches. Worker outputs are ingested strictly as JSON stage reports.

## Consequences

Enables multi-harness worker delegation and prepares the runtime for sequential agent fallback chains (ONM-32).
