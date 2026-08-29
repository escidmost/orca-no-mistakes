import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CliOrca, type WorkerLaunch } from "../scripts/orca-no-mistakes.ts";
import { StageLog } from "../scripts/ledger.ts";

process.env.WORKER_SHELL_STARTUP_DELAY_MS ??= "0";

function isolateHome(temp: string): () => void {
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = temp;
  return () => {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
  };
}

test("native startup makes a final terminal probe after settling", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-native-final-probe-"));
  const fakeOrca = path.join(temp, "orca");
  const firstProbePath = path.join(temp, "first-probe");
  const terminalPath = path.join(temp, "terminal-ready");
  const closePath = path.join(temp, "terminal-closed");
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
import fs from 'node:fs'
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'orchestration' && args[1] === 'worker-start') {
  const deadline = Date.now() + 2000
  while (!fs.existsSync(${JSON.stringify(firstProbePath)}) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
  fs.writeFileSync(${JSON.stringify(terminalPath)}, '1')
  console.log('invalid receipt')
  process.exitCode = 1
} else if (args[0] === 'orchestration' && args[1] === 'dispatch-show') {
  if (fs.existsSync(${JSON.stringify(terminalPath)})) out({ dispatch: { assignee_handle: 'late-terminal' } })
  else {
    fs.writeFileSync(${JSON.stringify(firstProbePath)}, '1')
    out({})
  }
} else if (args[0] === 'terminal' && args[1] === 'read') {
  out({ terminal: { tail: ['late-native-startup'], oldestCursor: 0, nextCursor: 1, latestCursor: 1 } })
} else if (args[0] === 'terminal' && args[1] === 'close') {
  fs.writeFileSync(${JSON.stringify(closePath)}, '1')
  out({ ok: true })
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
    assert.equal(await readFile(firstProbePath, "utf8"), "1");
    assert.match(chunks.join(""), /late-native-startup/);
    assert.equal(await readFile(closePath, "utf8"), "1");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("watchdog rejects a disconnected terminal during a silent poll", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-watchdog-disconnect-"));
  const fakeOrca = path.join(temp, "orca");
  const dispatchedPath = path.join(temp, "dispatched");
  const showCountPath = path.join(temp, "show-count");
  const restoreHome = isolateHome(temp);
  const previousIdle = process.env.WORKER_IDLE_TIMEOUT_MS;
  process.env.WORKER_IDLE_TIMEOUT_MS = "300";
  try {
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'orchestration' && args[1] === 'run-create') {
  out({ run: { id: 'watchdog-disconnect-run' } })
} else if (args[0] === 'terminal' && args[1] === 'create') {
  out({ terminal: { handle: 'worker-terminal' } })
} else if (args[0] === 'terminal' && args[1] === 'show') {
  if (!fs.existsSync(${JSON.stringify(dispatchedPath)})) {
    out({ terminal: { connected: true, lastOutputAt: 1, preview: 'ready', title: 'OpenCode' } })
  } else {
    const count = fs.existsSync(${JSON.stringify(showCountPath)}) ? Number(fs.readFileSync(${JSON.stringify(showCountPath)}, 'utf8')) : 0
    fs.writeFileSync(${JSON.stringify(showCountPath)}, String(count + 1))
    if (count === 0 || count % 2 === 0) out({ terminal: { connected: true, lastOutputAt: 1 } })
    else out({ terminal: { connected: false, lastOutputAt: 1 } })
  }
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  fs.writeFileSync(${JSON.stringify(dispatchedPath)}, '1')
  out({ dispatch: { id: 'dispatch-1', status: 'dispatched' }, injected: true, preamble: 'authenticated' })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
  out({ connectionLost: true })
} else {
  out({ ok: true })
}
`,
    );
    await chmod(fakeOrca, 0o755);
    const orca = new CliOrca({ command: fakeOrca, cwd: temp });
    await orca.createRun("watchdog disconnect");

    await assert.rejects(
      orca.startWorker("task-1", {
        name: "reviewer",
        prompt: "Review now.",
        role: "reviewer",
        stage: "review",
        worktree: "current",
      }),
      /terminal disconnected/,
    );
  } finally {
    if (previousIdle === undefined) delete process.env.WORKER_IDLE_TIMEOUT_MS;
    else process.env.WORKER_IDLE_TIMEOUT_MS = previousIdle;
    restoreHome();
    await rm(temp, { recursive: true, force: true });
  }
});
