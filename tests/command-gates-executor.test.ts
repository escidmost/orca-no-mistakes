import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { COMMAND_OUTPUT_LIMIT, cancelCommandGates, runCommandGate } from '../scripts/command-gates.ts'
import { git, repository } from './command-gates-fixture.ts'

test('commands use the selected isolated candidate and capture failure, success, and bounded combined output', async () => {
  const repo = await repository()
  const gate = { name: 'check', after: 'test' as const, command: 'node check.cjs' }
  try {
    const failed = await runCommandGate({ ...repo, repoRoot: repo.root, candidate: repo.initial, gate })
    assert.equal(failed.exitCode, 7)
    assert.match(failed.output, /bad/)
    const passed = await runCommandGate({ ...repo, repoRoot: repo.root, candidate: repo.repaired, gate })
    assert.equal(passed.exitCode, 0)
    assert.match(passed.output, /good/)
    assert.equal(await readFile(path.join(repo.root, 'value'), 'utf8'), 'bad')
    const noisy = await runCommandGate({ ...repo, repoRoot: repo.root, candidate: repo.initial, gate: { ...gate, command: `node -e "process.stderr.write('stderr\\n'); process.stdout.write('x'.repeat(200000))"` } })
    assert.equal(noisy.exitCode, 0)
    assert.equal(noisy.truncated, true)
    assert.equal(Buffer.byteLength(noisy.output), COMMAND_OUTPUT_LIMIT)
    assert.deepEqual(await readdir(repo.artifactsDir), [])
    assert.equal(git(repo.root, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1)
  } finally { await repo.cleanup() }
})

for (const cancelled of [false, true]) test(`owned background children are killed on ${cancelled ? 'attempt cancellation' : 'shell completion'}`, async () => {
  const repo = await repository()
  const pidFile = path.join(repo.directory, 'pid')
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  try {
    const pending = runCommandGate({ ...repo, repoRoot: repo.root, candidate: repo.initial, gate: {
      name: 'child', after: 'test',
      command: `sleep 60 & child=$!; printf '%s' "$child" > '${pidFile}'; ${cancelled ? 'wait' : 'sleep 0.2'}`,
    } })
    const outcome = cancelled ? assert.rejects(pending, /abort/i) : pending
    let pid = 0
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      try { pid = Number(await readFile(pidFile, 'utf8')) } catch {}
      if (!pid) await delay(20)
    }
    assert.ok(pid > 0, 'child was launched')
    assert.ok(alive(pid), 'positive control: child is alive before cleanup')
    if (cancelled) await cancelCommandGates()
    await outcome
    for (let attempt = 0; attempt < 100 && alive(pid); attempt++) await delay(20)
    assert.equal(alive(pid), false)
    assert.deepEqual(await readdir(repo.artifactsDir), [])
  } finally { await cancelCommandGates(); await repo.cleanup() }
})
