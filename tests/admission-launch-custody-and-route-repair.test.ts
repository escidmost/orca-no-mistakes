import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  awaitAdmissionLaunch,
  initializeLocalGate,
  launchLockPath,
  readGateMetadata
} from '../scripts/admission.ts'

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

test('a live admission launcher retains launch custody', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-launch-custody-'))
  const readinessPath = path.join(temp, 'admissions', `admission-${'a'.repeat(64)}.json`)
  const lockPath = launchLockPath(readinessPath)
  try {
    const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid ?? 1
    await mkdir(lockPath, { recursive: true })
    await writeFile(path.join(lockPath, 'nonce'), 'launch-nonce')
    await writeFile(path.join(lockPath, 'owner'), `${deadPid}`)
    await writeFile(path.join(lockPath, 'coordinator'), `${deadPid}`)
    await writeFile(
      readinessPath,
      `${JSON.stringify({ nonce: 'launch-nonce', runId: 'live-run', state: 'ready' })}\n`
    )
    let spawns = 0
    const launch = await awaitAdmissionLaunch(
      readinessPath,
      async () => {
        spawns += 1
      },
      1_000,
      () => process.pid
    )
    assert.equal(launch.readiness.runId, 'live-run')
    assert.equal(spawns, 0)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('gate init repairs a route whose linked worktree was removed', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-route-repair-'))
  const origin = path.join(temp, 'origin.git')
  const repo = path.join(temp, 'repo')
  const linked = path.join(temp, 'linked')
  try {
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await writeFile(path.join(repo, 'file.txt'), 'content\n')
    git(repo, 'add', 'file.txt')
    git(repo, 'commit', '-m', 'initial')
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'push', '-q', 'origin', 'main')
    git(repo, 'worktree', 'add', '-b', 'gate-route', linked, 'main')

    const initial = await initializeLocalGate(await realpath(linked), process.argv[1]!)
    git(repo, 'worktree', 'remove', '--force', linked)
    const repaired = await initializeLocalGate(await realpath(repo), process.argv[1]!)

    assert.equal(repaired.repoRoot, await realpath(repo))
    assert.equal(repaired.gateIdentity, initial.gateIdentity)
    assert.deepEqual(await readGateMetadata(repaired.gatePath), repaired)
    assert.equal(
      JSON.parse(await readFile(path.join(repaired.stateDir, 'gate.json'), 'utf8')).repoRoot,
      await realpath(repo)
    )
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
