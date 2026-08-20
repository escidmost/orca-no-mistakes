---
name: no-mistakes
description: Run the nine-stage Orca adversarial validation and delivery pipeline.
disable-model-invocation: true
---

# No Mistakes

Use this skill only when the user invokes `/no-mistakes`.

1. Require a concise, explicit statement of intent. If the invocation does not make the intended behavior clear, ask one question before starting.
   Treat intent as specific to this invocation; never read it from or persist it to repository configuration or environment variables.
2. Confirm the current branch contains only committed work and is not the default branch. Do not edit the worktree after starting the pipeline.
3. Run:

   ```bash
   orca-no-mistakes run --repo "$(git rev-parse --show-toplevel)" --intent "<explicit intent>"
   ```

4. Leave the command running while Orca coordinates the nine ordered stages: intent, rebase, review, test, document, lint, push, PR, and CI.
5. Human-owned findings appear as Orca decision gates. Present the gate exactly as written; do not resolve it without the user's decision.
6. Report success only when the command exits zero with all nine stages complete. On failure, report the stopped stage and leave recovery to a new invocation after the issue is corrected.

Optional flags: `--base <branch>`, `--reviewer-model <model>`, `--fixer-model <model> --fixer-effort <level>`, and `--max-fix-rounds <count>`.
