import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { GithubAuthorityError, type GithubPullRequestObservation } from '../scripts/github.ts'
import { pullRequestArtifacts } from '../scripts/orca-no-mistakes.ts'
import { bindPullRequest, PullRequestBindingError } from '../scripts/pull-request.ts'

const OID = 'a'.repeat(40)
const content = { body: 'complete body', title: 'feat: complete report' }

function pullRequest(overrides: Partial<GithubPullRequestObservation> = {}): GithubPullRequestObservation {
  return {
    baseBranch: 'main',
    baseOid: 'b'.repeat(40),
    baseRepositoryId: '1',
    baseRepositoryNodeId: 'R_base',
    body: content.body,
    draft: false,
    headBranch: 'feature',
    headOid: OID,
    headRepositoryId: '2',
    headRepositoryNodeId: 'R_head',
    id: 'PR_node',
    number: 7,
    state: 'OPEN' as const,
    title: content.title,
    url: 'https://github.com/acme/repo/pull/7',
    ...overrides
  }
}

function harness() {
  const settlements: Array<Record<string, unknown>> = []
  let ownsLease = true
  const ledger = {
    heartbeatLease: () => {},
    ownsLease: () => ownsLease,
    publicationRoute: () => ({
      base_branch: 'main', base_repository_id: '1', forge_host: 'github.com',
      head_branch: 'feature', head_owner: 'forker', head_repository_id: '2',
      route_fingerprint: 'route'
    }),
    recordMutationIntent: () => 'mutation-intent',
    recordRemoteObservation: () => 'post-read',
    remoteReceipt: (_runId: string, kind: string) => kind === 'candidate-publication'
      ? { candidate_commit_oid: OID, receipt_sha256: 'push-receipt' }
      : undefined,
    repositoryPublicationRoute: () => ({
      base_repository_name: 'acme/repo', base_repository_node_id: 'R_base',
      head_repository_name: 'forker/repo', head_repository_node_id: 'R_head',
      route_fingerprint: 'route'
    }),
    run: () => ({ branch: 'feature', repo_root: '/repo' }),
    settleRemoteStage: (input: Record<string, unknown>) => {
      settlements.push(input)
      return { receiptSha256: 'pr-receipt' }
    }
  }
  return { ledger, settlements, setOwnsLease: (value: boolean) => { ownsLease = value } }
}

test('rejects a mismatched candidate-publication receipt before PR binding', async () => {
  const { ledger } = harness()
  let mutations = 0
  const authority = {
    createPullRequest: async () => { mutations += 1 },
    observePullRequests: async () => ({ exact: pullRequest(), nearMatches: [] }),
    updatePullRequest: async () => { mutations += 1 }
  }
  await assert.rejects(
    bindPullRequest({
      artifactPath: '/tmp/unwritten', attemptId: 'attempt', authority,
      candidateCommitOid: 'b'.repeat(40), content, generationToken: 1,
      ledger: ledger as never, pipelineEvidenceRoot: 'c'.repeat(64),
      runId: 'run', workerIdentity: 'coordinator'
    }),
    /candidate publication/
  )
  assert.equal(mutations, 0)
})

test('reconciles indeterminate creation through authoritative post-read', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-indeterminate-'))
  const { ledger, settlements } = harness()
  let pr: GithubPullRequestObservation | null = null
  let createAttempts = 0
  const authority = {
    createPullRequest: async () => {
      createAttempts += 1
      pr = pullRequest()
      throw new GithubAuthorityError('mutation-indeterminate', 'create-pull-request', 'disconnected')
    },
    observePullRequests: async () => ({ exact: pr, nearMatches: [] }),
    updatePullRequest: async () => assert.fail('unexpected update')
  }
  try {
    const result = await bindPullRequest({
      artifactPath: path.join(directory, 'pr.json'),
      attemptId: 'attempt',
      authority,
      candidateCommitOid: OID,
      content,
      generationToken: 1,
      ledger: ledger as never,
      pipelineEvidenceRoot: 'c'.repeat(64),
      runId: 'run',
      sleep: async () => {
        pr = pullRequest({ state: 'MERGED' })
      },
      workerIdentity: 'coordinator'
    })
    assert.equal(createAttempts, 1)
    assert.equal(result.outcome, 'created')
    assert.equal(settlements.length, 1)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('rejects indeterminate creation when authoritative post-read finds no pull request', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-create-fail-'))
  const { ledger } = harness()
  const authority = {
    createPullRequest: async () => {
      throw new GithubAuthorityError('mutation-indeterminate', 'create-pull-request', 'disconnected')
    },
    observePullRequests: async () => ({ exact: null, nearMatches: [] }),
    updatePullRequest: async () => assert.fail('unexpected update')
  }
  try {
    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(directory, 'pr.json'),
        attemptId: 'attempt',
        authority,
        candidateCommitOid: OID,
        content,
        generationToken: 1,
        ledger: ledger as never,
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId: 'run',
        workerIdentity: 'coordinator'
      }),
      /pull-request creation was not proven by the authoritative post-read/
    )
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('rejects mismatched merged pull requests without updating', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-merged-mismatch-'))
  const { ledger } = harness()
  let updateAttempts = 0
  const mergedPr = pullRequest({ body: 'stale body', state: 'MERGED', title: 'stale title' })
  const authority = {
    createPullRequest: async () => assert.fail('unexpected PR creation'),
    observePullRequests: async () => ({ exact: mergedPr, nearMatches: [] }),
    updatePullRequest: async () => {
      updateAttempts += 1
    }
  }
  try {
    await assert.rejects(
      bindPullRequest({
        artifactPath: path.join(directory, 'pr.json'),
        attemptId: 'attempt',
        authority,
        candidateCommitOid: OID,
        content,
        generationToken: 1,
        ledger: ledger as never,
        pipelineEvidenceRoot: 'c'.repeat(64),
        runId: 'run',
        workerIdentity: 'coordinator'
      }),
      /pull-request facts changed before merge/
    )
    assert.equal(updateAttempts, 0)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('pullRequestArtifacts rejects symlinks and fifos without hanging', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-artifacts-safe-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'onm-outside-'))
  try {
    const outsideFile = path.join(outside, 'secret.txt')
    await writeFile(outsideFile, 'outside-content')
    const symlinkPath = path.join(directory, 'symlink.txt')
    await symlink(outsideFile, symlinkPath)

    const fifoPath = path.join(directory, 'fifo.pipe')
    let fifoCreated = false
    try {
      execSync(`mkfifo "${fifoPath}"`)
      fifoCreated = true
    } catch {
      // mkfifo might not be supported in some restricted environments
    }

    const regularFile = path.join(directory, 'valid.txt')
    await writeFile(regularFile, 'valid-artifact-content')

    const artifactDigests = {
      'symlink.txt': createHash('sha256').update('outside-content').digest('hex'),
      ...(fifoCreated ? { 'fifo.pipe': createHash('sha256').update('').digest('hex') } : {}),
      'valid.txt': createHash('sha256').update('valid-artifact-content').digest('hex')
    }
    const artifacts = await pullRequestArtifacts(directory, {
      artifactDigests,
      artifacts: ['symlink.txt', ...(fifoCreated ? ['fifo.pipe'] : []), 'valid.txt'],
      findings: [],
      summary: 'test'
    }, { trustedPublicationApprovals: Object.values(artifactDigests) })

    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0]?.name, 'Valid')
    assert.equal(artifacts[0]?.content, 'valid-artifact-content')
    if (fifoCreated) assert.ok(!artifacts.some((artifact) => artifact.name === 'Fifo'))
  } finally {
    await rm(directory, { force: true, recursive: true })
    await rm(outside, { force: true, recursive: true })
  }
})

test('pullRequestArtifacts redacts secrets crossing the 16 KiB boundary without leaking prefixes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-pr-artifacts-secret-'))
  const secretToken = 'secret-token-super-sensitive-123456789'
  const oldEnv = process.env.TEST_API_TOKEN
  process.env.TEST_API_TOKEN = secretToken
  try {
    const padding = 'x'.repeat(16 * 1024 - 10)
    const fileContent = `${padding}${secretToken}more-content`
    const artifactPath = path.join(directory, 'secret-cross.txt')
    await writeFile(artifactPath, fileContent)

    const digest = createHash('sha256').update(fileContent).digest('hex')
    const artifacts = await pullRequestArtifacts(directory, {
      artifactDigests: { 'secret-cross.txt': digest },
      artifacts: ['secret-cross.txt'],
      findings: [],
      summary: 'test'
    }, { trustedPublicationApprovals: [digest] })

    assert.equal(artifacts.length, 1)
    assert.ok(!artifacts[0]?.content.includes(secretToken))
    for (let len = 4; len < secretToken.length; len += 1) {
      assert.ok(!artifacts[0]?.content.includes(secretToken.slice(0, len)))
    }
    assert.ok(artifacts[0]?.content.includes('[REDACTED]'))
    assert.ok(Buffer.byteLength(artifacts[0]!.content) <= 16 * 1024)
  } finally {
    if (oldEnv === undefined) {
      delete process.env.TEST_API_TOKEN
    } else {
      process.env.TEST_API_TOKEN = oldEnv
    }
    await rm(directory, { force: true, recursive: true })
  }
})
