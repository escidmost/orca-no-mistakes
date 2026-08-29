import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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

test("StageLog rejects stale accounting from a replaced compacted file", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-stale-accounting-"));
  const logPath = path.join(temp, "artifacts", "run", "review_r1.log");
  const crashScript = path.join(temp, "crash.mjs");
  try {
    const first = new StageLog(logPath, 2_048);
    await first.append("A".repeat(1_500));
    await first.close();
    await writeFile(
      crashScript,
      `import { open } from 'node:fs/promises'
import { StageLog } from ${JSON.stringify(new URL("../scripts/ledger.ts", import.meta.url).href)}
const logPath = process.argv[2]
const probe = await open(logPath, 'a')
const prototype = Object.getPrototypeOf(probe)
const originalWriteFile = prototype.writeFile
await probe.close()
prototype.writeFile = async function (data, ...args) {
  if (Buffer.isBuffer(data) && data.toString('utf8').includes('"fileBytes"')) throw new Error('simulated sidecar failure')
  return await originalWriteFile.call(this, data, ...args)
}
const log = new StageLog(logPath, 2_048)
await log.append('B'.repeat(3_000))
process.exit(0)
`,
    );
    execFileSync(process.execPath, [crashScript, logPath]);

    const reopened = new StageLog(logPath, 2_048);
    await reopened.append("C".repeat(3_000));
    await reopened.close();

    assert.match(await readFile(logPath, "utf8"), /original bytes unknown/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("command streams keep independent redaction state", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-stream-redaction-"));
  const fakeOrca = path.join(temp, "orca");
  const logPath = path.join(temp, "review_r1.log");
  const secret = "STAGE_CAPTURE_SECRET_123456789";
  const restoreHome = isolateHome(temp);
  const previousSecret = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret;
  try {
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'orchestration' && args[1] === 'worker-start') {
  process.stdout.write(${JSON.stringify(secret.slice(0, 14))})
  setTimeout(() => process.stderr.write('interleaved\\n'), 10)
  setTimeout(() => process.stdout.write(${JSON.stringify(secret.slice(14))}), 20)
  setTimeout(() => { process.exitCode = 1 }, 30)
} else {
  console.log(JSON.stringify({ result: {} }))
}
`,
    );
    await chmod(fakeOrca, 0o755);
    const log = new StageLog(logPath);
    const orca = new CliOrca({ command: fakeOrca, cwd: temp });
    const launch: WorkerLaunch = {
      agent: { harness: "cursor" },
      logPath,
      name: "reviewer",
      prompt: "Review now.",
      role: "reviewer",
      stage: "review",
      stageLog: log,
      worktree: "current",
    };
    await assert.rejects(orca.startWorker("task-1", launch));
    await log.close();

    const transcript = await readFile(logPath, "utf8");
    assert.match(transcript, /\[REDACTED\]/);
    assert.doesNotMatch(transcript, /STAGE_CAPTURE|SECRET_123456789/);
  } finally {
    restoreHome();
    if (previousSecret === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousSecret;
    await rm(temp, { recursive: true, force: true });
  }
});

test("retained rounds capture updated partials at the same cursor", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-retained-partial-"));
  const fakeOrca = path.join(temp, "orca");
  const roundPath = path.join(temp, "round");
  const runId = "retained-partial-run";
  const report1 = path.join(temp, "artifacts", runId, "review-1.json");
  const report2 = path.join(temp, "artifacts", runId, "review-2.json");
  const restoreHome = isolateHome(temp);
  const firstChunks: string[] = [];
  const secondChunks: string[] = [];
  const firstLog = {
    append: async (chunk: string) => void firstChunks.push(chunk),
  } as StageLog;
  const secondLog = {
    append: async (chunk: string) => void secondChunks.push(chunk),
  } as StageLog;
  try {
    await mkdir(path.dirname(report1), { recursive: true });
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
const cursor = args.includes('--cursor') ? args[args.indexOf('--cursor') + 1] : undefined
const round = fs.existsSync(${JSON.stringify(roundPath)}) ? 2 : 1
if (args[0] === 'orchestration' && args[1] === 'run-create') {
  out({ run: { id: ${JSON.stringify(runId)} } })
} else if (args[0] === 'terminal' && args[1] === 'create') {
  out({ terminal: { handle: 'worker-terminal' } })
} else if (args[0] === 'terminal' && args[1] === 'read') {
  if (cursor === undefined) out({ terminal: { tail: [round === 1 ? 'part' : 'partial'], oldestCursor: 5, nextCursor: 5, latestCursor: 6 } })
  else out({ terminal: { tail: [], nextCursor: 5, latestCursor: 6 } })
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, lastOutputAt: 1, preview: 'ready', title: 'OpenCode' } })
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  out({ dispatch: { id: 'dispatch-1', status: 'dispatched' }, injected: true, preamble: 'authenticated' })
} else if (args[0] === 'orchestration' && args[1] === 'worker-start') {
  fs.writeFileSync(${JSON.stringify(roundPath)}, '2')
  out({ dispatchId: 'dispatch-2', state: 'ready' })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  const second = fs.existsSync(${JSON.stringify(roundPath)})
  const reportPath = second ? ${JSON.stringify(report2)} : ${JSON.stringify(report1)}
  const taskId = second ? 'task-2' : 'task-1'
  const dispatchId = second ? 'dispatch-2' : 'dispatch-1'
  fs.writeFileSync(reportPath, JSON.stringify({ findings: [], summary: 'clean' }))
  out({ deliveryId: 'done', messages: [{ type: 'worker_done', payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded', reportPath }) }] })
} else {
  out({ ok: true })
}
`,
    );
    await chmod(fakeOrca, 0o755);
    const orca = new CliOrca({ command: fakeOrca, cwd: temp });
    await orca.createRun("retained partial");
    const first = await orca.startWorker("task-1", {
      logPath: path.join(temp, "review_r1.log"),
      name: "reviewer",
      prompt: "Review now.",
      reportPath: report1,
      role: "reviewer",
      stage: "review",
      stageLog: firstLog,
      worktree: "current",
    });
    await orca.finishWorker(first, "retain");
    const second = await orca.startWorker("task-2", {
      logPath: path.join(temp, "review_r2.log"),
      name: "reviewer",
      prompt: "Fix now.",
      reportPath: report2,
      retainedWorktreeId: "worktree-1",
      retainedWorktreePath: temp,
      role: "reviewer",
      stage: "review",
      stageLog: secondLog,
      terminal: "worker-terminal",
      worktree: "current",
    });
    await orca.finishWorker(second, "retain");

    assert.equal(firstChunks.filter((chunk) => chunk === "part\n").length, 1);
    assert.equal(secondChunks.filter((chunk) => chunk === "partial\n").length, 1);
  } finally {
    restoreHome();
    await rm(temp, { recursive: true, force: true });
  }
});
