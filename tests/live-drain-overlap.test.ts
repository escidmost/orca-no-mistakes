import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CliOrca } from "../scripts/orca-no-mistakes.ts";

process.env.WORKER_SHELL_STARTUP_DELAY_MS ??= "0";

test("heartbeat drain awaits overlapping live log capture", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-live-drain-overlap-"));
  const fakeOrca = path.join(temp, "orca");
  const heartbeatCountPath = path.join(temp, "heartbeat-count");
  const heartbeatProbePath = path.join(temp, "heartbeat-probe");
  const previousUserHome = process.env.HOME;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const home = path.join(temp, "home");
  process.env.HOME = home;
  process.env.ORCA_NO_MISTAKES_HOME = home;
  try {
    const runId = "live-drain-overlap-run";
    const evidence = path.join(home, "artifacts", runId);
    const reportPath = path.join(evidence, "review.json");
    const logPath = path.join(evidence, "review.log");
    await mkdir(evidence, { recursive: true });
    await writeFile(reportPath, JSON.stringify({ findings: [], summary: "clean" }));
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
const cursor = args.includes('--cursor') ? args[args.indexOf('--cursor') + 1] : undefined
if (args[0] === 'orchestration' && args[1] === 'run-create') {
  out({ run: { id: ${JSON.stringify(runId)} } })
} else if (args[0] === 'terminal' && args[1] === 'create') {
  out({ terminal: { handle: 'worker-terminal' } })
} else if (args[0] === 'terminal' && args[1] === 'read') {
  if (cursor === undefined) out({ terminal: { tail: ['done'], oldestCursor: 0, nextCursor: 3, latestCursor: 3 } })
  else if (cursor === '0') {
    const deadline = Date.now() + 10000
    while (!fs.existsSync(${JSON.stringify(heartbeatCountPath)})) {
      if (Date.now() >= deadline) throw new Error('heartbeat never arrived')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await new Promise(resolve => setTimeout(resolve, 600))
    out({ terminal: { tail: ['npm test', 'ok 12 passed'], nextCursor: 2, latestCursor: 3 } })
  } else if (cursor === '2') out({ terminal: { tail: ['done'], nextCursor: 3, latestCursor: 3 } })
  else out({ terminal: { tail: [], nextCursor: Number(cursor), latestCursor: Number(cursor) } })
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, title: 'OpenCode', preview: 'ready', lastOutputAt: 1, worktreeId: 'worker-worktree' } })
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  out({ dispatch: { id: 'dispatch-1', status: 'dispatched' }, injected: true, preamble: 'authenticated' })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  const count = fs.existsSync(${JSON.stringify(heartbeatCountPath)}) ? Number(fs.readFileSync(${JSON.stringify(heartbeatCountPath)}, 'utf8')) : 0
  fs.writeFileSync(${JSON.stringify(heartbeatCountPath)}, String(count + 1))
  if (count === 0) {
    out({ deliveryId: 'heartbeat', messages: [{ type: 'heartbeat', payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'dispatch-1' }) }] })
  } else {
    fs.writeFileSync(${JSON.stringify(heartbeatProbePath)}, fs.existsSync(${JSON.stringify(logPath)}) ? fs.readFileSync(${JSON.stringify(logPath)}, 'utf8') : '')
    out({ deliveryId: 'done', messages: [{ type: 'worker_done', payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'dispatch-1', outcome: 'succeeded', reportPath: ${JSON.stringify(reportPath)} }) }] })
  }
} else {
  out({ ok: true })
}
`,
    );
    await chmod(fakeOrca, 0o755);

    const orca = new CliOrca({ command: fakeOrca, cwd: temp });
    await orca.createRun("live drain overlap");
    const worker = await orca.startWorker("task-1", {
      logPath,
      name: "reviewer",
      prompt: "Review now.",
      role: "reviewer",
      stage: "review",
      worktree: "current",
    });

    assert.match(await readFile(heartbeatProbePath, "utf8"), /npm test/);
    await orca.finishWorker(worker, "release");
  } finally {
    if (previousUserHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousUserHome;
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});
