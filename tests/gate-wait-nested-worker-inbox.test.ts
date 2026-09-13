import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliOrca } from '../scripts/orca-no-mistakes.ts';

test('a standalone gate wait resolves a human response from its own inbox and advances the delivery', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'gate-inbox-'));
  const command = path.join(temp, 'orca');
  const callsPath = path.join(temp, 'calls.jsonl');
  const resolvedPath = path.join(temp, 'resolved');
  const consumedPath = path.join(temp, 'consumed');
  try {
    await writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = (result) => console.log(JSON.stringify({ result }))
const resolved = ${JSON.stringify(resolvedPath)}
const consumed = ${JSON.stringify(consumedPath)}
if (args[1] === 'run-create') out({ run: { id: 'inbox-run' } })
else if (args[1] === 'gate-list') out({ gates: [
  { id: 'gate-1', status: fs.existsSync(resolved) ? 'resolved' : 'pending', resolution: 'reply: go' }
] })
else if (args[1] === 'gate-resolve') { fs.writeFileSync(resolved, 'resolved'); out({ gate: { id: 'gate-1', status: 'resolved' } }) }
else if (args[1] === 'check' && args.includes('--unread')) {
  if (fs.existsSync(consumed)) out({ messages: [] })
  else {
    fs.writeFileSync(consumed, 'consumed')
    out({ deliveryId: 'gate-delivery', messages: [
      { id: 'response', type: 'question', from_handle: 'origin-term', subject: 'no-mistakes gate response', body: JSON.stringify({ gateId: 'gate-1', resolution: 'reply: go' }) }
    ] })
  }
} else out({ ok: true })
`);
    await chmod(command, 0o755);
    const orca = new CliOrca({ command, cwd: temp, notifyHandle: 'origin-term' });
    await orca.createRun('standalone gate wait');

    assert.equal(await orca.waitForGate('gate-1'), 'reply: go');

    const calls: string[][] = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.some(args => args[1] === 'check' && args.includes('--unread') && args.includes('--run')));
    assert.ok(calls.some(args => args.includes('--ack') && args.includes('gate-delivery')));
    assert.ok(calls.some(args => args[1] === 'gate-resolve' && args.includes('reply: go')));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
