import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PIPELINE_STEPS } from '../scripts/config.ts'
import { runCommand, type CommandRunner, type GithubAuthority } from '../scripts/github.ts'
import { DomainLedger } from '../scripts/ledger.ts'
import {
  GitShell,
  runPipeline,
  type OrcaOperations,
} from '../scripts/orca-no-mistakes.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function runRelease2Pipeline(failAfter?: 'push' | 'pr'): Promise<void> {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-release-2-pipeline-'))
  const repo = path.join(temp, 'repo')
  const remote = path.join(temp, 'origin.git')
  const priorHome = process.env.ORCA_NO_MISTAKES_HOME
  let ledger: DomainLedger | undefined
  try {
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, 'home')
  await mkdir(repo)
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '--bare', '-b', 'main', remote])
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  await writeFile(path.join(repo, 'file.txt'), 'base\n')
  git(repo, 'add', 'file.txt')
  git(repo, 'commit', '-m', 'base')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-u', 'origin', 'main')
  git(repo, 'switch', '-c', 'feature')
  await writeFile(path.join(repo, 'file.txt'), 'candidate\n')
  git(repo, 'commit', '-am', 'candidate')
  const repoRoot = await realpath(repo)
  const candidate = git(repo, 'rev-parse', 'HEAD')
  const base = git(repo, 'rev-parse', 'origin/main')
  const destination = 'https://github.com/owner/repo.git'
  let pushCount = 0
  const runner: CommandRunner = (executable, args, options) => {
    if (args[0] === 'config' && args[1] === '--get-regexp') {
      return Promise.resolve({ code: 1, stderr: '', stdout: '' })
    }
    if (args[0] === 'push') pushCount += 1
    return runCommand(executable, args.map((arg) => arg === destination ? remote : arg), options)
  }
  ledger = new DomainLedger(':memory:')
  const completedStages: string[] = []
  let task = 0
  let dispatch = 0
  let failedTaskUpdate = false
  const readyNotifications: string[] = []
  const taskStages = new Map<string, string>()
  const orca: OrcaOperations = {
    createRun: async () => 'run-release-2',
    createTask: async (spec) => {
      const taskId = `task-${++task}`
      taskStages.set(taskId, spec.match(/^\[([^\]]+)\]/)?.[1] ?? '')
      return taskId
    },
    startWorker: async (taskId, launch) => ({
      dispatchId: `dispatch-${++dispatch}`,
      report: { findings: [], summary: `${launch.stage} passed` },
      shutdownConfirmed: false,
      taskId,
      terminalHandle: `term-${dispatch}`,
      worktreeId: launch.worktree === 'new-child' ? `worktree-${dispatch}` : undefined,
      worktreePath: launch.worktree === 'new-child' ? `/tmp/worktree-${dispatch}` : undefined,
    }),
    finishWorker: async (worker) => { worker.shutdownConfirmed = true },
    removeWorktree: async () => {},
    completeTask: async (taskId) => {
      const stage = taskStages.get(taskId)!
      if (stage === failAfter && !failedTaskUpdate) {
        failedTaskUpdate = true
        throw new Error(`simulated ${stage} task update failure`)
      }
      completedStages.push(stage)
    },
    createGate: async () => 'gate',
    waitForGate: async () => 'approve',
    resolveGate: async () => {},
    setWorktreeStatus: async () => {},
    notifyPullRequestReady: async (_number, _title, url) => { readyNotifications.push(url) },
  }
  let pullRequest: Record<string, unknown> | null = null
  let comments: Record<string, unknown>[] = []
  let pullRequestCreateCount = 0
  let commentCreateCount = 0
  let commentUpdateCount = 0
  const authority = {
    observeRepository: async () => ({ id: 'R_repo', nodeId: 'RN_repo' }),
    observePullRequests: async () => ({ exact: pullRequest, nearMatches: [] }),
    createPullRequest: async ({ body, title }: { body: string; title: string }) => {
      pullRequestCreateCount += 1
      pullRequest = {
        baseBranch: 'main', baseOid: base, baseRepositoryId: 'R_repo',
        baseRepositoryNodeId: 'RN_repo', body, draft: false,
        headBranch: 'feature', headOid: candidate, headRepositoryId: 'R_repo',
        headRepositoryNodeId: 'RN_repo', id: 'PR_node', number: 80,
        state: 'MERGED', title, url: 'https://github.com/owner/repo/pull/80',
      }
    },
    observeIssueComments: async () => comments,
    createIssueComment: async ({ body }: { body: string }) => {
      commentCreateCount += 1
      comments = [{
        author: { id: 'AN_actor', login: 'owner' }, body,
        createdAt: '2026-09-02T00:00:00.000Z', id: 'IC_node',
        updatedAt: '2026-09-02T00:00:00.000Z', url: 'https://github.com/owner/repo/pull/80#issuecomment-1',
      }]
    },
    updateIssueComment: async ({ body }: { body: string }) => {
      commentUpdateCount += 1
      comments = comments.map((comment) => ({ ...comment, body }))
    },
    updatePullRequest: async ({ body, title }: { body: string; title: string }) => {
      pullRequest = { ...pullRequest!, body, title }
    },
  } as unknown as GithubAuthority

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
    const pipelineOptions = {
      githubAuthority: authority,
      intent: 'ONM-80: integration',
      publicationDestination: destination,
      publicationRunner: runner,
    }
    if (failAfter) {
      await assert.rejects(
        runPipeline(pipelineOptions, orca, new GitShell({ repo: repoRoot }), ledger),
        new RegExp(`simulated ${failAfter} task update failure`),
      )
      assert.equal(ledger.runStatus('run-release-2'), 'failed')
    }
    const result = await runPipeline({
      ...pipelineOptions,
      ...(failAfter ? { resumeRunId: 'run-release-2' } : {}),
    }, orca, new GitShell({ repo: repoRoot }), ledger)

    assert.deepEqual(result.steps, PIPELINE_STEPS)
    if (!failAfter) assert.deepEqual(completedStages, PIPELINE_STEPS)
    assert.equal(result.verdict, 'passed')
    assert.equal(result.completionAttestation?.version, '2.0.0')
    assert.equal(ledger.runStatus(result.runId), 'passed')
    assert.ok(ledger.remoteReceipt(result.runId, 'candidate-publication'))
    assert.ok(ledger.remoteReceipt(result.runId, 'pull-request-binding'))
    assert.equal(ledger.stageDispositions(result.runId).length, PIPELINE_STEPS.length)
    assert.equal(git(remote, 'rev-parse', 'refs/heads/feature'), candidate)
    assert.equal(pushCount, 1)
    assert.equal(pullRequestCreateCount, 1)
    assert.deepEqual(readyNotifications, ['https://github.com/owner/repo/pull/80'])
    assert.equal(commentCreateCount, 0)
    assert.equal(commentUpdateCount, 0)
  } finally {
    ledger?.close()
    if (priorHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = priorHome
    await rm(temp, { force: true, recursive: true })
  }
}

test('runPipeline settles all eight stages before exposing Release 2 completion', () =>
  runRelease2Pipeline())

for (const stage of ['push', 'pr'] as const) {
  test(`runPipeline resumes after ${stage} settlement bookkeeping fails without replaying creation`, () =>
    runRelease2Pipeline(stage))
}
