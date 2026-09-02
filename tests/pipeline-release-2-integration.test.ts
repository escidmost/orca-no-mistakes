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

test('runPipeline settles all eight stages before exposing Release 2 completion', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-release-2-pipeline-'))
  const repo = path.join(temp, 'repo')
  const remote = path.join(temp, 'origin.git')
  const priorHome = process.env.ORCA_NO_MISTAKES_HOME
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
  const runner: CommandRunner = (executable, args, options) => {
    if (args[0] === 'config' && args[1] === '--get-regexp') {
      return Promise.resolve({ code: 1, stderr: '', stdout: '' })
    }
    return runCommand(executable, args.map((arg) => arg === destination ? remote : arg), options)
  }
  const ledger = new DomainLedger(':memory:')
  const completedStages: string[] = []
  let task = 0
  let dispatch = 0
  const orca: OrcaOperations = {
    createRun: async () => 'run-release-2',
    createTask: async () => `task-${++task}`,
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
      completedStages.push(PIPELINE_STEPS[Number(taskId.slice(5)) - 1]!)
    },
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
    createPullRequest: async () => {
      pullRequest = {
        baseBranch: 'main', baseOid: base, baseRepositoryId: 'R_repo',
        baseRepositoryNodeId: 'RN_repo', body: 'body', draft: false,
        headBranch: 'feature', headOid: candidate, headRepositoryId: 'R_repo',
        headRepositoryNodeId: 'RN_repo', id: 'PR_node', number: 80,
        state: 'OPEN', title: 'ONM-80: integration', url: 'https://github.com/owner/repo/pull/80',
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
    updateIssueComment: async () => assert.fail('unexpected comment update'),
  } as unknown as GithubAuthority

  try {
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
      intent: 'ONM-80: integration',
      publicationDestination: destination,
      publicationRunner: runner,
    }, orca, new GitShell({ repo: repoRoot }), ledger)

    assert.deepEqual(result.steps, PIPELINE_STEPS)
    assert.deepEqual(completedStages, PIPELINE_STEPS)
    assert.equal(result.verdict, 'passed')
    assert.equal(result.completionAttestation?.version, '2.0.0')
    assert.equal(ledger.runStatus(result.runId), 'passed')
    assert.ok(ledger.remoteReceipt(result.runId, 'candidate-publication'))
    assert.ok(ledger.remoteReceipt(result.runId, 'pull-request-binding'))
    assert.equal(ledger.stageDispositions(result.runId).length, PIPELINE_STEPS.length)
    assert.equal(git(remote, 'rev-parse', 'refs/heads/feature'), candidate)
  } finally {
    ledger.close()
    if (priorHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = priorHome
    await rm(temp, { force: true, recursive: true })
  }
})
