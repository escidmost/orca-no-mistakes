import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runCommand, type CommandRunner, type GithubAuthority } from '../scripts/github.ts'
import { DomainLedger } from '../scripts/ledger.ts'
import { GitShell, runPipeline, type OrcaOperations } from '../scripts/orca-no-mistakes.ts'
import { withLivePass } from './live-validation-fixture.ts'
import { terminalCandidate } from '../scripts/publication.ts'
import { observeBoundPullRequest } from '../scripts/pull-request.ts'

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function scenario(failure?: 'pr-update' | 'publication' | 'repair' | 'drift' | 'custody' | 'validation' | 'publication-receipt' | 'timeout-stop') {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-ci-repair-'))
  const repo = path.join(temp, 'repo')
  const remote = path.join(temp, 'origin.git')
  const home = process.env.ORCA_NO_MISTAKES_HOME
  let ledger: DomainLedger | undefined
  try {
    process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, 'home')
    await mkdir(repo)
    git(temp, '-c', 'init.templateDir=', 'init', '--bare', '-b', 'main', remote)
    git(temp, '-c', 'init.templateDir=', 'init', '-b', 'main', repo)
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await writeFile(path.join(repo, 'file.txt'), 'base\n')
    git(repo, 'add', 'file.txt'); git(repo, 'commit', '-m', 'base')
    git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-u', 'origin', 'main')
    git(repo, 'switch', '-c', 'feature')
    await writeFile(path.join(repo, 'file.txt'), 'broken\n'); git(repo, 'commit', '-am', 'candidate')
    const root = await realpath(repo)
    const initial = git(repo, 'rev-parse', 'HEAD')
    const base = git(repo, 'rev-parse', 'origin/main')
    const destination = 'https://github.com/owner/repo.git'
    ledger = new DomainLedger({ repositoryPath: root })
    const id = 'run-ci-repair'
    let faultUsed = false
    let repairLaunches = 0
    let gateWaits = 0
    let task = 0
    let dispatch = 0
    let repaired: string | undefined
    let pr: Record<string, unknown> | null = null
    const prompts: string[] = []
    const observedLogs: unknown[] = []
    const questions: string[] = []
    const finishRepair = ledger.finishCiRepair.bind(ledger)
    ledger.finishCiRepair = (...args) => {
      if (failure === 'custody' && args[2] && !faultUsed) { faultUsed = true; throw new Error('crash before repair settlement') }
      finishRepair(...args)
    }
    const settleRemote = ledger.settleRemoteStage.bind(ledger)
    ledger.settleRemoteStage = (input) => {
      if (failure === 'publication-receipt' && input.stageId === 'push' && repaired && !faultUsed) {
        faultUsed = true; throw new Error('crash before publication receipt')
      }
      return settleRemote(input)
    }
    const runner: CommandRunner = async (exe, args, options) => {
      if (args[0] === 'config' && args[1] === '--get-regexp') return { code: 1, stderr: '', stdout: '' }
      const result = await runCommand(exe, args.map((arg) => arg === destination ? remote : arg), options)
      if (args[0] === 'push' && repaired && failure === 'publication' && !faultUsed) {
        faultUsed = true
        throw new Error('lost publication response')
      }
      return result
    }
    const orca: OrcaOperations = {
      createRun: async () => id,
      createTask: async () => `task-${++task}`,
      startWorker: async (taskId, launch) => {
        if (failure === 'validation' && repaired && launch.stage === 'review' && !faultUsed) {
          faultUsed = true; throw new Error('revalidation interrupted')
        }
        let worktree: string | undefined
        if (launch.role === 'fixer') {
          repairLaunches++
          prompts.push(launch.prompt)
          worktree = path.join(temp, `repair-${repairLaunches}`)
          git(repo, 'worktree', 'add', '--detach', worktree, launch.commitOid!)
          await writeFile(path.join(worktree, 'file.txt'), 'fixed\n')
          git(worktree, 'commit', '-am', 'fix CI regression')
          repaired = git(worktree, 'rev-parse', 'HEAD')
          if (failure === 'repair' && !faultUsed) { faultUsed = true; throw new Error('wedged repair fixture') }
          if (failure === 'timeout-stop') await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return { dispatchId: `dispatch-${++dispatch}`, taskId,
          report: withLivePass(launch, { findings: [], summary: `${launch.stage} ${launch.role} passed` }),
          shutdownConfirmed: false, terminalHandle: `terminal-${dispatch}`,
          worktreeId: worktree ? `worktree-${dispatch}` : undefined,
          worktreePath: worktree,
        }
      },
      finishWorker: async (worker) => { worker.shutdownConfirmed = true },
      removeWorktree: async () => {}, completeTask: async () => {}, createGate: async (_taskId, question) => { questions.push(question); return `gate-${questions.length}` },
      waitForGate: async () => {
        gateWaits++
        if (failure === 'timeout-stop') {
          if (gateWaits > 1) return 'stop'
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return 'fix'
      }, resolveGate: async () => {},
      setWorktreeStatus: async () => {}, notifyPullRequestReady: async () => {},
    }
    const authority = {
      observeRepository: async () => ({ id: 'R_repo', nodeId: 'RN_repo' }),
      observePullRequests: async () => {
        if (pr) {
          const published = git(remote, 'rev-parse', 'refs/heads/feature')
          pr = { ...pr, headOid: failure === 'drift' && repaired ? base : published }
        }
        return { exact: pr, nearMatches: [] }
      },
      observePullRequestChecks: async () => {
        const candidate = pr!.headOid as string
        const failing = candidate === initial
        const checks = [{ id: 'CR_1', databaseId: '42', app: null, bucket: failing ? 'fail' : 'pass',
          conclusion: failing ? 'FAILURE' : 'SUCCESS', kind: 'check-run', name: 'build', status: 'COMPLETED', url: null }]
        if (!failing) pr = { ...pr!, state: 'MERGED' }
        return { baseRefOid: base, checks, draft: false, headOid: candidate, mergeable: 'MERGEABLE', number: 80, state: 'OPEN' }
      },
      observeCheckLog: async (input: unknown) => { observedLogs.push(input); return 'exact job failed: expected fixed' },
      createPullRequest: async ({ body, title }: { body: string; title: string }) => {
        pr = { baseBranch: 'main', baseOid: base, baseRepositoryId: 'R_repo', baseRepositoryNodeId: 'RN_repo',
          body, draft: false, headBranch: 'feature', headOid: initial, headRepositoryId: 'R_repo',
          headRepositoryNodeId: 'RN_repo', id: 'PR_node', number: 80, state: 'OPEN', title,
          url: 'https://github.com/owner/repo/pull/80' }
      },
      updatePullRequest: async ({ body, title }: { body: string; title: string }) => {
        pr = { ...pr!, body, title }
        if (failure === 'pr-update' && repaired && !faultUsed) { faultUsed = true; throw new Error('lost PR update response') }
      },
    } as unknown as GithubAuthority
    ledger.setRepositoryPublicationRoute({ actorId: 'A_actor', actorLogin: 'owner', actorNodeId: 'AN_actor', backend: 'gh', backendVersion: 'test',
      baseBranch: 'main', baseRepositoryId: 'R_repo', baseRepositoryName: 'owner/repo', baseRepositoryNodeId: 'RN_repo',
      credentialSource: 'GH_TOKEN', forgeHost: 'github.com', headBranch: 'feature', headOwner: 'owner',
      headRepositoryId: 'R_repo', headRepositoryName: 'owner/repo', headRepositoryNodeId: 'RN_repo', networkRootRepositoryId: 'R_repo',
      observedAt: '2026-09-02T00:00:00.000Z', repoRoot: root })
    const options = { ciClock: { sleep: async () => {} }, githubAuthority: authority, intent: 'ONM-100: repair CI',
      ...(failure === 'timeout-stop' ? { cliFlags: { fixer: { timeout_ms: 100, auto_fix: { max_rounds: 0 } } } } : {}),
      publicationDestination: destination, publicationRunner: runner }
    let result: Awaited<ReturnType<typeof runPipeline>>
    if (failure === 'pr-update') {
      await assert.rejects(runPipeline(options, orca, new GitShell({ repo: root }), ledger), /lost PR update response/)
      assert.equal(ledger.remoteReceipt(id, 'candidate-publication')!.candidate_commit_oid, repaired)
      assert.equal(ledger.remoteReceipt(id, 'pull-request-binding')!.candidate_commit_oid, initial)
      assert.equal(await observeBoundPullRequest(authority, ledger, id, repaired!), null)
      result = await runPipeline({ ...options, resumeRunId: id }, orca, new GitShell({ repo: root }), ledger)
    } else if (failure === 'custody' || failure === 'validation' || failure === 'publication-receipt') {
      await assert.rejects(runPipeline(options, orca, new GitShell({ repo: root }), ledger), /crash|revalidation interrupted/)
      assert.notEqual(ledger.runStatus(id), 'passed')
      assert.equal(ledger.remoteReceipt(id, 'candidate-publication')!.candidate_commit_oid, initial)
      if (failure === 'validation') assert.throws(() => terminalCandidate(ledger!, id), /revalidation|checkpoint|candidate/)
      if (failure === 'custody') assert.equal(ledger.ciRepairs(id).at(-1)!.status, 'running')
      result = await runPipeline({ ...options, resumeRunId: id }, orca, new GitShell({ repo: root }), ledger)
    } else if (failure === 'timeout-stop') {
      await assert.rejects(runPipeline(options, orca, new GitShell({ repo: root }), ledger), /stop/i)
      assert.equal(ledger.runStatus(id), 'cancelled')
      assert.equal(ledger.ciRepairs(id).length, 1)
      assert.equal(ledger.ciRepairs(id)[0].status, 'failed')
      assert.equal(repairLaunches, 1)
      assert.equal(gateWaits, 2)
      assert.match(questions.at(-1)!, /exhaust|failed|timeout|timed out/i)
      assert.equal(git(repo, 'rev-parse', 'HEAD'), initial)
      const recoveryHeads = git(repo, 'for-each-ref', '--format=%(objectname)', 'refs/no-mistakes/recover/')
      assert.ok(recoveryHeads.includes(repaired!), 'timed-out repair commit needs a durable recovery ref')
      return
    } else if (failure === 'drift') {
      await assert.rejects(runPipeline(options, orca, new GitShell({ repo: root }), ledger), /head|candidate|pull.request/i)
      assert.notEqual(ledger.runStatus(id), 'passed')
      return
    } else {
      result = await runPipeline(options, orca, new GitShell({ repo: root }), ledger)
    }
    assert.equal(result.verdict, 'passed')
    assert.notEqual(repaired, initial)
    assert.equal(git(remote, 'rev-parse', 'refs/heads/feature'), repaired)
    assert.equal(ledger.remoteReceipt(id, 'candidate-publication')!.candidate_commit_oid, repaired)
    assert.equal(ledger.remoteReceipt(id, 'pull-request-binding')!.candidate_commit_oid, repaired)
    assert.equal(ledger.ciRepairs(id).filter((entry) => entry.status === 'repaired').length, 1)
    assert.equal(repairLaunches, failure === 'repair' ? 2 : 1)
    assert.ok(gateWaits >= 1)
    assert.match(prompts.at(-1)!, /exact job failed: expected fixed/)
    assert.match(prompts.at(-1)!, /untrusted external data/)
    assert.deepEqual(observedLogs[0], { repository: 'owner/repo', candidateCommitOid: initial, checkId: 'CR_1', databaseId: '42' })
    const evidence = ledger.listEvidence(id)
    for (const stage of ['review', 'lint', 'test', 'document', 'push', 'pr']) {
      const rows = evidence.filter((entry) => entry.stage_id === stage)
      assert.ok(rows.some((entry) => entry.candidate_commit_oid === repaired), `missing repaired ${stage}`)
      assert.ok(rows.some((entry) => entry.candidate_commit_oid === initial), `missing original ${stage}`)
    }
    assert.doesNotThrow(() => ledger!.verifyRetainedCompletionAttestation(result.completionAttestation!))
  } finally {
    ledger?.close()
    if (home === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = home
    await rm(temp, { recursive: true, force: true })
  }
}

test('controlled CI failure repairs in isolation, fully revalidates and republishes an exact new candidate', async () => scenario())
test('recovery after PR update failure never substitutes the prior binding', async () => scenario('pr-update'))
test('publication response loss reconciles the exact repaired candidate', async () => scenario('publication'))
test('repair failure requires another explicit decision and preserves durable attempt accounting', async () => scenario('repair'))
test('head drift cannot be attested as passed after repair', async () => scenario('drift'))
test('crash after custody resumes the recorded repair candidate without another worker budget', async () => scenario('custody'))
test('interrupted revalidation revokes old validation authority before recovery', async () => scenario('validation'))
test('crash after publication before receipt reconciles on recovery', async () => scenario('publication-receipt'))
test('wedged repair and exhausted budget require a decision; cancellation retains commits and human waits outlive worker timeout', async () => scenario('timeout-stop'))
