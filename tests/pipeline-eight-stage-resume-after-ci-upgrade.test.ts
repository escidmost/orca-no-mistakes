import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PIPELINE_STEPS } from '../scripts/config.ts'
import { runCommand, type CommandRunner, type GithubAuthority } from '../scripts/github.ts'
import { DomainLedger } from '../scripts/ledger.ts'
import { GitShell, runPipeline, type OrcaOperations } from '../scripts/orca-no-mistakes.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

type Scenario = {
  eightStage?: boolean
  failOncePollingMerge?: boolean
  failingChecksFirst?: boolean
  afterFailure?: () => void
}

async function runScenario(scenario: Scenario) {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-eight-stage-upgrade-'))
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
      if (args[0] === 'config' && args[1] === '--get-regexp') return Promise.resolve({ code: 1, stderr: '', stdout: '' })
      return runCommand(executable, args.map((arg) => arg === destination ? remote : arg), options)
    }
    ledger = new DomainLedger({ repositoryPath: repoRoot })
    let task = 0
    let dispatch = 0
    let gateWaits = 0
    const taskStages = new Map<string, string>()
    const orca: OrcaOperations = {
      createRun: async () => 'run-ci-rounds',
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
      completeTask: async () => {},
      createGate: async () => 'gate',
      waitForGate: async () => { gateWaits += 1; return 'fix' },
      resolveGate: async () => {},
      setWorktreeStatus: async () => {},
      notifyPullRequestReady: async () => {},
    }
    let pullRequest: Record<string, unknown> | null = null
    let pollsSinceBound = 0
    let mergePollFailures = 0
    let checkObservations = 0
    const authority = {
      observeRepository: async () => ({ id: 'R_repo', nodeId: 'RN_repo' }),
      observePullRequests: async () => {
        const bound = ledger!.remoteReceipt('run-ci-rounds', 'pull-request-binding')
        if (scenario.failOncePollingMerge && bound && mergePollFailures === 0) {
          mergePollFailures += 1
          pollsSinceBound = 0
          throw new Error('simulated transient poll failure')
        }
        // The PR stays open for two polls after its binding settled, then merges.
        if (bound && pullRequest && pollsSinceBound++ >= 2 && !scenario.failingChecksFirst) pullRequest = { ...pullRequest, state: 'MERGED' }
        return { exact: pullRequest, nearMatches: [] }
      },
      observePullRequestChecks: async () => {
        checkObservations += 1
        const failing = scenario.failingChecksFirst === true && checkObservations === 1
        const observation = {
          baseRefOid: base,
          checks: [{ bucket: failing ? 'fail' : 'pass', conclusion: failing ? 'FAILURE' : 'SUCCESS', kind: 'check-run', name: 'build', status: 'COMPLETED', url: null }],
          draft: false, headOid: candidate, mergeable: 'MERGEABLE', number: 80, state: pullRequest!.state,
        }
        if (!failing) pullRequest = { ...pullRequest!, state: 'MERGED' }
        return observation
      },
      createPullRequest: async ({ body, title }: { body: string; title: string }) => {
        pullRequest = {
          baseBranch: 'main', baseOid: base, baseRepositoryId: 'R_repo', baseRepositoryNodeId: 'RN_repo',
          body, draft: false, headBranch: 'feature', headOid: candidate, headRepositoryId: 'R_repo',
          headRepositoryNodeId: 'RN_repo', id: 'PR_node', number: 80, state: 'OPEN', title,
          url: 'https://github.com/owner/repo/pull/80',
        }
      },
      observeIssueComments: async () => [],
      createIssueComment: async () => {},
      updateIssueComment: async () => {},
      updatePullRequest: async ({ body, title }: { body: string; title: string }) => {
        pullRequest = { ...pullRequest!, body, title }
      },
    } as unknown as GithubAuthority
    ledger.setRepositoryPublicationRoute({
      actorId: 'A_actor', actorLogin: 'owner', actorNodeId: 'AN_actor', backend: 'gh', backendVersion: 'test',
      baseBranch: 'main', baseRepositoryId: 'R_repo', baseRepositoryName: 'owner/repo', baseRepositoryNodeId: 'RN_repo',
      credentialSource: 'GH_TOKEN', forgeHost: 'github.com', headBranch: 'feature', headOwner: 'owner',
      headRepositoryId: 'R_repo', headRepositoryName: 'owner/repo', headRepositoryNodeId: 'RN_repo',
      networkRootRepositoryId: 'R_repo', observedAt: '2026-09-02T00:00:00.000Z', repoRoot,
    })
    const options = {
      ciClock: { sleep: async () => {} },
      githubAuthority: authority,
      intent: 'ONM-96: ci rounds',
      publicationDestination: destination,
      publicationRunner: runner,
    }
    let resumed = false
    if (scenario.failOncePollingMerge) {
      await assert.rejects(runPipeline(options, orca, new GitShell({ repo: repoRoot }), ledger), /simulated transient poll failure/)
      const receipt = ledger.remoteReceipt('run-ci-rounds', 'pull-request-binding')!
      const parsed = JSON.parse(receipt.receipt_json)
      assert.equal((parsed.payload ?? parsed).state, 'open')
      scenario.afterFailure?.()
      resumed = true
    }
    const result = await runPipeline({ ...options, ...(resumed ? { resumeRunId: 'run-ci-rounds' } : {}) }, orca, new GitShell({ repo: repoRoot }), ledger)
    assert.equal(result.verdict, 'passed')
    assert.equal(ledger.runStatus(result.runId), 'passed')
    assert.doesNotThrow(() => ledger!.verifyRetainedCompletionAttestation(result.completionAttestation!))
    const evidence = ledger.listEvidence(result.runId)
    const rounds = (stage: string) => evidence.filter((row) => row.stage_id === stage).map((row) => row.round_index)
    const attested = (stage: string) => result.completionAttestation!.stageEvidence.filter((entry) => entry.stage === stage).map((entry) => entry.round)
    return { attested, gateWaits, rounds, steps: result.steps }
  } finally {
    ledger?.close()
    if (priorHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = priorHome
    await rm(temp, { force: true, recursive: true })
  }
}

test('a failed eight-stage run resumes after the ci upgrade with unchanged policy', async () => {
  const plan = [...PIPELINE_STEPS]
  ;(PIPELINE_STEPS as unknown as string[]).splice(PIPELINE_STEPS.indexOf('ci'), 1)
  try {
    const outcome = await runScenario({
      afterFailure: () => { (PIPELINE_STEPS as unknown as string[]).splice(0, PIPELINE_STEPS.length, ...plan) },
      eightStage: true,
      failOncePollingMerge: true
    })
    assert.deepEqual(outcome.steps, plan.filter((stage) => stage !== 'ci'))
    assert.deepEqual(outcome.rounds('pr'), [0, 1])
  } finally {
    ;(PIPELINE_STEPS as unknown as string[]).splice(0, PIPELINE_STEPS.length, ...plan)
  }
})
