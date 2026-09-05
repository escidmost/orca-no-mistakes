import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { GithubAuthority, runCommand, type CommandRunner } from '../scripts/github.ts'
import { DomainLedger } from '../scripts/ledger.ts'
import {
  GitShell,
  installAbortReaping,
  runPipeline,
  type OrcaOperations,
} from '../scripts/orca-no-mistakes.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function markerPath(repo: string, gateId: string): string {
  const digest = createHash('sha256')
    .update(gateId)
    .digest('hex')
    .slice(0, 32)
  return path.join(repo, '.orca', 'no-mistakes', `gate-${digest}.json`)
}

test('runPipeline in Release 2 journals passed outcome before settlement and updates with custody note', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-release-2-journal-'))
  const repo = path.join(temp, 'repo')
  const remote = path.join(temp, 'origin.git')
  const gatePath = path.join(temp, 'gate')
  const priorHome = process.env.ORCA_NO_MISTAKES_HOME
  let ledger: DomainLedger | undefined
  try {
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, 'home')

  await mkdir(repo)
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '--bare', '-b', 'main', remote])
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  await writeFile(path.join(repo, '.gitignore'), '.orca\n')
  await writeFile(path.join(repo, 'file.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'base')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-u', 'origin', 'main')
  git(repo, 'switch', '-c', 'feature')
  await writeFile(path.join(repo, 'file.txt'), 'candidate\n')
  git(repo, 'commit', '-am', 'candidate')
  const repoRoot = await realpath(repo)
  const candidate = git(repo, 'rev-parse', 'HEAD')
  const destination = 'https://github.com/owner/repo.git'

  const runner: CommandRunner = (executable, args, options) => {
    if (args[0] === 'config' && args[1] === '--get-regexp') {
      return Promise.resolve({ code: 1, stderr: '', stdout: '' })
    }
    return runCommand(executable, args.map((arg) => arg === destination ? remote : arg), options)
  }
  ledger = new DomainLedger(':memory:')
  const runId = 'run-release-2-journal'

  let task = 0
  let dispatch = 0
  const orca: OrcaOperations = {
    createRun: async () => runId,
    createTask: async () => `task-${++task}`,
    startWorker: async (taskId, launch) => ({
      dispatchId: `dispatch-${++dispatch}`,
      report: { findings: [], summary: `${launch.stage} passed` },
      shutdownConfirmed: false,
      taskId,
      terminalHandle: `term-${dispatch}`,
      worktreeId: undefined,
      worktreePath: undefined,
    }),
    finishWorker: async (worker) => { worker.shutdownConfirmed = true },
    removeWorktree: async () => {},
    completeTask: async () => {},
    createGate: async () => 'gate',
    waitForGate: async () => 'approve',
    resolveGate: async () => {},
    setWorktreeStatus: async () => {},
  }

  let pullRequest: Record<string, unknown> | null = null
  let comments: Record<string, unknown>[] = []
  const authority = {
    observeRepository: async () => ({ id: 'R_repo', nodeId: 'RN_repo' }),
    observePullRequests: async () => ({ exact: pullRequest, nearMatches: [] }),
    createPullRequest: async ({ body, title }: { body: string; title: string }) => {
      pullRequest = {
        baseBranch: 'main', baseOid: 'base', baseRepositoryId: 'R_repo',
        baseRepositoryNodeId: 'RN_repo', body, draft: false,
        headBranch: 'feature', headOid: candidate, headRepositoryId: 'R_repo',
        headRepositoryNodeId: 'RN_repo', id: 'PR_node', number: 80,
        state: 'MERGED', title, url: 'https://github.com/owner/repo/pull/80',
      }
    },
    observeIssueComments: async () => comments,
    createIssueComment: async ({ body }: { body: string }) => {
      comments = [{
        author: { id: 'AN_actor', login: 'owner' }, body,
        createdAt: '2026-09-02T00:00:00.000Z', id: 'IC_node',
        updatedAt: '2026-09-02T00:00:00.000Z', url: 'https://github.com/owner/repo/pull/80#issuecomment-1',
      }]
    },
    updateIssueComment: async ({ body }: { body: string }) => {
      comments = comments.map((comment) => ({ ...comment, body }))
    },
    updatePullRequest: async ({ body, title }: { body: string; title: string }) => {
      pullRequest = { ...pullRequest!, body, title }
    },
  } as unknown as GithubAuthority

  const marker = markerPath(repoRoot, gatePath)
  await mkdir(path.join(repoRoot, '.orca', 'no-mistakes'), { recursive: true })
  await mkdir(gatePath)

    await installAbortReaping({
      gate: {
        branch: 'feature',
        intentTaskId: 'task-intent',
        kind: 'configured',
        path: gatePath,
        root: temp,
        runId,
      },
      git: new GitShell({ repo: repoRoot }),
      ledger,
      notifyHandle: 'origin-term-test',
      originWorktree: repoRoot,
      pid: process.pid,
      runId,
    })

    ledger.setRepositoryPublicationRoute({
      actorId: 'A_actor', actorLogin: 'owner', actorNodeId: 'AN_actor',
      backend: 'gh', backendVersion: 'test', baseBranch: 'main',
      baseRepositoryId: 'R_repo', baseRepositoryName: 'owner/repo',
      baseRepositoryNodeId: 'RN_repo', credentialSource: 'GH_TOKEN',
      forgeHost: 'github.com', headBranch: 'feature', headOwner: 'owner',
      headRepositoryId: 'R_repo', headRepositoryName: 'owner/repo',
      headRepositoryNodeId: 'RN_repo', networkRootRepositoryId: 'R_repo',
      observedAt: '2026-09-02T00:00:00.000Z', repoRoot,
    })

    const result = await runPipeline({
      githubAuthority: authority,
      intent: 'ONM-80: journal test',
      publicationDestination: destination,
      publicationRunner: runner,
    }, orca, new GitShell({ repo: repoRoot }), ledger)

    assert.equal(result.verdict, 'passed')
    assert.equal(ledger.runStatus(result.runId), 'passed')

    const markerContent = JSON.parse(await readFile(marker, 'utf8')) as {
      pendingOutcome?: string
      pendingSummary?: string
    }
    assert.equal(markerContent.pendingOutcome, 'passed')
    assert.ok(
      markerContent.pendingSummary?.includes('passed all 8 stages'),
      `pending summary must include stage count: ${markerContent.pendingSummary}`
    )
    assert.ok(
      markerContent.pendingSummary?.includes('branch feature already at submission commit'),
      `pending summary must include custody note: ${markerContent.pendingSummary}`
    )
  } finally {
    ledger?.close()
    await installAbortReaping({ pid: process.pid })
    if (priorHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = priorHome
    await rm(temp, { force: true, recursive: true })
  }
})
