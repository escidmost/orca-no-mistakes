import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliOrca } from '../scripts/orca-no-mistakes.ts';

for (const replyError of [undefined, 'dispatch_inactive', 'permission_denied']) {
test(`relay answer reconciles the same dispatch: ${replyError ?? 'success'}`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worker-question-'));
  const runId = path.basename(root);
  const evidence = path.join(homedir(), '.orca-no-mistakes', 'artifacts', runId);
  const reportPath = path.join(evidence, 'review.json');
  const command = path.join(root, 'orca');
  const callsPath = path.join(root, 'calls.jsonl');
  const repliedPath = path.join(root, 'replied');
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
else if (args[1] === 'gate-create') out({ gate: { id: 'question-gate' } });
else if (args[1] === 'gate-list') out({ gates: [{ id: 'question-gate', status: 'resolved', resolution: 'reply: Inspect the existing authorized attachment; retain its digest.' }] });
else if (args[1] === 'worker-show') out({ projection: { attention: { categories: ['input'] } } });
else if (args[1] === 'reply') {
  if (args[args.indexOf('--id') + 1] !== 'question-1') throw Error('wrong question');
  fs.writeFileSync(replied, args[args.indexOf('--body') + 1]);
  if (${JSON.stringify(replyError)}) {
    console.log(JSON.stringify({ ok: false, error: { code: ${JSON.stringify(replyError)}, message: 'reply rejected' } }));
    process.exit(1);
  }
  out({ ok: true });
} else if (args[1] === 'check' && args.includes('--wait')) {
  out(fs.existsSync(replied)
    ? { deliveryId: 'done-delivery', messages: [{ type: 'worker_done', payload: { taskId: 'task', dispatchId: 'dispatch', outcome: 'succeeded', reportPath: ${JSON.stringify(reportPath)} } }] }
    : { deliveryId: 'question-delivery', messages: [
      { id: 'stale', type: 'question', payload: { taskId: 'stale', dispatchId: 'stale' }, body: 'Ignore me' },
      { id: 'question-1', type: 'question', payload: { taskId: 'task', dispatchId: 'dispatch' }, body: 'May I inspect existing evidence?' }
    ] });
} else out({ ok: true });
`);
    await chmod(command, 0o755);
    const orca = new CliOrca({ command, cwd: root, runId });
    const pendingWorker = orca.startWorker('task', {
      agent: { harness: 'cursor' }, name: 'question-test', prompt: 'Review',
      role: 'reviewer', stage: 'review', worktree: 'current',
    }, {
      aborted: false, deadlineSatisfied: false,
      pauseDeadline() { transitions.push('pause'); },
      resumeDeadline() { transitions.push('resume'); },
    });
    if (replyError === 'permission_denied') {
      await assert.rejects(pendingWorker, /Worker question reply failed: permission_denied/);
      return;
    }
    const worker = await pendingWorker;

    assert.equal(worker.report.summary, 'Answered and completed');
    assert.equal(await readFile(repliedPath, 'utf8'), 'Inspect the existing authorized attachment; retain its digest.');
    assert.deepEqual(transitions, ['pause', 'resume']);
    const calls: string[][] = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.filter(args => args[1] === 'dispatch').length, 1);
    const gate = calls.find(args => args[1] === 'gate-create');
    assert.match(String(gate?.[gate.indexOf('--question') + 1]), /May I inspect existing evidence/);
    assert.equal(gate?.[gate.indexOf('--options') + 1], JSON.stringify(['reply', 'stop']));
    assert.ok(calls.some(args => args.includes('--ack') && args.includes('question-delivery')));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(evidence, { recursive: true, force: true });
  }
});
}
