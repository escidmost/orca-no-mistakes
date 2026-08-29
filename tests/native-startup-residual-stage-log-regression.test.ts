import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CliOrca, type WorkerLaunch } from "../scripts/orca-no-mistakes.ts";
import { StageLog } from "../scripts/ledger.ts";

test("failed native startup captures a residual terminal transcript", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-native-residual-log-"));
  const fakeOrca = path.join(temp, "orca");
  const chunks: string[] = [];
  const stageLog = {
    async append(chunk: string): Promise<void> {
      chunks.push(chunk);
    },
  } as StageLog;
  try {
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'orchestration' && args[1] === 'worker-start') {
  out({ residualResources: [{ kind: 'terminal', handle: 'residual-terminal' }] })
  process.exitCode = 1
} else if (args[0] === 'orchestration' && args[1] === 'dispatch-show') {
  out({})
} else if (args[0] === 'terminal' && args[1] === 'read') {
  out({ terminal: { tail: ['native-residual-startup'], oldestCursor: 0, nextCursor: 1, latestCursor: 1 } })
} else {
  out({ ok: true })
}
`,
    );
    await chmod(fakeOrca, 0o755);
    const orca = new CliOrca({ command: fakeOrca, cwd: temp });
    const launch: WorkerLaunch = {
      agent: { harness: "cursor" },
      logPath: path.join(temp, "review_r1.log"),
      name: "reviewer",
      prompt: "Review now.",
      role: "reviewer",
      stage: "review",
      stageLog,
      worktree: "current",
    };

    await assert.rejects(orca.startWorker("task-1", launch), /worker-start failed/);
    assert.match(chunks.join(""), /native-residual-startup/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
