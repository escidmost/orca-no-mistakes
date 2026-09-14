import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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

for (const phase of ['before-add', 'after-add', 'remove']) test(`cancellation handles Git stalled at ${phase}`, { timeout: 10_000 }, async (t) => {
  const repo = await repository()
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const bin = path.join(repo.directory, 'bin')
  const pidFile = path.join(repo.directory, 'git-pid')
  const previousPath = process.env.PATH
  const controller = new AbortController()
  const cleanupDeadline = new AbortController()
  let pid = 0
  let pending: Promise<unknown> | undefined
  t.after(async () => {
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
    await pending?.catch(() => {})
    process.env.PATH = previousPath
    await repo.cleanup()
  })
  await mkdir(bin)
  await writeFile(path.join(bin, 'git'), `#!${process.execPath}
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const phase = ${JSON.stringify(phase)};
const stalled = args[1] === (phase === 'remove' ? 'remove' : 'add');
if (!stalled || phase === 'after-add') execFileSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
if (stalled) {
  process.on('SIGTERM', () => {});
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  setInterval(() => {}, 60000);
}
`, { mode: 0o755 })
  if (phase === 'remove') t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 120_000)
    return cleanupDeadline.signal
  })
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`
  pending = runCommandGate({ ...repo, repoRoot: repo.root, candidate: repo.initial, signal: controller.signal,
    gate: { name: 'cancellation', after: 'test', command: 'exit 0' } })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  for (let attempt = 0; attempt < 100 && !pid; attempt++) {
    try { pid = Number(await readFile(pidFile, 'utf8')) } catch {}
    if (!pid) await delay(20)
  }
  assert.ok(pid > 0, 'Git reached the intended stall')
  process.kill(pid, 0)
  if (phase === 'before-add') controller.abort()
  const cancelled = cancelCommandGates()
  if (phase === 'remove') {
    // Cancellation must not prevent cleanup; its separate deadline bounds a stall.
    await delay(20)
    process.kill(pid, 0)
    cleanupDeadline.abort()
  }
  await cancelled
  await rejected
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0) } catch { pid = 0; break }
    await delay(20)
  }
  assert.equal(pid, 0, 'the stalled Git subprocess was killed')
  if (phase !== 'remove') {
    assert.deepEqual(await readdir(repo.artifactsDir), [])
    assert.equal(git(repo.root, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1)
  }
})
