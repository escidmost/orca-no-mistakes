import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { initializeLocalGate, readGateMetadata } from '../scripts/admission.ts'

const unreachableOrigin = 'https://127.0.0.1:1/unreachable/repo.git'

function git(repo: string, ...args: string[]): string {
  return String(execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })).trim()
}

async function commitFile(repo: string): Promise<void> {
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  await writeFile(path.join(repo, 'file.txt'), 'commit\n')
  git(repo, 'add', 'file.txt')
  git(repo, 'commit', '-m', 'commit')
}

test('gate init fails closed on cached remote evidence when origin is unreachable', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-default-branch-cache-'))
  const repo = path.join(temp, 'repo')
  try {
    execFileSync('git', ['init', '-b', 'feature/lie', repo], { stdio: 'ignore' })
    await commitFile(repo)
    git(repo, 'config', 'http.proxy', '')
    git(repo, 'remote', 'add', 'origin', unreachableOrigin)
    git(repo, 'update-ref', 'refs/remotes/origin/trunk', git(repo, 'rev-parse', 'HEAD'))
    await assert.rejects(initializeLocalGate(repo, process.argv[1]!), /unreachable/)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('gate init fails closed on a checked-out feature branch when origin is unreachable', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-default-branch-head-'))
  const repo = path.join(temp, 'repo')
  try {
    execFileSync('git', ['init', '-b', 'feature/work', repo], { stdio: 'ignore' })
    await commitFile(repo)
    git(repo, 'config', 'http.proxy', '')
    git(repo, 'remote', 'add', 'origin', unreachableOrigin)
    await assert.rejects(initializeLocalGate(repo, process.argv[1]!), /unreachable/)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('gate init still records local HEAD for local origin plumbing', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-default-branch-local-'))
  const repo = path.join(temp, 'repo')
  try {
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
    git(repo, 'remote', 'add', 'origin', path.join(temp, 'origin.git'))
    const metadata = await initializeLocalGate(repo, process.argv[1]!)
    assert.equal(metadata.defaultBranch, 'main')
    assert.equal((await readGateMetadata(metadata.gatePath)).defaultBranch, 'main')
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('a reachable origin advertisement that contradicts cached evidence fails closed', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-default-branch-conflict-'))
  const bare = path.join(temp, 'origin.git')
  const seed = path.join(temp, 'seed')
  const repo = path.join(temp, 'repo')
  try {
    execFileSync('git', ['init', '--bare', '-b', 'trunk', bare], { stdio: 'ignore' })
    execFileSync('git', ['init', '-b', 'trunk', seed], { stdio: 'ignore' })
    await commitFile(seed)
    git(seed, 'push', bare, 'trunk')
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
    git(repo, 'remote', 'add', 'origin', bare)
    git(repo, 'fetch', '--quiet', 'origin')
    git(repo, 'update-ref', '-d', '--no-deref', 'refs/remotes/origin/HEAD')
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'refs/remotes/origin/trunk'))
    await assert.rejects(
      initializeLocalGate(repo, process.argv[1]!),
      /conflicts with local evidence/
    )
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
