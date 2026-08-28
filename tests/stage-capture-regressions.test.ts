import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFile,
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

import {
  CliOrca,
  GitShell,
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

test("StageLog recovers crash-appended byte accounting", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-stage-log-crash-"));
  try {
    const logPath = path.join(temp, "artifacts", "run", "review_r1.log");
    const first = new StageLog(logPath, 2_048);
    await first.append("A".repeat(5_000));
    await first.close();
    await appendFile(logPath, "B".repeat(500));

    const reopened = new StageLog(logPath, 2_048);
    await reopened.append("C".repeat(500));
    await reopened.close();

    assert.match(await readFile(logPath, "utf8"), /original bytes 6000/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("terminal drains retry failed pages and preserve duplicate partials", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-terminal-cursor-"));
  const fakeOrca = path.join(temp, "orca");
  const callsPath = path.join(temp, "calls.jsonl");
  const previewCountPath = path.join(temp, "preview-count");
  const waitCountPath = path.join(temp, "wait-count");
  const runId = "terminal-cursor-run";
  const reportPath = path.join(temp, "artifacts", runId, "review.json");
  const restoreHome = isolateHome(temp);
  const chunks: string[] = [];
  let failedPage = false;
  const stageLog = {
    async append(chunk: string): Promise<void> {
      if (chunk === "retry\n" && !failedPage) {
        failedPage = true;
        throw new Error("transient append failure");
      }
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
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
const cursor = args.includes('--cursor') ? args[args.indexOf('--cursor') + 1] : undefined
if (args[0] === 'orchestration' && args[1] === 'run-create') {
  out({ run: { id: ${JSON.stringify(runId)} } })
} else if (args[0] === 'terminal' && args[1] === 'create') {
  out({ terminal: { handle: 'worker-terminal' } })
} else if (args[0] === 'terminal' && args[1] === 'read') {
  if (cursor === undefined) {
    const count = fs.existsSync(${JSON.stringify(previewCountPath)}) ? Number(fs.readFileSync(${JSON.stringify(previewCountPath)}, 'utf8')) : 0
    fs.writeFileSync(${JSON.stringify(previewCountPath)}, String(count + 1))
    if (count === 0) out({ terminal: { tail: ['old'], oldestCursor: 0, nextCursor: 1, latestCursor: 1 } })
    else out({ terminal: { tail: ['retry', 'retry'], oldestCursor: 2, nextCursor: 4, latestCursor: 3 } })
  } else if (cursor === '0') {
    out({ terminal: { truncated: true, oldestCursor: 2, tail: ['retry'], nextCursor: 3, latestCursor: 3 } })
  } else if (cursor === '2') {
    out({ terminal: { tail: ['retry'], nextCursor: 3, latestCursor: 3 } })
  } else {
    out({ terminal: { tail: [], nextCursor: Number(cursor), latestCursor: Number(cursor) } })
  }
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, lastOutputAt: 1, preview: 'ready', title: 'OpenCode' } })
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  out({ dispatch: { id: 'dispatch-1', status: 'dispatched' }, injected: true, preamble: 'authenticated' })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  const count = fs.existsSync(${JSON.stringify(waitCountPath)}) ? Number(fs.readFileSync(${JSON.stringify(waitCountPath)}, 'utf8')) : 0
  fs.writeFileSync(${JSON.stringify(waitCountPath)}, String(count + 1))
  if (count === 0) out({ deliveryId: 'heartbeat', messages: [{ type: 'heartbeat', payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'dispatch-1' }) }] })
  else {
    fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ findings: [], summary: 'clean' }))
    out({ deliveryId: 'done', messages: [{ type: 'worker_done', payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'dispatch-1', outcome: 'succeeded', reportPath: ${JSON.stringify(reportPath)} }) }] })
  }
} else {
  out({ ok: true })
}
`,
    );
    await chmod(fakeOrca, 0o755);

    const orca = new CliOrca({ command: fakeOrca, cwd: temp });
    await orca.createRun("test run");
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

    const transcript = chunks.join("");
    assert.match(transcript, /retained history began at cursor 2/);
    assert.match(transcript, /retry\nretry\n$/);
    const reads = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args[0] === "terminal" && args[1] === "read");
    assert.ok(
      reads.filter(
        (args) => args[args.indexOf("--cursor") + 1] === "2",
      ).length >= 2,
    );
  } finally {
    restoreHome();
    await rm(temp, { recursive: true, force: true });
  }
});

test("native startup output reaches the stage sink before readiness", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-native-startup-log-"));
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
console.error('native-startup-diagnostic')
console.log(JSON.stringify({ result: {} }))
process.exitCode = 1
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
    assert.match(chunks.join(""), /native-startup-diagnostic/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("GitShell streams coordinator rebase output", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-rebase-log-"));
  const remote = path.join(temp, "remote.git");
  const repo = path.join(temp, "repo");
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" });
  try {
    await mkdir(repo);
    git(temp, ["init", "--bare", remote]);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    await writeFile(path.join(repo, "file.txt"), "main\n");
    git(repo, ["add", "file.txt"]);
    git(repo, ["commit", "-m", "main"]);
    git(repo, ["branch", "-M", "main"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-u", "origin", "main"]);
    git(repo, ["checkout", "-b", "feature"]);
    await writeFile(path.join(repo, "feature.txt"), "feature\n");
    git(repo, ["add", "feature.txt"]);
    git(repo, ["commit", "-m", "feature"]);

    const chunks: string[] = [];
    const report = await new GitShell({ repo }).rebase("main", (chunk) => {
      chunks.push(chunk);
    });

    assert.equal(report.findings.length, 0);
    assert.ok(chunks.join("").trim().length > 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("watchdog cancels a silent orchestration long poll", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-watchdog-cancel-"));
  const fakeOrca = path.join(temp, "orca");
  const pollPidPath = path.join(temp, "poll-pid");
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
  out({ run: { id: 'watchdog-cancel-run' } })
} else if (args[0] === 'terminal' && args[1] === 'create') {
  out({ terminal: { handle: 'worker-terminal' } })
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, lastOutputAt: 1, preview: 'ready', title: 'OpenCode' } })
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  out({ dispatch: { id: 'dispatch-1', status: 'dispatched' }, injected: true, preamble: 'authenticated' })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  fs.writeFileSync(${JSON.stringify(pollPidPath)}, String(process.pid))
  setTimeout(() => out({ _keepalive: true }), 5000)
} else {
  out({ ok: true })
}
`,
    );
    await chmod(fakeOrca, 0o755);
    const orca = new CliOrca({ command: fakeOrca, cwd: temp });
    await orca.createRun("watchdog cancellation");

    await assert.rejects(
      orca.startWorker("task-1", {
        name: "reviewer",
        prompt: "Review now.",
        role: "reviewer",
        stage: "review",
        worktree: "current",
      }),
      /produced no output/,
    );

    const pollPid = Number(await readFile(pollPidPath, "utf8"));
    assert.throws(() => process.kill(pollPid, 0), { code: "ESRCH" });
  } finally {
    if (previousIdle === undefined) delete process.env.WORKER_IDLE_TIMEOUT_MS;
    else process.env.WORKER_IDLE_TIMEOUT_MS = previousIdle;
    restoreHome();
    await rm(temp, { recursive: true, force: true });
  }
});

test("worker heartbeats keep the watchdog alive", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-watchdog-heartbeat-"));
  const fakeOrca = path.join(temp, "orca");
  const countPath = path.join(temp, "heartbeat-count");
  const runId = "watchdog-heartbeat-run";
  const reportPath = path.join(temp, "artifacts", runId, "review.json");
  const restoreHome = isolateHome(temp);
  const previousIdle = process.env.WORKER_IDLE_TIMEOUT_MS;
  process.env.WORKER_IDLE_TIMEOUT_MS = "1000";
  try {
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === 'orchestration' && args[1] === 'run-create') {
  out({ run: { id: ${JSON.stringify(runId)} } })
} else if (args[0] === 'terminal' && args[1] === 'create') {
  out({ terminal: { handle: 'worker-terminal' } })
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, lastOutputAt: 1, preview: 'ready', title: 'OpenCode' } })
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  out({ dispatch: { id: 'dispatch-1', status: 'dispatched' }, injected: true, preamble: 'authenticated' })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  const count = fs.existsSync(${JSON.stringify(countPath)}) ? Number(fs.readFileSync(${JSON.stringify(countPath)}, 'utf8')) : 0
  fs.writeFileSync(${JSON.stringify(countPath)}, String(count + 1))
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  if (count < 4) out({ deliveryId: 'heartbeat-' + count, messages: [{ type: 'heartbeat', payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'dispatch-1' }) }] })
  else {
    fs.mkdirSync(${JSON.stringify(path.dirname(reportPath))}, { recursive: true })
    fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ findings: [], summary: 'clean' }))
    out({ deliveryId: 'done', messages: [{ type: 'worker_done', payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'dispatch-1', outcome: 'succeeded', reportPath: ${JSON.stringify(reportPath)} }) }] })
  }
} else {
  out({ ok: true })
}
`,
    );
    await chmod(fakeOrca, 0o755);
    const orca = new CliOrca({ command: fakeOrca, cwd: temp });
    await orca.createRun("watchdog heartbeat");

    const worker = await orca.startWorker("task-1", {
      name: "reviewer",
      prompt: "Review now.",
      reportPath,
      role: "reviewer",
      stage: "review",
      worktree: "current",
    });

    assert.equal(worker.report.summary, "clean");
    assert.equal(await readFile(countPath, "utf8"), "5");
  } finally {
    if (previousIdle === undefined) delete process.env.WORKER_IDLE_TIMEOUT_MS;
    else process.env.WORKER_IDLE_TIMEOUT_MS = previousIdle;
    restoreHome();
    await rm(temp, { recursive: true, force: true });
  }
});
