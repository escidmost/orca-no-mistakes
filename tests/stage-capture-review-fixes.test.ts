import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CliOrca,
  type WorkerLaunch,
} from "../scripts/orca-no-mistakes.ts";
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

test("native startup binds its terminal before readiness completes", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-native-terminal-log-"));
  const fakeOrca = path.join(temp, "orca");
  const startingPath = path.join(temp, "starting");
  const readyPath = path.join(temp, "ready");
  const capturedPath = path.join(temp, "captured-before-ready");
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
const cursor = args.includes('--cursor') ? args[args.indexOf('--cursor') + 1] : undefined
if (args[0] === 'orchestration' && args[1] === 'worker-start') {
  fs.writeFileSync(${JSON.stringify(startingPath)}, '1')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  fs.writeFileSync(${JSON.stringify(readyPath)}, '1')
  out({ residualResources: { terminalHandles: ['native-terminal'], worktreeIds: [] } })
  process.exitCode = 1
} else if (args[0] === 'orchestration' && args[1] === 'dispatch-show') {
  out({ dispatch: fs.existsSync(${JSON.stringify(startingPath)}) ? { assignee_handle: 'native-terminal' } : undefined })
} else if (args[0] === 'terminal' && args[1] === 'read') {
  if (!fs.existsSync(${JSON.stringify(readyPath)})) fs.writeFileSync(${JSON.stringify(capturedPath)}, '1')
  if (cursor === undefined) out({ terminal: { tail: ['native-startup'], oldestCursor: 0, nextCursor: 1, latestCursor: 1 } })
  else out({ terminal: { tail: ['native-startup'], nextCursor: 1, latestCursor: 1 } })
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
    assert.equal(await readFile(capturedPath, "utf8"), "1");
    assert.match(chunks.join(""), /native-startup/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("settling partial output is captured once after it completes", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-settling-partial-"));
  const fakeOrca = path.join(temp, "orca");
  const startedPath = path.join(temp, "partial-started");
  const runId = "settling-partial-run";
  const reportPath = path.join(temp, "artifacts", runId, "review.json");
  const restoreHome = isolateHome(temp);
  const chunks: string[] = [];
  const stageLog = {
    async append(chunk: string): Promise<void> {
      chunks.push(chunk);
    },
  } as StageLog;
  try {
    await mkdir(path.dirname(reportPath), { recursive: true });
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
  const started = fs.existsSync(${JSON.stringify(startedPath)}) ? Number(fs.readFileSync(${JSON.stringify(startedPath)}, 'utf8')) : undefined
  const complete = started !== undefined && Date.now() - started >= 500
  if (cursor === undefined) out({ terminal: { tail: [complete ? 'partial' : 'part'], oldestCursor: 0, nextCursor: complete ? 1 : 0, latestCursor: 1 } })
  else if (complete) out({ terminal: { tail: ['partial'], nextCursor: 1, latestCursor: 1 } })
  else {
    if (started === undefined) fs.writeFileSync(${JSON.stringify(startedPath)}, String(Date.now()))
    out({ terminal: { tail: [], nextCursor: 0, latestCursor: 1 } })
  }
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, lastOutputAt: 1, preview: 'ready', title: 'OpenCode' } })
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  out({ dispatch: { id: 'dispatch-1', status: 'dispatched' }, injected: true, preamble: 'authenticated' })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ findings: [], summary: 'clean' }))
  out({ deliveryId: 'done', messages: [{ type: 'worker_done', payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'dispatch-1', outcome: 'succeeded', reportPath: ${JSON.stringify(reportPath)} }) }] })
} else {
  out({ ok: true })
}
`,
    );
    await chmod(fakeOrca, 0o755);
    const orca = new CliOrca({ command: fakeOrca, cwd: temp });
    await orca.createRun("settling partial");
    const worker = await orca.startWorker("task-1", {
      logPath: path.join(temp, "review_r1.log"),
      name: "reviewer",
      prompt: "Review now.",
      reportPath,
      role: "reviewer",
      stage: "review",
      stageLog,
      worktree: "current",
    });
    await orca.finishWorker(worker, "retain");

    assert.equal(chunks.filter((chunk) => chunk === "part\n").length, 0);
    assert.equal(chunks.filter((chunk) => chunk === "partial\n").length, 1);
  } finally {
    restoreHome();
    await rm(temp, { recursive: true, force: true });
  }
});

test("legacy byte accounting is upgraded before the next append", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-legacy-accounting-"));
  const logPath = path.join(temp, "artifacts", "run", "review_r1.log");
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, "A".repeat(10));
  await writeFile(`${logPath}.meta`, "10");
  const probe = await open(logPath, "a");
  const prototype = Object.getPrototypeOf(probe) as {
    writeFile: (...args: unknown[]) => Promise<void>;
  };
  const originalWriteFile = prototype.writeFile;
  let releaseWrite!: () => void;
  let reachedWrite!: () => void;
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const writeReached = new Promise<void>((resolve) => {
    reachedWrite = resolve;
  });
  await probe.close();
  prototype.writeFile = async function (...args: unknown[]): Promise<void> {
    if (Buffer.isBuffer(args[0]) && args[0].equals(Buffer.from("B"))) {
      reachedWrite();
      await writeReleased;
    }
    await originalWriteFile.apply(this, args);
  };
  try {
    const log = new StageLog(logPath);
    const appending = log.append("B");
    await writeReached;
    assert.deepEqual(JSON.parse(await readFile(`${logPath}.meta`, "utf8")), {
      fileBytes: 10,
      originalBytes: 10,
    });
    releaseWrite();
    await appending;
    await log.close();
  } finally {
    prototype.writeFile = originalWriteFile;
    releaseWrite();
    await rm(temp, { recursive: true, force: true });
  }
});
