import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliOrca } from '../scripts/orca-no-mistakes.ts';

const fake = (callsPath: string, reportPath: string, tail: string) => `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
const question = { id: 'question-1', type: 'question', payload: { taskId: 'task', dispatchId: 'dispatch' }, body: 'May I inspect the retained evidence?' }
const tail = ${tail}
if (args[1] === 'worker-start') out({ terminal: { handle: 'worker' } })
else if (args[1] === 'dispatch') out({ dispatch: { id: 'dispatch', status: 'dispatched' }, injected: true, preamble: 'authenticated' })
else if (args[1] === 'gate-create') out({ gate: { id: 'gate-1' } })
else if (args[1] === 'gate-list') out({ gates: [{ id: 'gate-1', status: 'pending' }] })
else if (args[1] === 'reply') throw Error('the coordinator answered a question the worker had already settled')
else if (args[1] === 'check' && args.includes('--wait')) out({ deliveryId: 'question-delivery', messages: [question, tail] })
else out({ ok: true })
`;

const startWorker = async (label: string, tail: string, reportSummary: string) => {
  const root = await mkdtemp(path.join(tmpdir(), `${label}-`));
  const runId = path.basename(root);
  const evidence = path.join(homedir(), '.orca-no-mistakes', 'artifacts', runId);
  const reportPath = path.join(evidence, 'review.json');
  const command = path.join(root, 'orca');
  const callsPath = path.join(root, 'calls.jsonl');
  const transitions: string[] = [];
  await mkdir(evidence, { recursive: true });
  await writeFile(reportPath, JSON.stringify({ findings: [], summary: reportSummary }));
  await writeFile(command, fake(callsPath, reportPath, tail.replace('REPORT_PATH', JSON.stringify(reportPath))));
  await chmod(command, 0o755);
  const orca = new CliOrca({ command, cwd: root, runId });
  const worker = orca.startWorker('task', {
    agent: { harness: 'cursor' }, name: label, prompt: 'Review',
    role: 'reviewer', stage: 'review', worktree: 'current',
  }, {
    aborted: false, deadlineSatisfied: false,
    pauseDeadline() { transitions.push('pause'); },
    resumeDeadline() { transitions.push('resume'); },
  });
  return {
    calls: async (): Promise<string[][]> =>
      (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(evidence, { recursive: true, force: true });
    },
    orca, transitions, worker,
  };
};

test('a completion delivered alongside its question settles the dispatch instead of blocking', async () => {
  const run = await startWorker(
    'question-with-completion',
    `{ type: 'worker_done', payload: { taskId: 'task', dispatchId: 'dispatch', outcome: 'succeeded', reportPath: REPORT_PATH } }`,
    'Answered directly and completed',
  );
  try {
    const worker = await run.worker;
    assert.equal(worker.report.summary, 'Answered directly and completed');
    assert.deepEqual(run.transitions, ['pause', 'resume']);
    assert.ok(!(await run.calls()).some(args => args[1] === 'reply'));
    await run.orca.finishWorker(worker, 'release');
  } finally {
    await run.cleanup();
  }
});

test('an escalation delivered alongside its question still fails the dispatch', async () => {
  const run = await startWorker(
    'question-with-escalation',
    `{ type: 'escalation', payload: { taskId: 'task', dispatchId: 'dispatch' }, body: 'blocked on credentials' }`,
    'unused',
  );
  try {
    await assert.rejects(run.worker, /blocked on credentials/);
    assert.deepEqual(run.transitions, ['pause', 'resume']);
  } finally {
    await run.cleanup();
  }
});
