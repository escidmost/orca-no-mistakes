import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  GithubAuthorityError,
  type GithubAuthority,
  type GithubIssueCommentObservation,
  type GithubPullRequestObservation
} from '../scripts/github.ts'
import { DomainLedger, evidenceSha256, repositoryIdentityFingerprint, sha256 } from '../scripts/ledger.ts'
import { bindPullRequest, PullRequestBindingError } from '../scripts/pull-request.ts'
import {
  DomainLedger as ExportedDomainLedger,
  installAbortReaping,
  runPipeline,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult
} from '../scripts/orca-no-mistakes.ts'
const OID = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const REPO_ROOT = '/repo'
const STAGES = ['intent', 'rebase', 'review', 'test', 'document', 'lint', 'push', 'pr']

function localStageEvidence(stage: string, round: number, artifactPath: string, runId: string) {
  const entry = {
    artifactSha256: sha256('{}'),
    baseCommitOid: OID,
    candidateCommitOid: OID,
    evidenceSha256: '',
    exitCode: 0,
    round,
    stage,
    summary: `${stage} satisfied.`,
    workerIdentity: 'coordinator'
  }
  entry.evidenceSha256 = evidenceSha256({ ...entry, runId })
  return { ...entry, artifactPath }
}

function pullRequestFixture(overrides: Partial<GithubPullRequestObservation> = {}): GithubPullRequestObservation {
  return {
    baseBranch: 'main',
    baseOid: BASE,
    baseRepositoryId: '1',
    baseRepositoryNodeId: 'R_base',
    body: 'human body',
    draft: false,
    headBranch: 'feature',
    headOid: OID,
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

function startNextAttempt(ledger: DomainLedger, runId: string, attemptId: string): number {
  ledger.releaseLease(runId)
  const token = ledger.acquireLease({ branch: 'feature', repoRoot: REPO_ROOT, runId })
  ledger.startAttempt({
    actorIdentity: 'operator',
    attemptId,
    coordinatorIdentity: 'coordinator',
    generationToken: token,
    runId,
    startedAt: new Date().toISOString()
  })
  return token
}

async function setupLedgerWithSettledPush(home: string, runId: string, intent: string) {
  const ledger = new DomainLedger(':memory:')
  const route = {
    baseBranch: 'main',
    baseRepositoryId: '1',
    forgeHost: 'github.com',
    headBranch: 'feature',
    headOwner: 'forker',
    headRepositoryId: '2'
  }
  ledger.startRun({
    baseBranch: 'main',
    branch: 'feature',
    intent,
    policySha256: 'b'.repeat(64),
    repoRoot: REPO_ROOT,
    runId,
    stagePlan: STAGES.map((stageId) => ({ requirement: 'required' as const, stageId })),
    submissionCommitOid: OID
  })
  const fingerprint = ledger.setRepositoryPublicationRoute({
    actorId: 'actor',
    actorLogin: 'bot',
    actorNodeId: 'A_node',
    backend: 'gh',
    backendVersion: 'test',
    baseBranch: route.baseBranch,
    baseRepositoryId: route.baseRepositoryId,
    baseRepositoryName: 'acme/repo',
    baseRepositoryNodeId: 'R_base',
    credentialSource: 'GITHUB_TOKEN',
    forgeHost: 'github.com',
    headBranch: route.headBranch,
    headOwner: route.headOwner,
    headRepositoryId: route.headRepositoryId,
    headRepositoryName: 'forker/repo',
    headRepositoryNodeId: 'R_head',
    networkRootRepositoryId: '1',
    observedAt: '2026-09-01T00:00:00.000Z',
    repoRoot: REPO_ROOT
  })
  for (const [index, stage] of STAGES.slice(0, 6).entries()) {
    const artifactPath = path.join(home, `${stage}.json`)
    await writeFile(artifactPath, '{}')
    const entry = localStageEvidence(stage, index, artifactPath, runId)
    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: entry.evidenceSha256,
      runId,
      stageId: stage
    })
    ledger.recordEvidence({
      artifactPath,
      artifactSha256: entry.artifactSha256,
      baseCommitOid: entry.baseCommitOid,
      candidateCommitOid: entry.candidateCommitOid,
      evidenceSha256: entry.evidenceSha256,
      exitCode: entry.exitCode,
      roundIndex: entry.round,
      runId,
      stageId: stage,
      summary: entry.summary,
      workerIdentity: entry.workerIdentity
    })
  }
  const generation = ledger.acquireLease({ branch: 'feature', repoRoot: REPO_ROOT, runId })
  ledger.startAttempt({
    actorIdentity: 'operator',
    attemptId: 'att-push',
    coordinatorIdentity: 'coordinator',
    generationToken: generation,
    runId,
    startedAt: '2026-09-01T00:00:01.000Z'
  })
  const routeFingerprint = ledger.recordPublicationRoute({ ...route, runId })
  assert.equal(repositoryIdentityFingerprint({ base_repository_id: route.baseRepositoryId, forge_host: route.forgeHost, head_owner: route.headOwner, head_repository_id: route.headRepositoryId }), fingerprint)
  ledger.recordPublicationBaseline({
    headCommitOid: null,
    observedAt: '2026-09-01T00:00:02.000Z',
    routeFingerprint,
    runId,
    transportUrl: 'github.com/forker/repo'
  })
  const subject = 'github.com/2:refs/heads/feature'
  const preRead = ledger.recordRemoteObservation({
    attemptId: 'att-push',
    kind: 'publication-head',
    observedAt: '2026-09-01T00:00:02.500Z',
    payload: {
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'forker',
      repositoryId: '2',
      state: 'absent'
    },
    runId,
    subject
  })
  const pushMutation = ledger.recordMutationIntent({
    attemptId: 'att-push',
    createdAt: '2026-09-01T00:00:03.000Z',
    kind: 'candidate-publication',
    payload: { expected: 'absent', update: OID },
    runId,
    targetFingerprint: routeFingerprint
  })
  const pushArtifact = path.join(home, 'push.json')
  await writeFile(pushArtifact, '{}')
  const pushEvidence = localStageEvidence('push', 6, pushArtifact, runId)
  const pushObservation = ledger.recordRemoteObservation({
    attemptId: 'att-push',
    kind: 'publication-head',
    observedAt: '2026-09-01T00:00:04.000Z',
    payload: {
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'forker',
      oid: OID,
      repositoryId: '2'
    },
    runId,
    subject
  })
  ledger.settleRemoteStage({
    checkpoint: { inputCommitOid: OID, outputCommitOid: OID, roundIndex: 6 },
    evidence: {
      artifactPath: pushArtifact,
      artifactSha256: pushEvidence.artifactSha256,
      baseCommitOid: OID,
      candidateCommitOid: OID,
      evidenceSha256: pushEvidence.evidenceSha256,
      exitCode: 0,
      roundIndex: 6,
      runId,
      stageId: 'push',
      summary: pushEvidence.summary,
      workerIdentity: pushEvidence.workerIdentity
    },
    ownership: { branch: 'feature', generationToken: generation, repoRoot: REPO_ROOT },
    receipt: {
      authoritativePostObservationSha256: pushObservation,
      candidateCommitOid: OID,
      kind: 'candidate-publication',
      payload: {
        mutationIntent: pushMutation,
        outcome: 'created',
        postRead: pushObservation,
        preRead,
        routeFingerprint
      }
    },
    runId,
    stageId: 'push'
  })
  return { ledger }
}

test('rejects an indeterminate PR update when authoritative post-read still has the old body and title', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'onm-pr-update-unproven-'))
  const runId = 'unproven-pr-update'
  const { ledger } = await setupLedgerWithSettledPush(home, runId, 'Reject an unproven PR update.')
  const calls: string[] = []
  const pullRequest = pullRequestFixture()
  const authority = {
    createPullRequest: async () => assert.fail('unexpected PR creation'),
    observePullRequests: async () => {
      calls.push('observe')
      return { exact: pullRequest, nearMatches: [] }
    },
    updatePullRequest: async () => {
      calls.push('update')
      throw new GithubAuthorityError('mutation-indeterminate', 'update-pull-request', 'disconnected')
    }
  }
  try {
    const generationToken = startNextAttempt(ledger, runId, 'att-pr-update')
    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(home, 'pr.json'),
        attemptId: 'att-pr-update',
        authority,
        candidateCommitOid: OID,
        content: { body: 'complete pipeline report', title: 'feat: complete report' },
        generationToken,
        ledger,
        pipelineEvidenceRoot: sha256('pipeline'),
        runId,
        workerIdentity: 'coordinator'
      }),
      (error: unknown) => error instanceof PullRequestBindingError &&
        /pull-request body update was not proven by the authoritative post-read/.test(error.message)
    )
    assert.deepEqual(calls, ['observe', 'update', 'observe'])
    assert.equal(ledger.remoteReceipt(runId, 'pull-request-binding'), undefined)
  } finally {
    ledger.close()
    await rm(home, { force: true, recursive: true })
  }
})

class FailAfterApprovalLedgerR2 extends ExportedDomainLedger {
  #failReviewCheckpoint = true

  override recordCheckpoint(
    input: Parameters<ExportedDomainLedger['recordCheckpoint']>[0]
  ): void {
    if (input.stageId === 'review' && this.#failReviewCheckpoint) {
      this.#failReviewCheckpoint = false
      throw new Error('stop after durable approval in Release 2')
    }
    super.recordCheckpoint(input)
  }
}

test('Release 2 resume reconciles approved stage settlement and contiguous checkpoint before publication', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-approved-resume-r2-'))
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME
  process.env.ORCA_NO_MISTAKES_HOME = temp
  const ledger = new FailAfterApprovalLedgerR2(':memory:')
  let dispatch = 0

  const finding: StageReport = {
    findings: [
      {
        action: 'ask-user',
        description: 'Needs a durable approval in R2',
        id: 'review-approval-r2',
        severity: 'error'
      }
    ],
    summary: 'approval required in R2'
  }

  const makeOrca = (runId: string) => {
    const reviewDispatches: string[] = []
    let gates = 0
    let task = 0
    const operations: OrcaOperations = {
      async createRun() {
        return runId
      },
      async createTask() {
        return `task-${++task}`
      },
      async startWorker(taskId: string, launch: WorkerLaunch): Promise<WorkerResult> {
        const dispatchId = `dispatch-${++dispatch}`
        if (launch.stage === 'review') reviewDispatches.push(dispatchId)
        return {
          deliveryId: `delivery-${dispatchId}`,
          dispatchId,
          report:
            launch.stage === 'review'
              ? structuredClone(finding)
              : { findings: [], summary: 'passed' },
          taskId,
          terminalHandle: `term-${dispatchId}`
        }
      },
      async finishWorker(worker) {
        worker.shutdownConfirmed = true
      },
      async removeWorktree() {},
      async completeTask() {},
      async createGate() {
        gates += 1
        return `gate-${gates}`
      },
      async waitForGate() {
        return 'approve'
      },
      async setWorktreeStatus() {}
    }
    return {
      gateCount: () => gates,
      operations,
      reviewDispatches
    }
  }

  const git: GitOperations = {
    async anchorRecoveryRef() {},
    async applyWorktreeCommits() {
      return false
    },
    async assertClean() {},
    async assertFixerChangesAllowed() {
      return { changed: false, guardrailViolations: [] }
    },
    async assertReady() {
      return {
        base: 'main',
        baseOid: BASE,
        branch: 'feature',
        head: OID,
        root: temp
      }
    },
    async diffBase() {
      return ''
    },
    async head() {
      return OID
    },
    async headOf() {
      return OID
    },
    async pathExists() {
      return false
    },
    async policySha256() {
      return 'f'.repeat(64)
    },
    async rebase() {
      return { findings: [], rebaseUpstreamHead: BASE, summary: 'rebased' }
    },
    async resolveBaseOid() {
      return BASE
    },
    async resolveRefSha() {
      return BASE
    },
    async showFile() {
      return undefined
    },
    async worktreeIsReusable() {
      return false
    }
  }

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
    createPullRequest: async ({ body, title }: { body: string; title: string }) => {
      pullRequest = { ...pullRequestFixture({
        baseRepositoryId: 'R_repo',
        baseRepositoryNodeId: 'RN_repo',
        headRepositoryId: 'R_repo',
        headRepositoryNodeId: 'RN_repo'
      }), body, state: 'MERGED', title }
    },
    observeIssueComments: async () => comments,
    observePullRequests: async () => ({ exact: pullRequest, nearMatches: [] }),
    observeRepository: async () => ({ id: 'R_repo', nodeId: 'RN_repo' }),
    updateIssueComment: async () => {},
    updatePullRequest: async ({ body, title }: { body: string; title: string }) => {
      pullRequest = { ...pullRequest!, body, title }
    }
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
      remoteRefHead = `${OID}\trefs/heads/feature\n`
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
      repoRoot: temp
    })

    const first = makeOrca('domain-run-r2')
    await assert.rejects(
      runPipeline(
        {
          githubAuthority: authority,
          intent: 'Resume a previously approved review in Release 2.',
          publicationDestination: 'https://github.com/owner/repo.git',
          publicationRunner
        },
        first.operations,
        git,
        ledger
      ),
      /stop after durable approval in Release 2/
    )

    assert.equal(first.gateCount(), 1)
    assert.equal(first.reviewDispatches.length, 1)
    assert.equal(ledger.runStatus('domain-run-r2'), 'failed')

    // At this point, review checkpoint and disposition rolled back in the first run
    const preCheckpoints = ledger.listCheckpoints('domain-run-r2')
    assert.ok(!preCheckpoints.some((cp) => cp.stage_id === 'review'), 'review checkpoint must not exist yet')
    const preDispositions = ledger.stageDispositions('domain-run-r2')
    assert.ok(!preDispositions.some((dp) => dp.stage_id === 'review'), 'review disposition must not exist yet')

    // Resume the run:
    await installAbortReaping({ pid: process.pid })
    const resumed = makeOrca('orchestration-resume-r2')
    const result = await runPipeline(
      {
        githubAuthority: authority,
        intent: 'Resume a previously approved review in Release 2.',
        publicationDestination: 'https://github.com/owner/repo.git',
        publicationRunner,
        resumeRunId: 'domain-run-r2'
      },
      resumed.operations,
      git,
      ledger
    )

    // Verified: review was skipped without redispatch or gate prompt
    assert.deepEqual(resumed.reviewDispatches, [])
    assert.equal(resumed.gateCount(), 0)

    // Verified: publication and completion succeeded
    assert.equal(result.verdict, 'passed')
    assert.equal(result.completionAttestation?.version, '2.0.0')

    // Verified: review checkpoint and disposition were reconciled
    const postCheckpoints = ledger.listCheckpoints('domain-run-r2')
    assert.ok(postCheckpoints.some((cp) => cp.stage_id === 'review'), 'review checkpoint was reconciled')
    const postDispositions = ledger.stageDispositions('domain-run-r2')
    const reviewDisposition = postDispositions.find((dp) => dp.stage_id === 'review')
    assert.ok(reviewDisposition, 'review disposition was reconciled')
    assert.equal(reviewDisposition?.disposition, 'satisfied')
  } finally {
    await installAbortReaping({ pid: process.pid })
    ledger.close()
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome
    await rm(temp, { force: true, recursive: true })
  }
})
