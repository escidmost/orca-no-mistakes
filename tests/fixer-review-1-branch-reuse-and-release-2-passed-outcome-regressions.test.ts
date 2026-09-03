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
import { bindPullRequest } from '../scripts/pull-request.ts'

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

test('observePullRequests ignores terminal CLOSED and MERGED pull requests when matching exact and near matches', async () => {
  const candidateHeadOid = 'c'.repeat(40)
  const historicalHeadOid = 'b'.repeat(40)
  const nodes = [
    {
      baseRefName: 'main',
      baseRefOid: 'a'.repeat(40),
      baseRepository: { databaseId: 10, id: 'R_10', nameWithOwner: 'upstream/project' },
      body: 'historical closed PR',
      headRefName: 'feature',
      headRefOid: historicalHeadOid,
      headRepository: { databaseId: 20, id: 'R_20', nameWithOwner: 'fork/project' },
      id: 'PR_closed',
      isDraft: false,
      number: 1,
      state: 'CLOSED',
      title: 'historical closed',
      url: 'https://github.com/upstream/project/pull/1'
    },
    {
      baseRefName: 'main',
      baseRefOid: 'a'.repeat(40),
      baseRepository: { databaseId: 10, id: 'R_10', nameWithOwner: 'upstream/project' },
      body: 'historical merged PR',
      headRefName: 'feature',
      headRefOid: candidateHeadOid,
      headRepository: { databaseId: 20, id: 'R_20', nameWithOwner: 'fork/project' },
      id: 'PR_merged',
      isDraft: false,
      number: 2,
      state: 'MERGED',
      title: 'historical merged',
      url: 'https://github.com/upstream/project/pull/2'
    }
  ]

  const authority = await GithubAuthority.connect({
    runner: async (executable, args, options) => {
      if (executable === 'gh' && args[0] === '--version') {
        return { code: 0, stderr: '', stdout: 'gh version 2.97.0\n' }
      }
      if (executable === 'gh-axi') {
        return { code: 1, stderr: '', stdout: '' }
      }
      const request = JSON.parse(options?.input ?? '{}') as { query: string; variables: Record<string, unknown> }
      assert.match(request.query, /states: \[OPEN, CLOSED, MERGED\]/)
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          data: {
            repository: {
              id: 'R_10',
              pullRequests: {
                nodes,
                pageInfo: { endCursor: null, hasNextPage: false }
              }
            }
          }
        })
      }
    }
  })

  const result = await authority.observePullRequests({
    baseBranch: 'main',
    baseRepositoryId: '10',
    baseRepositoryName: 'upstream/project',
    baseRepositoryNodeId: 'R_10',
    candidateHeadOid,
    headBranch: 'feature',
    headRepositoryId: '20',
    headRepositoryNodeId: 'R_20'
  })

  assert.equal(result.exact, null)
  assert.deepEqual(result.nearMatches, [])
})

test('bindPullRequest succeeds when reusing branch with historical terminal pull request', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-pr-reuse-'))
  const candidateCommitOid = 'c'.repeat(40)
  const runId = 'run-reuse-test'
  const intents: Array<Record<string, unknown>> = []
  const settlements: Array<Record<string, unknown>> = []
  const ledger = {
    listAttemptOutcomes: () => [],
    ownsLease: () => true,
    publicationRoute: () => ({
      base_branch: 'main',
      base_repository_id: '10',
      forge_host: 'github.com',
      head_branch: 'feature',
      head_owner: 'fork',
      head_repository_id: '20',
      route_fingerprint: 'route'
    }),
    recordMutationIntent: (input: Record<string, unknown>) => {
      intents.push(input)
      return `intent-${intents.length}`
    },
    recordRemoteObservation: () => 'post-read',
    remoteObservation: () => undefined,
    remoteReceipt: (_runId: string, kind: string) => kind === 'candidate-publication'
      ? { candidate_commit_oid: candidateCommitOid, receipt_sha256: 'push-receipt' }
      : undefined,
    repositoryPublicationRoute: () => ({
      actor_id: '1',
      actor_login: 'fork',
      actor_node_id: 'U_1',
      base_repository_name: 'upstream/project',
      base_repository_node_id: 'R_10',
      head_repository_name: 'fork/project',
      head_repository_node_id: 'R_20',
      route_fingerprint: 'route'
    }),
    run: () => ({ branch: 'feature', repo_root: temp }),
    settleRemoteStage: (input: Record<string, unknown>) => {
      settlements.push(input); return { receiptSha256: 'pr-receipt' }
    }
  }

  let createdPr = false
  let comments: { author: { id: string; login: string }; body: string; createdAt: string; id: string; updatedAt: string; url: string }[] = []
  const authority = {
    createPullRequest: async () => {
      createdPr = true
    },
    observePullRequests: async () => {
      if (!createdPr) {
        return { exact: null, nearMatches: [] }
      }
      return {
        exact: {
          baseBranch: 'main',
          baseOid: 'a'.repeat(40),
          baseRepositoryId: 10,
          baseRepositoryNodeId: 'R_10',
          body: 'body',
          draft: false,
          headBranch: 'feature',
          headOid: candidateCommitOid,
          headRepositoryId: 20,
          headRepositoryNodeId: 'R_20',
          id: 'PR_created',
          number: 100,
          state: 'OPEN' as const,
          title: 'ONM-80: reuse branch',
          url: 'https://github.com/upstream/project/pull/100'
        },
        nearMatches: []
      }
    },
    observeIssueComments: async () => comments,
    createIssueComment: async ({ body }: { body: string }) => {
      const comment = {
        author: { id: 'U_1', login: 'fork' },
        body,
        createdAt: '2026-09-02T00:00:00.000Z',
        id: 'IC_1',
        updatedAt: '2026-09-02T00:00:00.000Z',
        url: 'https://github.com/upstream/project/pull/100#issuecomment-1'
      }
      comments.push(comment)
      return { id: 'IC_1' }
    },
    updateIssueComment: async () => {}
  }

  try {
    const outcome = await bindPullRequest({
      artifactPath: path.join(temp, 'pr.json'),
      attemptId: 'attempt-1',
      authority: authority as never,
      candidateCommitOid,
      generationToken: 1,
      intent: 'ONM-80: reuse branch',
      ledger: ledger as never,
      pipelineEvidenceRoot: temp,
      runId,
      stageSummaries: [],
      workerIdentity: 'coordinator'
    })
    assert.equal(outcome.number, 100)
    assert.equal(createdPr, true)
    assert.equal(settlements.length, 1)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('runPipeline in Release 2 journals passed outcome before settlement and updates with custody note', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-release-2-journal-'))
  const repo = path.join(temp, 'repo')
  const remote = path.join(temp, 'origin.git')
  const gatePath = path.join(temp, 'gate')
  const priorHome = process.env.ORCA_NO_MISTAKES_HOME
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
  const ledger = new DomainLedger(':memory:')
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
    createPullRequest: async () => {
      pullRequest = {
        baseBranch: 'main', baseOid: 'base', baseRepositoryId: 'R_repo',
        baseRepositoryNodeId: 'RN_repo', body: 'body', draft: false,
        headBranch: 'feature', headOid: candidate, headRepositoryId: 'R_repo',
        headRepositoryNodeId: 'RN_repo', id: 'PR_node', number: 80,
        state: 'OPEN', title: 'ONM-80: journal test', url: 'https://github.com/owner/repo/pull/80',
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
  } as unknown as GithubAuthority

  const marker = markerPath(repoRoot, gatePath)
  await mkdir(path.join(repoRoot, '.orca', 'no-mistakes'), { recursive: true })
  await mkdir(gatePath)

  try {
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
    ledger.close()
    await installAbortReaping({ pid: process.pid })
    if (priorHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = priorHome
    await rm(temp, { force: true, recursive: true })
  }
})
