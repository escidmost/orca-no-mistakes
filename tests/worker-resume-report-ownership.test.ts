import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CliOrca } from "../scripts/orca-no-mistakes.ts";

process.env.WORKER_SHELL_STARTUP_DELAY_MS ??= "0";

test("resumed workers retain durable artifact ownership and reject path escapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-resume-report-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = root;
  try {
    const durableRoot = path.join(root, "artifacts", "original-run");
    const otherRoot = path.join(root, "artifacts", "new-orchestration-run");
    await mkdir(durableRoot, { recursive: true });
    await mkdir(otherRoot, { recursive: true });
    const valid = path.join(durableRoot, "review.json");
    const other = path.join(otherRoot, "review.json");
    const escaped = path.join(durableRoot, "symlink.json");
    const report = { findings: [], summary: "clean" };
    await writeFile(other, JSON.stringify(report));
    const callsPath = path.join(root, "calls.jsonl");
    const command = path.join(root, "orca");
    for (const reportPath of [valid, other, escaped]) {
      await writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
const out = result => console.log(JSON.stringify({ result }));
if (args[0] === 'terminal' && args[1] === 'create') {
  out({ terminal: { handle: 'worker-terminal' } });
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, title: 'OpenCode', preview: 'ready' } });
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  out({ dispatch: { id: 'dispatch-1', status: 'dispatched' }, injected: true, preamble: 'authenticated' });
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  ${reportPath === escaped
    ? `fs.symlinkSync(${JSON.stringify(other)}, ${JSON.stringify(reportPath)});`
    : `fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(report))});`}
  out({ deliveryId: 'done', messages: [{ type: 'worker_done', payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'dispatch-1', outcome: 'succeeded', reportPath: ${JSON.stringify(reportPath)} }) }] });
} else { out({ ok: true }); }
`);
      await chmod(command, 0o755);
      const orca = new CliOrca({ command, cwd: root,
        runId: "new-orchestration-run", artifactRunId: "original-run" });
      const launch = orca.startWorker("task-1", {
        name: "reviewer", prompt: "Review independently.", reportPath,
        role: "reviewer", stage: "review", worktree: "current",
      });
      if (reportPath === valid) {
        const worker = await launch;
        assert.deepEqual(worker.report, report);
        await orca.finishWorker(worker, "retain");
      } else {
        await assert.rejects(launch, /unsafe report path/);
      }
    }
    const calls = (await readFile(callsPath, "utf8")).trim().split("\n")
      .map(line => JSON.parse(line) as string[]);
    const scoped = calls.filter(args => args.includes("--run"));
    assert.ok(scoped.length > 0);
    assert.ok(scoped.every(args => args[args.indexOf("--run") + 1] === "new-orchestration-run"));
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
