import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runCommand, type CommandRunner, type GithubAuthority } from '../scripts/github.ts'
import { GitShell, runPipeline, type OrcaOperations } from '../scripts/orca-no-mistakes.ts'
import { DomainLedger } from '../scripts/ledger.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

test('DomainLedger.publishedPullRequestContent returns latest published PR content for run and candidate', () => {
  const ledger = new DomainLedger(':memory:')
  try {
    const runId = 'run-test-pr-content'
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent: 'test',
      policySha256: 'p'.repeat(64),
      repoRoot: '/repo',
      runId,
      submissionCommitOid: 's'.repeat(40)
    })

    assert.equal(ledger.publishedPullRequestContent(runId, 'oid-1'), undefined)

    const gen1 = ledger.acquireLease({ branch: 'feature', repoRoot: '/repo', runId })
    ledger.startAttempt({
      actorIdentity: 'coord',
      attemptId: `${runId}-attempt-1`,
      coordinatorIdentity: 'coord',
      generationToken: gen1,
      runId,
      startedAt: '2026-09-04T00:00:00.000Z'
    })

    const routeFingerprint = ledger.recordPublicationRoute({
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_head',
      runId
    })

    ledger.recordMutationIntent({
      attemptId: `${runId}-attempt-1`,
      createdAt: '2026-09-04T00:00:01.000Z',
      kind: 'pull-request',
      payload: {
        action: 'ensure-body-and-await-merge',
        baseBranch: 'main',
        baseRepositoryId: 'R_base',
        body: 'published body 1',
        candidateCommitOid: 'oid-1',
        forgeHost: 'github.com',
        headBranch: 'feature',
        headOwner: 'owner',
        headRepositoryId: 'R_head',
        title: 'published title 1'
      },
      runId,
      targetFingerprint: routeFingerprint
    })

    assert.deepEqual(ledger.publishedPullRequestContent(runId, 'oid-1'), {
      body: 'published body 1',
      title: 'published title 1'
    })
    assert.equal(ledger.publishedPullRequestContent(runId, 'oid-different'), undefined)
    assert.equal(ledger.publishedPullRequestContent('other-run', 'oid-1'), undefined)

    ledger.recordCheckpoint({
      inputCommitOid: 's'.repeat(40),
      outputCommitOid: 's'.repeat(40),
      roundIndex: 0,
      runId,
      stageId: 'intent'
    })
    ledger.settleRun(runId, 'failed', {
      branch: 'feature',
      generationToken: gen1,
      repoRoot: '/repo'
    })
    const claim = ledger.prepareResume({
      baseBranch: 'main',
      branch: 'feature',
      effectivePolicyHash: 'p'.repeat(64),
      head: 's'.repeat(40),
      intent: 'test',
      policySha256: 'p'.repeat(64),
      repoRoot: '/repo',
      runId
    })
    const resumed = ledger.resumeRun({
      baseBranch: 'main',
      branch: 'feature',
      claimId: claim.claimId,
      effectivePolicyHash: 'p'.repeat(64),
      head: 's'.repeat(40),
      intent: 'test',
      policySha256: 'p'.repeat(64),
      repoRoot: '/repo',
      runId
    })
    ledger.startAttempt({
      actorIdentity: 'coord',
      attemptId: `${runId}-attempt-2`,
      coordinatorIdentity: 'coord',
      generationToken: resumed.generationToken,
      runId,
      startedAt: '2026-09-04T00:00:02.000Z'
    })
    ledger.recordMutationIntent({
      attemptId: `${runId}-attempt-2`,
      createdAt: '2026-09-04T00:00:03.000Z',
      kind: 'pull-request',
      payload: {
        action: 'ensure-body-and-await-merge',
        baseBranch: 'main',
        baseRepositoryId: 'R_base',
        body: 'published body 2',
        candidateCommitOid: 'oid-1',
        forgeHost: 'github.com',
        headBranch: 'feature',
        headOwner: 'owner',
        headRepositoryId: 'R_head',
        title: 'published title 2'
      },
      runId,
      targetFingerprint: routeFingerprint
    })

    assert.deepEqual(ledger.publishedPullRequestContent(runId, 'oid-1'), {
      body: 'published body 2',
      title: 'published title 2'
    })
  } finally {
    ledger.close()
  }
})

test('runPipeline reuses published PR content on stage resume without redrafting', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-pr-resume-'))
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

    const runner: CommandRunner = (executable, args, options) => {
      if (args[0] === 'config' && args[1] === '--get-regexp') {
        return Promise.resolve({ code: 1, stderr: '', stdout: '' })
      }
      return runCommand(executable, args.map((arg) => (arg === destination ? remote : arg)), options)
    }

    ledger = new DomainLedger(':memory:')
    let prDraftCount = 0
    let pullRequest: Record<string, unknown> | null = null
    let failAwaitingMerge = true

    const authority = {
      observeRepository: async () => ({ id: 'R_repo', nodeId: 'RN_repo' }),
      observePullRequests: async () => ({ exact: pullRequest, nearMatches: [] }),
      createPullRequest: async ({ body, title }: { body: string; title: string }) => {
        pullRequest = {
          baseBranch: 'main',
          baseOid: base,
          baseRepositoryId: 'R_repo',
          baseRepositoryNodeId: 'RN_repo',
          body,
          draft: false,
          headBranch: 'feature',
          headOid: candidate,
          headRepositoryId: 'R_repo',
          headRepositoryNodeId: 'RN_repo',
          id: 'PR_node',
          number: 99,
          state: 'OPEN',
          title,
          url: 'https://github.com/owner/repo/pull/99'
        }
      },
      updatePullRequest: async ({ body, title }: { body: string; title: string }) => {
        pullRequest = { ...pullRequest!, body, title }
      }
    } as unknown as GithubAuthority

    const orca: OrcaOperations = {
      completeTask: async () => {},
      createGate: async () => 'gate',
      createRun: async () => 'run-resume-test',
      createTask: async () => 'task-id',
      finishWorker: async (worker) => {
        worker.shutdownConfirmed = true
      },
      notifyPullRequestReady: async () => {
        if (failAwaitingMerge) {
          throw new Error('simulated coordinator failure while awaiting merge')
        }
      },
      removeWorktree: async () => {},
      resolveGate: async () => {},
      setWorktreeStatus: async () => {},
      startWorker: async (taskId, launch) => {
        if (launch.stage === 'pr') {
          prDraftCount += 1
          return {
            dispatchId: `dispatch-${prDraftCount}`,
            report: {
              findings: [],
              summary: `PR draft #${prDraftCount}`,
              title: `PR title #${prDraftCount}`
            },
            shutdownConfirmed: false,
            taskId,
            terminalHandle: `term-${prDraftCount}`
          }
        }
        return {
          dispatchId: 'dispatch-default',
          report: { findings: [], summary: `${launch.stage} passed` },
          shutdownConfirmed: false,
          taskId,
          terminalHandle: 'term-default'
        }
      },
      waitForGate: async () => 'approve'
    }

    ledger.setRepositoryPublicationRoute({
      actorId: 'A_actor',
      actorLogin: 'owner',
      actorNodeId: 'AN_actor',
      backend: 'gh',
      backendVersion: 'test',
      baseBranch: 'main',
      baseRepositoryId: 'R_repo',
      baseRepositoryName: 'owner/repo',
      baseRepositoryNodeId: 'RN_repo',
      credentialSource: 'GH_TOKEN',
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_repo',
      headRepositoryName: 'owner/repo',
      headRepositoryNodeId: 'RN_repo',
      networkRootRepositoryId: 'R_repo',
      observedAt: '2026-09-04T00:00:00.000Z',
      repoRoot
    })

    const pipelineOptions = {
      githubAuthority: authority,
      intent: 'ONM-99: resume pr test',
      publicationDestination: destination,
      publicationRunner: runner
    }

    await assert.rejects(
      runPipeline(pipelineOptions, orca, new GitShell({ repo: repoRoot }), ledger),
      /simulated coordinator failure while awaiting merge/
    )

    assert.equal(prDraftCount, 1)
    assert.equal((pullRequest as Record<string, unknown> | null)?.state, 'OPEN')

    pullRequest = {
      ...(pullRequest as unknown as Record<string, unknown>),
      state: 'MERGED'
    }
    failAwaitingMerge = false

    const resumedResult = await runPipeline(
      {
        ...pipelineOptions,
        resumeRunId: 'run-resume-test'
      },
      orca,
      new GitShell({ repo: repoRoot }),
      ledger
    )

    assert.equal(prDraftCount, 1)
    assert.equal(resumedResult.verdict, 'passed')
    assert.equal(ledger.runStatus(resumedResult.runId), 'passed')
    const receipt = ledger.remoteReceipt(resumedResult.runId, 'pull-request-binding')
    assert.ok(receipt)
    const receiptPayload = JSON.parse(receipt.receipt_json)
    assert.equal(receiptPayload.state, 'merged')
  } finally {
    ledger?.close()
    if (priorHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = priorHome
    await rm(temp, { force: true, recursive: true })
  }
})
