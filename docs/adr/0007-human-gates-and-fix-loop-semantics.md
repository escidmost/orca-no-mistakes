# 0007: Human Gates and Fix-Loop Semantics

To preserve safety-semantic parity during adversarial validation, human decision gates are asymmetric: validation stages permit `approve`, `fix`, `skip`, or `stop`, while delivery stages permit only `retry` or `stop`. Review auto-fixing is disabled by default to prevent silent self-approval, partial finding selection triggers dynamic re-evaluation upon re-check, and fix exhaustion opens a durable escalation gate rather than aborting or silently passing.
