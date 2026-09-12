import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliOrca } from '../scripts/orca-no-mistakes.ts';

test('active questions relay a human answer before acknowledgement and continue the same dispatch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worker-question-'));
  const runId = path.basename(root);
  const evidence = path.join(homedir(), '.orca-no-mistakes', 'artifacts', runId);
  const reportPath = path.join(evidence, 'review.json');
  const command = path.join(root, 'orca');
  const callsPath = path.join(root, 'calls.jsonl');
  const repliedPath = path.join(root, 'replied');
  let paused = false;
  const transitions: string[] = [];
  try {
    await mkdir(evidence, { recursive: true });
    await writeFile(reportPath, JSON.stringify({ findings: [], summary: 'Answered and completed' }));
    await writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
const out = result => console.log(JSON.stringify({ result }));
const replied = ${JSON.stringify(repliedPath)};
if (args[1] === 'worker-start') out({ terminal: { handle: 'worker' } });
else if (args[1] === 'dispatch') out({ dispatch: { id: 'dispatch', status: 'dispatched' }, injected: true, preamble: 'authenticated' });
else if (args[1] === 'reply') {
  if (args[args.indexOf('--id') + 1] !== 'question-1') throw Error('wrong question');
  fs.writeFileSync(replied, args[args.indexOf('--body') + 1]); out({ ok: true });
} else if (args[1] === 'check' && args.includes('--wait')) {
  out(fs.existsSync(replied)
    ? { deliveryId: 'done', messages: [{ type: 'worker_done', payload: { taskId: 'task', dispatchId: 'dispatch', outcome: 'succeeded', reportPath: ${JSON.stringify(reportPath)} } }] }
    : { deliveryId: 'question-delivery', messages: [
      { id: 'stale', type: 'question', payload: { taskId: 'stale', dispatchId: 'stale' }, body: 'Ignore me' },
      { id: 'question-1', type: 'question', payload: { taskId: 'task', dispatchId: 'dispatch' }, body: 'May I inspect existing evidence?' }
    ] });
} else if (args.includes('--ack') && args.includes('question-delivery') && !fs.existsSync(replied)) throw Error('acknowledged before reply');
else out({ ok: true });
`);
    await chmod(command, 0o755);
    class QuestionOrca extends CliOrca {
      override async createGate(task: string, question: string, options?: string[]) {
        assert.equal(task, 'task');
        assert.match(question, /May I inspect existing evidence/);
        assert.deepEqual(options, ['reply', 'stop']);
        assert.equal(paused, true);
        return 'question-gate';
      }
      override async waitForGate(id: string) {
        assert.equal(id, 'question-gate');
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(paused, true);
        return 'reply: Inspect the existing authorized attachment; retain its digest.';
      }
    }
    const orca = new QuestionOrca({ command, cwd: root, runId });
    const worker = await orca.startWorker('task', {
      agent: { harness: 'cursor' }, name: 'question-test', prompt: 'Review',
      role: 'reviewer', stage: 'review', worktree: 'current',
    }, {
      aborted: false, deadlineSatisfied: false,
      pauseDeadline() { paused = true; transitions.push('pause'); },
      resumeDeadline() { paused = false; transitions.push('resume'); },
    });
    assert.equal(worker.report.summary, 'Answered and completed');
    assert.equal(await readFile(repliedPath, 'utf8'), 'Inspect the existing authorized attachment; retain its digest.');
    assert.deepEqual(transitions, ['pause', 'resume']);
    const calls: string[][] = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.filter(args => args[1] === 'dispatch').length, 1);
    assert.ok(calls.findIndex(args => args[1] === 'reply') < calls.findIndex(args => args.includes('--ack') && args.includes('question-delivery')));
    await orca.finishWorker(worker, 'release');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(evidence, { recursive: true, force: true });
  }
});
