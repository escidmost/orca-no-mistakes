import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliOrca } from '../scripts/orca-no-mistakes.ts';

test('a gate wait nested in the worker inbox reads responses without consuming the parked delivery', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'gate-nested-inbox-'));
  const command = path.join(temp, 'orca');
  const callsPath = path.join(temp, 'calls.jsonl');
  const resolvedPath = path.join(temp, 'resolved');
  try {
    await writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
if (args[1] === 'run-create') out({ run: { id: 'nested-run' } })
else if (args[1] === 'gate-list') out({ gates: [
  { id: 'gate-1', status: fs.existsSync(${JSON.stringify(resolvedPath)}) ? 'resolved' : 'pending', resolution: 'reply: go' }
] })
else if (args[1] === 'gate-resolve') { fs.writeFileSync(${JSON.stringify(resolvedPath)}, 'resolved'); out({ gate: { id: 'gate-1', status: 'resolved' } }) }
else if (args[1] === 'check' && args.includes('--peek')) out({ messages: [
  { id: 'response', type: 'question', from_handle: 'origin-term', subject: 'no-mistakes gate response', body: JSON.stringify({ gateId: 'gate-1', resolution: 'reply: go' }) }
] })
else if (args[1] === 'check' && args.includes('--unread')) {
  console.error(JSON.stringify({ error: { code: 'inbox_consumed', message: 'the worker inbox delivery was consumed by a nested gate wait' } }))
  process.exit(1)
} else out({ ok: true })
`);
    await chmod(command, 0o755);
    const orca = new CliOrca({ command, cwd: temp, notifyHandle: 'origin-term' });
    await orca.createRun('nested gate wait');

    assert.equal(await orca.waitForGate('gate-1', { readOnlyInbox: true }), 'reply: go');

    const calls: string[][] = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const peeks = calls.filter(args => args[1] === 'check' && args.includes('--peek'));
    assert.ok(peeks.length > 0);
    assert.ok(peeks.every(args => args.includes('--types') && args.includes('question')));
    assert.ok(!calls.some(args => args.includes('--ack')));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
