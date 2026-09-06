import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { GithubAuthority, resolveGithubPublicationRoute, runCommand, type CommandResult, type CommandRunner } from '../scripts/github.ts'
import { DomainLedger } from '../scripts/ledger.ts'

function json(value: unknown): CommandResult {
  return { code: 0, stderr: '', stdout: JSON.stringify(value) }
}

const repository = {
  default_branch: 'main',
  fork: false,
  full_name: 'upstream/project',
  id: 10,
  node_id: 'R_10',
  owner: { id: 7, login: 'upstream', node_id: 'U_upstream' }
}

const github: CommandRunner = async (executable, args) => {
  if (executable === 'gh' && args[0] === '--version') return { code: 0, stderr: '', stdout: 'gh version 2.97.0\n' }
  if (executable === 'gh-axi') return { code: 127, stderr: '', stdout: '' }
  if (args.includes('/user')) return json({ id: 5, login: 'operator', node_id: 'U_5' })
  return json(repository)
}

test('route resolution reads the branch of the requesting worktree, not the detached primary checkout', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'route-worktree-head-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'main')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  git('remote', 'add', 'origin', 'git@github.com:upstream/project.git')
  const worktree = path.join(root, 'wt')
  git('worktree', 'add', '-q', worktree, '-b', 'feature')
  git('checkout', '-q', '--detach')
  assert.equal(git('branch', '--show-current'), '')
  const ledger = new DomainLedger(':memory:')
  try {
    const provider = await GithubAuthority.connect({
      env: { GITHUB_TOKEN: 'token' },
      now: () => new Date('2026-08-31T12:00:00.000Z'),
      runner: github
    })
    const route = await resolveGithubPublicationRoute({ commandRunner: runCommand, ledger, provider, repoPath: worktree })
    assert.equal(route.headBranch, 'feature')
    assert.equal(route.repoRoot, path.join(root, '.git'))
    assert.equal(ledger.repositoryPublicationRoute(worktree)?.route_fingerprint, route.routeFingerprint)
  } finally {
    ledger.close()
    await rm(root, { recursive: true, force: true })
  }
})
