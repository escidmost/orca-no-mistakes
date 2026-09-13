import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliOrca } from '../scripts/orca-no-mistakes.ts';

const launch = {
  agent: { harness: 'cursor' as const }, name: 'direct-answer-test', prompt: 'Review',
  role: 'reviewer' as const, stage: 'review' as const, worktree: 'current' as const,
};

test('a question answered directly restores the worker deadlines instead of waiting forever', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worker-direct-answer-'));
  const runId = path.basename(root);
  const command = path.join(root, 'orca');
  const callsPath = path.join(root, 'calls.jsonl');
  const transitions: string[] = [];
  const idle = process.env.WORKER_IDLE_TIMEOUT_MS;
  process.env.WORKER_IDLE_TIMEOUT_MS = '1200';
  try {
    await writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
const shown = ${JSON.stringify(path.join(root, 'shown'))}
const delivered = ${JSON.stringify(path.join(root, 'delivered'))}
if (args[1] === 'worker-start') out({ terminal: { handle: 'worker' } })
else if (args[1] === 'dispatch') out({ dispatch: { id: 'dispatch', status: 'dispatched' }, injected: true, preamble: 'authenticated' })
else if (args[1] === 'gate-create') out({ gate: { id: 'gate-question' } })
else if (args[1] === 'gate-list') out({ gates: [{ id: 'gate-question', status: 'pending' }] })
else if (args[1] === 'worker-show') {
  const seen = (fs.existsSync(shown) ? Number(fs.readFileSync(shown, 'utf8')) : 0) + 1
  fs.writeFileSync(shown, String(seen))
  out({ projection: { attention: { categories: seen > 1 ? [] : ['input'] } } })
} else if (args[1] === 'show' && args[0] === 'terminal') out({ terminal: { connected: true, lastOutputAt: 1000 } })
else if (args[1] === 'check' && args.includes('--wait')) {
  if (fs.existsSync(delivered)) out({ timedOut: true })
  else {
    fs.writeFileSync(delivered, 'delivered')
    out({ deliveryId: 'question-delivery', messages: [{ id: 'question-1', type: 'question', payload: { taskId: 'task', dispatchId: 'dispatch' }, body: 'May I inspect the retained evidence?' }] })
  }
} else out({ ok: true })
`);
    await chmod(command, 0o755);
    const orca = new CliOrca({ command, cwd: root, runId });
    await assert.rejects(
      orca.startWorker('task', launch, {
        aborted: false, deadlineSatisfied: false,
        pauseDeadline() { transitions.push('pause'); },
        resumeDeadline() { transitions.push('resume'); },
      }),
      /was inactive for|produced no output for/,
    );

    assert.deepEqual(transitions, ['pause', 'resume']);
    const calls: string[][] = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(!calls.some(args => args[1] === 'reply'));
    assert.ok(calls.some(args => args[1] === 'worker-show' && args.includes('dispatch')));
  } finally {
    if (idle === undefined) delete process.env.WORKER_IDLE_TIMEOUT_MS;
    else process.env.WORKER_IDLE_TIMEOUT_MS = idle;
    await rm(root, { recursive: true, force: true });
  }
});

test('a question nobody has answered keeps the worker waiting past its inactivity deadline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worker-unanswered-'));
  const runId = path.basename(root);
  const evidence = path.join(homedir(), '.orca-no-mistakes', 'artifacts', runId);
  const reportPath = path.join(evidence, 'review.json');
  const command = path.join(root, 'orca');
  const transitions: string[] = [];
  const idle = process.env.WORKER_IDLE_TIMEOUT_MS;
  process.env.WORKER_IDLE_TIMEOUT_MS = '400';
  try {
    await mkdir(evidence, { recursive: true });
    await writeFile(reportPath, JSON.stringify({ findings: [], summary: 'Waited for the human' }));
    await writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const out = (result) => console.log(JSON.stringify({ result }))
const startedAt = ${JSON.stringify(path.join(root, 'started'))}
const done = { type: 'worker_done', payload: { taskId: 'task', dispatchId: 'dispatch', outcome: 'succeeded', reportPath: ${JSON.stringify(reportPath)} } }
if (args[1] === 'worker-start') out({ terminal: { handle: 'worker' } })
else if (args[1] === 'dispatch') out({ dispatch: { id: 'dispatch', status: 'dispatched' }, injected: true, preamble: 'authenticated' })
else if (args[1] === 'gate-create') out({ gate: { id: 'gate-question' } })
else if (args[1] === 'gate-list') out({ gates: [{ id: 'gate-question', status: 'pending' }] })
else if (args[1] === 'worker-show') out({ projection: { attention: { categories: ['input'] } } })
else if (args[1] === 'show' && args[0] === 'terminal') out({ terminal: { connected: true, lastOutputAt: 1000 } })
else if (args[1] === 'check' && args.includes('--wait')) {
  if (!fs.existsSync(startedAt)) {
    fs.writeFileSync(startedAt, String(Date.now()))
    out({ deliveryId: 'question-delivery', messages: [{ id: 'question-1', type: 'question', payload: { taskId: 'task', dispatchId: 'dispatch' }, body: 'May I inspect the retained evidence?' }] })
  } else if (Date.now() - Number(fs.readFileSync(startedAt, 'utf8')) > 2000) out({ deliveryId: 'done-delivery', messages: [done] })
  else out({ timedOut: true })
} else out({ ok: true })
`);
    await chmod(command, 0o755);
    const orca = new CliOrca({ command, cwd: root, runId });
    const worker = await orca.startWorker('task', launch, {
      aborted: false, deadlineSatisfied: false,
      pauseDeadline() { transitions.push('pause'); },
      resumeDeadline() { transitions.push('resume'); },
    });

    assert.equal(worker.report.summary, 'Waited for the human');
    assert.deepEqual(transitions, ['pause', 'resume']);
    await orca.finishWorker(worker, 'release');
  } finally {
    if (idle === undefined) delete process.env.WORKER_IDLE_TIMEOUT_MS;
    else process.env.WORKER_IDLE_TIMEOUT_MS = idle;
    await rm(root, { recursive: true, force: true });
    await rm(evidence, { recursive: true, force: true });
  }
});
