import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { COMMAND_OUTPUT_LIMIT, COMMAND_TRUNCATION_MARKER, cancelCommandGates, runCommandGate } from '../scripts/command-gates.ts'
import { git, repository } from './command-gates-fixture.ts'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test('a detached descendant holding the inherited pipes does not block settlement or cleanup', async () => {
  const repo = await repository()
  const pidFile = path.join(repo.directory, 'daemon-pid')
  let daemon = 0
  try {
    const command = `node -e "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});c.unref();require('node:fs').writeFileSync('${pidFile}',String(c.pid));console.log('escaped');process.exit(3)"`
    const result = await runCommandGate({
      ...repo, repoRoot: repo.root, candidate: repo.initial,
      gate: { name: 'daemon', after: 'test', command },
    })
    daemon = Number(await readFile(pidFile, 'utf8'))
    assert.equal(result.exitCode, 3)
    assert.match(result.output, /escaped/)
    assert.ok(alive(daemon), 'positive control: the detached descendant outlived the attempt')
    assert.deepEqual(await readdir(repo.artifactsDir), [])
    assert.equal(git(repo.root, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1)
  } finally {
    if (daemon) { try { process.kill(daemon, 'SIGKILL') } catch {} }
    await repo.cleanup()
  }
})

test('output streams while the command runs and survives cancellation', async () => {
  const repo = await repository()
  let streamed = ''
  try {
    const pending = runCommandGate({
      ...repo, repoRoot: repo.root, candidate: repo.initial,
      gate: { name: 'slow', after: 'test', command: `printf 'diagnostic\\n'; sleep 60` },
      onOutput: (text) => { streamed += text },
    })
    const rejected = assert.rejects(pending, /abort/i)
    for (let attempt = 0; attempt < 200 && !streamed.includes('diagnostic'); attempt++) await delay(20)
    assert.match(streamed, /diagnostic/)
    await cancelCommandGates()
    await rejected
    assert.match(streamed, /diagnostic/)
  } finally { await cancelCommandGates(); await repo.cleanup() }
})

for (const truncated of [false, true]) test(`incomplete UTF-8 is flushed once before settlement or truncation (truncated ${truncated})`, async () => {
  const repo = await repository()
  let streamed = ''
  try {
    const result = await runCommandGate({
      ...repo, repoRoot: repo.root, candidate: repo.initial,
      gate: { name: 'utf8', after: 'test', command: `node -e "process.stdout.write(Buffer.concat([Buffer.alloc(${COMMAND_OUTPUT_LIMIT - 1},120),Buffer.from([${truncated ? '0xe2,0x82,0xac' : '0xe2'}])]))"` },
      onOutput: (text) => { streamed += text },
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.truncated, truncated)
    assert.equal(result.output, 'x'.repeat(COMMAND_OUTPUT_LIMIT - 1) + '\ufffd')
    assert.equal(streamed, result.output + (truncated ? COMMAND_TRUNCATION_MARKER : ''))
  } finally { await repo.cleanup() }
})

test('streamed output carries the same bound and truncation marker as the captured result', async () => {
  const repo = await repository()
  let streamed = ''
  try {
    const result = await runCommandGate({
      ...repo, repoRoot: repo.root, candidate: repo.initial,
      gate: { name: 'noisy', after: 'test', command: `node -e "process.stdout.write('x'.repeat(200000))"` },
      onOutput: (text) => { streamed += text },
    })
    assert.equal(result.truncated, true)
    assert.ok(streamed.endsWith(COMMAND_TRUNCATION_MARKER))
    assert.equal(streamed.slice(0, -COMMAND_TRUNCATION_MARKER.length), result.output)
    assert.equal(Buffer.byteLength(result.output), COMMAND_OUTPUT_LIMIT)
  } finally { await repo.cleanup() }
})
