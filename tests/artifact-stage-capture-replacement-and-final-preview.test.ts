import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CliOrca } from "../scripts/orca-no-mistakes.ts";
import { StageLog } from "../scripts/ledger.ts";

process.env.WORKER_SHELL_STARTUP_DELAY_MS ??= "0";

test("identity-less accounting stays unknown after log replacement", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-unbound-accounting-"));
  const logPath = path.join(temp, "artifacts", "run", "review_r1.log");
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, "A".repeat(100));
    await writeFile(
      `${logPath}.meta`,
      JSON.stringify({ fileBytes: 100, originalBytes: 100 }),
    );
    await rm(logPath);
    await writeFile(logPath, "B".repeat(10));

    const log = new StageLog(logPath, 2_048);
    await log.append("C".repeat(3_000));
    await log.close();

    assert.match(await readFile(logPath, "utf8"), /original bytes unknown/);
    const accounting = JSON.parse(await readFile(`${logPath}.meta`, "utf8"));
    assert.equal(accounting.originalBytesKnown, false);
    assert.equal(typeof accounting.fileIdentity, "string");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("final preview drains rotated complete lines before its partial", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-final-preview-gap-"));
  const fakeOrca = path.join(temp, "orca");
  const previewPath = path.join(temp, "preview-count");
  const runId = "final-preview-gap-run";
  const reportPath = path.join(temp, "artifacts", runId, "review.json");
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = temp;
  const chunks: string[] = [];
  const stageLog = {
    append: async (chunk: string) => void chunks.push(chunk),
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
  const previews = fs.existsSync(${JSON.stringify(previewPath)}) ? Number(fs.readFileSync(${JSON.stringify(previewPath)}, 'utf8')) : 0
  if (cursor === undefined) {
    fs.writeFileSync(${JSON.stringify(previewPath)}, String(previews + 1))
    if (previews === 0) out({ terminal: { tail: ['initial'], oldestCursor: 0, nextCursor: 0, latestCursor: 0 } })
    else out({ terminal: { truncated: true, oldestCursor: 5, tail: ['gap-one', 'gap-two', 'partial'], nextCursor: 7, latestCursor: 8 } })
  } else if (previews < 2 || cursor === '7') {
    out({ terminal: { tail: [], nextCursor: cursor, latestCursor: previews < 2 ? 0 : 8 } })
  } else if (cursor === '0') {
    out({ terminal: { truncated: true, oldestCursor: 5, tail: ['gap-one', 'gap-two'], nextCursor: 7, latestCursor: 8 } })
  } else {
    out({ terminal: { tail: ['gap-one', 'gap-two'], nextCursor: 7, latestCursor: 8 } })
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
    await orca.createRun("final preview gap");
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
    assert.match(transcript, /retained history began at cursor 5/);
    assert.match(transcript, /gap-one\ngap-two\n/);
    assert.equal(chunks.filter((chunk) => chunk === "partial\n").length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});
