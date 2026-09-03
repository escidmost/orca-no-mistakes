import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  type GithubAuthority,
  type GithubIssueCommentObservation,
  type GithubPullRequestObservation
} from '../scripts/github.ts'
import {
  DomainLedger,
  installAbortReaping,
  runPipeline,
  type Finding,
  type FixerChangesVerdict,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult
} from '../scripts/orca-no-mistakes.ts'

const oid = (value: number): string => value.toString(16).padStart(40, '0')
const pass = (summary: string): StageReport => ({ findings: [], summary })
const AUTO_FIX_CONFIG =
  'auto_fix:\n  allow_review_autofix: true\n  guardrails: strict\n'

const finding: Finding = {
  action: 'auto-fix',
  description: 'Clean post-fixer recovery test.',
  id: 'review-clean-recovery',
  severity: 'error'
}

class TestGit implements GitOperations {
  readonly baseOid = oid(100)
  headOid: string
  readonly root: string
  readonly trustedConfig: string
  readonly fixerHead: string
  failOnNextHead = false

  constructor(root: string, headOid: string, trustedConfig: string, fixerHead: string) {
    this.root = root
    this.headOid = headOid
    this.trustedConfig = trustedConfig
    this.fixerHead = fixerHead
  }

  async assertReady() {
    return {
      base: 'main',
      baseOid: this.baseOid,
      branch: 'feature',
      head: this.headOid,
      root: this.root
    }
  }

  async assertClean(): Promise<void> {}

  async assertFixerChangesAllowed(): Promise<FixerChangesVerdict> {
    return { changed: true, guardrailViolations: [] }
  }

  async head(): Promise<string> {
    if (this.failOnNextHead) {
      this.failOnNextHead = false
      throw new Error('transient git.head failure after review fix')
    }
    return this.headOid
  }

  async diffBase(): Promise<string> {
    return ''
  }

  async rebase(): Promise<StageReport> {
    return { ...pass('rebased'), rebaseUpstreamHead: this.baseOid }
  }

  async resolveRefSha(): Promise<string> {
    return this.baseOid
  }

  async showFile(): Promise<string | undefined> {
    return this.trustedConfig || undefined
  }

  async pathExists(): Promise<boolean> {
    return this.trustedConfig.length > 0
  }

  async policySha256(): Promise<string> {
    return 'f'.repeat(64)
  }

  async resolveBaseOid(): Promise<string> {
    return this.baseOid
  }

  async applyWorktreeCommits(
    _sourcePath: string,
    expectedHead: string,
    expectedSourceHead: string
  ): Promise<boolean> {
    if (this.headOid !== expectedHead) return false
    this.headOid = expectedSourceHead
    return true
  }

  async headOf(): Promise<string> {
    return this.fixerHead
  }

  async worktreeIsReusable(): Promise<boolean> {
    return false
  }

  async anchorRecoveryRef(): Promise<void> {}
}

class TestOrca implements OrcaOperations {
  readonly runId: string
  readonly reviewDispatches: string[] = []
  readonly fixerDispatches: string[] = []
  reviewReports: StageReport[] = []
  #task = 0
  #dispatch = 0

  constructor(runId: string) {
    this.runId = runId
  }

  async createRun(): Promise<string> {
    return this.runId
  }

  async createTask(): Promise<string> {
    return `task-${++this.#task}`
  }

  onStartWorker?: (launch: WorkerLaunch, dispatchId: string) => void

  async startWorker(taskId: string, launch: WorkerLaunch): Promise<WorkerResult> {
    const dispatchId = `dispatch-${++this.#dispatch}`
    if (launch.stage === 'review' && launch.role === 'reviewer') {
      this.reviewDispatches.push(dispatchId)
    }
    if (launch.stage === 'review' && launch.role === 'fixer') {
      this.fixerDispatches.push(dispatchId)
    }
    this.onStartWorker?.(launch, dispatchId)
    const queued =
      launch.role === 'reviewer' ? this.reviewReports.shift() : undefined
    return {
      dispatchId,
      report: queued ?? pass(`${launch.stage} ${launch.role} passed`),
      taskId,
      terminalHandle: `term-${dispatchId}`,
      worktreeId: launch.worktree === 'new-child' ? dispatchId : undefined,
      worktreePath:
        launch.worktree === 'new-child'
          ? path.join(this.runId, dispatchId)
          : undefined
    }
  }

  async finishWorker(worker: WorkerResult): Promise<void> {
    worker.shutdownConfirmed = true
  }

  async removeWorktree(): Promise<void> {}

  async completeTask(): Promise<void> {}

  async createGate(): Promise<string> {
    return 'gate-1'
  }

  async waitForGate(): Promise<string> {
    return 'approve'
  }

  async setWorktreeStatus(): Promise<void> {}
}

function pullRequestFixture(overrides: Partial<GithubPullRequestObservation> = {}): GithubPullRequestObservation {
  return {
    baseBranch: 'main',
    baseOid: oid(100),
    baseRepositoryId: '1',
    baseRepositoryNodeId: 'R_base',
    body: 'human body',
    draft: false,
    headBranch: 'feature',
    headOid: oid(2),
    headRepositoryId: '2',
    headRepositoryNodeId: 'R_head',
    id: 'PR_node',
    number: 7,
    state: 'OPEN',
    title: 'human title',
    url: 'https://github.com/acme/repo/pull/7',
    ...overrides
  }
}

test('Release 2 resume reconciles clean stage settlement without approval before candidate publication', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'onm-clean-resume-r2-'))
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  process.env.ORCA_NO_MISTAKES_HOME = root
  const runId = 'clean-resume-r2'
  const submission = oid(1)
  const fixed = oid(2)
  const ledger = new DomainLedger(':memory:')

  let pullRequest: GithubPullRequestObservation | null = null
  let comments: GithubIssueCommentObservation[] = []
  const authority = {
    createIssueComment: async ({ body }: { body: string }) => {
      comments = [{
        author: { id: 'AN_actor', login: 'owner' },
        body,
        createdAt: '2026-09-02T00:00:00.000Z',
        id: 'IC_node',
        updatedAt: '2026-09-02T00:00:00.000Z',
        url: 'https://github.com/owner/repo/pull/80#issuecomment-1'
      }]
    },
    createPullRequest: async () => {
      pullRequest = pullRequestFixture({
        baseRepositoryId: 'R_repo',
        baseRepositoryNodeId: 'RN_repo',
        headRepositoryId: 'R_repo',
        headRepositoryNodeId: 'RN_repo'
      })
    },
    observeIssueComments: async () => comments,
    observePullRequests: async () => ({ exact: pullRequest, nearMatches: [] }),
    observeRepository: async () => ({ id: 'R_repo', nodeId: 'RN_repo' }),
    updateIssueComment: async () => {}
  } as unknown as GithubAuthority

  let remoteRefHead = ''
  const publicationRunner = async (_executable: string, args: string[]) => {
    if (args[0] === 'config' && args[1] === '--get-regexp') {
      return { code: 1, stderr: '', stdout: '' }
    }
    if (args[0] === 'ls-remote') {
      return remoteRefHead
        ? { code: 0, stderr: '', stdout: remoteRefHead }
        : { code: 2, stderr: '', stdout: '' }
    }
    if (args[0] === 'push') {
      remoteRefHead = `${fixed}\trefs/heads/feature\n`
      return { code: 0, stderr: '', stdout: '' }
    }
    return { code: 0, stderr: '', stdout: '' }
  }

  try {
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
      observedAt: '2026-09-02T00:00:00.000Z',
      repoRoot: root
    })

    const git = new TestGit(root, submission, AUTO_FIX_CONFIG, fixed)
    const first = new TestOrca(runId)
    first.reviewReports = [
      { findings: [finding], summary: 'review found findings' },
      pass('review fixed and clean')
    ]
    first.onStartWorker = (launch) => {
      if (launch.stage === 'review' && launch.role === 'reviewer' && first.reviewDispatches.length === 2) {
        git.failOnNextHead = true
      }
    }

    await assert.rejects(
      runPipeline(
        {
          githubAuthority: authority,
          intent: 'Recover clean review in Release 2',
          publicationDestination: 'https://github.com/owner/repo.git',
          publicationRunner
        },
        first,
        git,
        ledger
      ),
      /transient git.head failure after review fix/
    )

    assert.equal(first.reviewDispatches.length, 2)
    assert.equal(first.fixerDispatches.length, 1)

    // Stage evidence has the clean review round 1 entry
    const evidence = ledger.listEvidence(runId)
    assert.ok(
      evidence.some((entry) => entry.stage_id === 'review' && entry.round_index === 1),
      'clean review round 1 evidence recorded'
    )

    // Checkpoint was recorded for review by the fixer
    const checkpoints = ledger.listCheckpoints(runId)
    assert.ok(
      checkpoints.some((entry) => entry.stage_id === 'review'),
      'review checkpoint recorded'
    )

    // But stage disposition was not recorded before the failure
    const preDispositions = ledger.stageDispositions(runId)
    assert.ok(
      !preDispositions.some((entry) => entry.stage_id === 'review'),
      'review disposition missing before resume'
    )

    // Resume the run
    await installAbortReaping({ pid: process.pid })
    const resumed = new TestOrca('orchestration-resume-clean')
    const result = await runPipeline(
      {
        githubAuthority: authority,
        intent: 'Recover clean review in Release 2',
        publicationDestination: 'https://github.com/owner/repo.git',
        publicationRunner,
        resumeRunId: runId
      },
      resumed,
      git,
      ledger
    )

    // Review was considered complete and not redispatched
    assert.deepEqual(resumed.reviewDispatches, [])

    // Verified: publication and completion succeeded
    assert.equal(result.verdict, 'passed')

    // Verified: review stage disposition was reconciled
    const postDispositions = ledger.stageDispositions(runId)
    const reviewDisposition = postDispositions.find((entry) => entry.stage_id === 'review')
    assert.ok(reviewDisposition, 'review disposition was reconciled on resume')
    assert.equal(reviewDisposition?.disposition, 'satisfied')
  } finally {
    ledger.close()
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome
    await rm(root, { force: true, recursive: true })
  }
})
