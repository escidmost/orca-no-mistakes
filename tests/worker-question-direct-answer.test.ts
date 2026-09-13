import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliOrca } from '../scripts/orca-no-mistakes.ts';

test('a question answered directly lets the worker complete instead of hanging on its gate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worker-direct-answer-'));
  const runId = path.basename(root);
  const evidence = path.join(homedir(), '.orca-no-mistakes', 'artifacts', runId);
  const reportPath = path.join(evidence, 'review.json');
  const command = path.join(root, 'orca');
  const callsPath = path.join(root, 'calls.jsonl');
  const answeredPath = path.join(root, 'answered');
  const transitions: string[] = [];
  try {
    await mkdir(evidence, { recursive: true });
    await writeFile(reportPath, JSON.stringify({ findings: [], summary: 'Answered directly and completed' }));
    await writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
const answered = ${JSON.stringify(answeredPath)}
const done = { type: 'worker_done', payload: { taskId: 'task', dispatchId: 'dispatch', outcome: 'succeeded', reportPath: ${JSON.stringify(reportPath)} } }
if (args[1] === 'worker-start') out({ terminal: { handle: 'worker' } })
else if (args[1] === 'dispatch') out({ dispatch: { id: 'dispatch', status: 'dispatched' }, injected: true, preamble: 'authenticated' })
else if (args[1] === 'gate-create') out({ gate: { id: 'gate-question' } })
else if (args[1] === 'gate-list') out({ gates: [{ id: 'gate-question', status: 'pending' }] })
else if (args[1] === 'reply') throw Error('the coordinator answered a question the human already answered')
else if (args[1] === 'check' && args.includes('--peek')) {
  fs.writeFileSync(answered, 'answered')
  out({ messages: [done] })
} else if (args[1] === 'check' && args.includes('--wait')) {
  out(fs.existsSync(answered)
    ? { deliveryId: 'done-delivery', messages: [done] }
    : { deliveryId: 'question-delivery', messages: [{ id: 'question-1', type: 'question', payload: { taskId: 'task', dispatchId: 'dispatch' }, body: 'May I inspect the retained evidence?' }] })
} else out({ ok: true })
`);
    await chmod(command, 0o755);
    const orca = new CliOrca({ command, cwd: root, runId });
    const worker = await orca.startWorker('task', {
      agent: { harness: 'cursor' }, name: 'direct-answer-test', prompt: 'Review',
      role: 'reviewer', stage: 'review', worktree: 'current',
    }, {
      aborted: false, deadlineSatisfied: false,
      pauseDeadline() { transitions.push('pause'); },
      resumeDeadline() { transitions.push('resume'); },
    });

    assert.equal(worker.report.summary, 'Answered directly and completed');
    assert.deepEqual(transitions, ['pause', 'resume']);
    const calls: string[][] = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(!calls.some(args => args[1] === 'reply'));
    assert.ok(calls.some(args => args.includes('--ack') && args.includes('question-delivery')));
    await orca.finishWorker(worker, 'release');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(evidence, { recursive: true, force: true });
  }
});
