import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { CommandRunner } from '../scripts/github.ts'
import {
  DomainLedger,
  evidenceSha256,
  sha256,
  type RepositoryPublicationRouteInput
} from '../scripts/ledger.ts'
import {
  admitCandidatePublication,
  publishCandidate,
  type RepositoryIdentityResolver
} from '../scripts/publication.ts'

const POLICY = 'f'.repeat(64)
const TIME = '2026-09-01T12:00:00.000Z'

type FixtureOptions = {
  evidence?: 'ok' | 'none' | 'failed' | 'advisory' | 'mismatched'
  repositoryRoute?: 'stored' | 'missing' | 'divergent'
  fork?: boolean
}

type Context = {
  artifactPath: string
  attemptId: string
  base: string
  candidate: string
  destination: string
  fork: boolean
  generationToken: number
  ledger: DomainLedger
  resolveRepositoryIdentity: RepositoryIdentityResolver
  runId: string
  temp: string
  third: string
}

const OID = '0123456789abcdef'.repeat(3)

function fixtureRoute(repoRoot: string, fork: boolean): RepositoryPublicationRouteInput {
  return {
    actorId: 'A1',
    actorLogin: 'owner',
    actorNodeId: 'AN1',
    backend: 'gh',
    backendVersion: 'v1',
    baseBranch: 'main',
    baseRepositoryId: 'R_base',
    baseRepositoryName: 'owner/repo',
    baseRepositoryNodeId: 'RN_base',
    credentialSource: 'GH_TOKEN',
    forgeHost: 'github.com',
    headBranch: 'feature',
    headOwner: fork ? 'fork-owner' : 'owner',
    headRepositoryId: fork ? 'R_fork' : 'R_base',
    headRepositoryName: fork ? 'fork-owner/repo' : 'owner/repo',
    headRepositoryNodeId: fork ? 'RN_fork' : 'RN_base',
    networkRootRepositoryId: 'R_base',
    observedAt: TIME,
    repoRoot
  }
}

async function fixture(name: string, options: FixtureOptions = {}): Promise<Context> {
  const fork = options.fork === true
  const evidenceMode = options.evidence ?? 'ok'
  const repositoryRoute = options.repositoryRoute ?? 'stored'
  const temp = await mkdtemp(path.join(tmpdir(), `onm-pub-integrity-${name}-`))
  const repoRoot = path.join(temp, 'source')
  await mkdir(repoRoot, { recursive: true })
  const base = `${OID}1`
  const candidate = `${OID}2`
  const third = `${OID}3`
  const destination = `https://github.com/${fork ? 'fork-owner' : 'owner'}/repo.git`

  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
  const runId = `run-${name}`
  const attemptId = `attempt-${name}`
  if (repositoryRoute === 'stored') {
    ledger.setRepositoryPublicationRoute(fixtureRoute(repoRoot, fork))
  }
  ledger.startRun({
    baseBranch: 'main',
    branch: 'feature',
    intent: 'Publish the exact candidate.',
    policySha256: POLICY,
    repoRoot,
    runId,
    stagePlan: [
      { requirement: 'required', stageId: 'lint' },
      { requirement: 'required', stageId: 'push' }
    ],
    submissionCommitOid: base
  })
  if (repositoryRoute === 'missing') {
    ledger.recordPublicationRoute({
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_base',
      runId
    })
  }
  if (repositoryRoute === 'divergent') {
    ledger.setRepositoryPublicationRoute(fixtureRoute(repoRoot, fork))
    ledger.recordPublicationRoute({
      baseBranch: 'main',
      baseRepositoryId: 'R_base',
      forgeHost: 'github.com',
      headBranch: 'feature',
      headOwner: 'owner',
      headRepositoryId: 'R_other',
      runId
    })
  }
  ledger.recordCheckpoint({
    inputCommitOid: base,
    outputCommitOid: candidate,
    roundIndex: 0,
    runId,
    stageId: 'lint'
  })
  if (evidenceMode !== 'none') {
    const artifact = 'lint evidence\n'
    const artifactPath = path.join(temp, 'lint.json')
    await writeFile(artifactPath, artifact)
    const entry = {
      artifactSha256: sha256(artifact),
      baseCommitOid: base,
      candidateCommitOid: evidenceMode === 'mismatched' ? third : candidate,
      exitCode: evidenceMode === 'failed' ? 1 : 0,
      round: 0,
      runId,
      stage: 'lint',
      summary: evidenceMode === 'failed' ? 'lint failed' : 'clean',
      workerIdentity: evidenceMode === 'advisory'
        ? 'coordinator:fixer-guardrail-advisory'
        : 'lint-worker'
    }
    const digest = evidenceSha256(entry)
    ledger.recordEvidence({
      artifactPath,
      artifactSha256: entry.artifactSha256,
      baseCommitOid: entry.baseCommitOid,
      candidateCommitOid: entry.candidateCommitOid,
      evidenceSha256: digest,
      exitCode: entry.exitCode,
      roundIndex: entry.round,
      runId,
      stageId: entry.stage,
      summary: entry.summary,
      workerIdentity: entry.workerIdentity
    })
    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: digest,
      runId,
      stageId: 'lint'
    })
  } else {
    ledger.recordStageDisposition({ disposition: 'satisfied', runId, stageId: 'lint' })
  }
  const generationToken = ledger.acquireLease({ branch: 'feature', repoRoot, runId })
  ledger.startAttempt({
    actorIdentity: 'operator',
    attemptId,
    coordinatorIdentity: 'coordinator',
    generationToken,
    runId,
    startedAt: TIME
  })
  return {
    artifactPath: path.join(temp, 'artifacts', 'push.json'),
    attemptId,
    base,
    candidate,
    destination,
    fork,
    generationToken,
    ledger,
    resolveRepositoryIdentity: async () => ({
      id: fork ? 'R_fork' : 'R_base',
      nodeId: fork ? 'RN_fork' : 'RN_base'
    }),
    runId,
    temp,
    third
  }
}

function fakeRemote(initialHead: string | null): {
  counts: () => { reads: number; pushes: number }
  pushes: () => string[][]
  runner: CommandRunner
} {
  let head = initialHead
  let reads = 0
  let pushCount = 0
  const pushes: string[][] = []
  const runner: CommandRunner = async (_executable, args) => {
    if (args[0] === 'config') return { code: 1, stdout: '', stderr: '' }
    if (args[0] === 'ls-remote') {
      reads += 1
      if (head === null) return { code: 2, stdout: '', stderr: '' }
      return { code: 0, stdout: `${head}\t${args[4]}\n`, stderr: '' }
    }
    if (args[0] === 'push') {
      pushCount += 1
      pushes.push([...args])
      const lease = args.find((argument) => argument.startsWith('--force-with-lease='))
      const expected = lease === undefined ? undefined : lease.split(':')[1]
      if (expected === undefined || (head ?? '') !== expected) {
        return { code: 1, stdout: '', stderr: 'fetch first' }
      }
      head = args[4]!.split(':')[0]!
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 127, stdout: '', stderr: 'unexpected command' }
  }
  return {
    counts: () => ({ reads, pushes: pushCount }),
    pushes: () => pushes,
    runner
  }
}

async function admit(context: Context, remote: ReturnType<typeof fakeRemote>, destination: string) {
  return admitCandidatePublication({
    ledger: context.ledger,
    runId: context.runId,
    destination,
    resolveRepositoryIdentity: context.resolveRepositoryIdentity,
    runner: remote.runner,
    observedAt: TIME
  })
}

async function publish(
  context: Context,
  remote: ReturnType<typeof fakeRemote>,
  destination: string
) {
  return publishCandidate({
    ledger: context.ledger,
    runId: context.runId,
    attemptId: context.attemptId,
    generationToken: context.generationToken,
    destination,
    resolveRepositoryIdentity: context.resolveRepositoryIdentity,
    artifactPath: context.artifactPath,
    workerIdentity: 'publisher',
    runner: remote.runner,
    now: () => TIME
  })
}

test('admission rejects destinations that are not the stored head repository', async (t) => {
  const localDestination = (context: Context) => path.join(context.temp, 'remote.git')
  for (const [name, destinationOf, message] of [
    ['other-repository', (context: Context) => 'https://github.com/owner/other.git', /does not name the stored head repository/],
    ['credential-bearing', (context: Context) => 'https://user:token@github.com/owner/repo.git', /credential-free github\.com repository/],
    ['local-transport', localDestination, /credential-free github\.com repository/],
    ['repository-shorthand', () => 'owner/repo', /credential-free github\.com repository/]
  ] as const) {
    await t.test(name, async () => {
      const context = await fixture(`admit-reject-${name}`)
      try {
        const remote = fakeRemote(null)
        await assert.rejects(
          admit(context, remote, destinationOf(context)),
          message
        )
        assert.deepEqual(remote.counts(), { reads: 0, pushes: 0 })
        assert.equal(context.ledger.publicationBaseline(context.runId), undefined)
      } finally {
        context.ledger.close()
        await rm(context.temp, { force: true, recursive: true })
      }
    })
  }
})

test('admission rejects run routes that are not bound to the stored repository route', async (t) => {
  for (const [name, repositoryRoute, message] of [
    ['missing', 'missing', /no stored repository publication route/],
    ['divergent', 'divergent', /does not match the stored repository route/]
  ] as const) {
    await t.test(name, async () => {
      const context = await fixture(`route-reject-${name}`, { repositoryRoute })
      try {
        const remote = fakeRemote(null)
        await assert.rejects(admit(context, remote, context.destination), message)
        assert.deepEqual(remote.counts(), { reads: 0, pushes: 0 })
        assert.equal(context.ledger.publicationBaseline(context.runId), undefined)
      } finally {
        context.ledger.close()
        await rm(context.temp, { force: true, recursive: true })
      }
    })
  }
})

test('admission persists the canonical credential-free transport identity', async (t) => {
  for (const fork of [false, true]) {
    await t.test(fork ? 'fork route' : 'same-repository route', async () => {
      const context = await fixture(`canonical-${fork ? 'fork' : 'same'}`, { fork })
      try {
        const remote = fakeRemote(null)
        const admission = await admit(context, remote, context.destination)
        assert.equal(admission.headCommitOid, null)
        assert.equal(
          context.ledger.publicationBaseline(context.runId)?.transport_url,
          `github.com/${fork ? 'fork-owner' : 'owner'}/repo`
        )
      } finally {
        context.ledger.close()
        await rm(context.temp, { force: true, recursive: true })
      }
    })
  }
})

test('a satisfied pre-push stage must bind successful authoritative evidence', async (t) => {
  for (const mode of ['none', 'failed', 'advisory', 'mismatched'] as const) {
    await t.test(mode, async () => {
      const context = await fixture(`evidence-${mode}`, { evidence: mode })
      try {
        const remote = fakeRemote(null)
        await admit(context, remote, context.destination)
        await assert.rejects(
          publish(context, remote, context.destination),
          /does not bind successful authoritative evidence/
        )
        assert.equal(remote.counts().reads, 1)
        assert.equal(remote.counts().pushes, 0)
        assert.equal(existsSync(context.artifactPath), false)
      } finally {
        context.ledger.close()
        await rm(context.temp, { force: true, recursive: true })
      }
    })
  }
})

test('publication pushes through the bound transport and settles the exact candidate', async (t) => {
  for (const fork of [false, true]) {
    await t.test(fork ? 'fork route' : 'same-repository route', async () => {
      const context = await fixture(`publish-${fork ? 'fork' : 'same'}`, { fork })
      try {
        const remote = fakeRemote(null)
        await admit(context, remote, context.destination)
        const scpDestination = `git@github.com:${fork ? 'fork-owner' : 'owner'}/repo.git`
        const result = await publish(context, remote, scpDestination)
        assert.equal(result.outcome, 'created')
        assert.equal(result.candidateCommitOid, context.candidate)
        assert.deepEqual(remote.pushes(), [[
          'push',
          '--porcelain',
          '--force-with-lease=refs/heads/feature:',
          scpDestination,
          `${context.candidate}:refs/heads/feature`
        ]])
        const artifact = await readFile(context.artifactPath, 'utf8')
        const settled = context.ledger
          .listEvidence(context.runId)
          .find((row) => row.stage_id === 'push' && row.round_index === 0)
        assert.equal(settled?.candidate_commit_oid, context.candidate)
        assert.equal(settled?.exit_code, 0)
        assert.equal(settled?.artifact_sha256, sha256(artifact))
      } finally {
        context.ledger.close()
        await rm(context.temp, { force: true, recursive: true })
      }
    })
  }
})

test('a retry of a settled publication reuses the receipt without touching the artifact', async () => {
  const context = await fixture('retry')
  try {
    const remote = fakeRemote(context.candidate)
    await admit(context, remote, context.destination)
    const first = await publish(context, remote, context.destination)
    assert.equal(first.outcome, 'unchanged')
    assert.equal(remote.counts().pushes, 0)
    const artifact = await readFile(context.artifactPath, 'utf8')
    const second = await publish(context, remote, context.destination)
    assert.equal(second.outcome, first.outcome)
    assert.equal(second.receiptSha256, first.receiptSha256)
    assert.equal(second.candidateCommitOid, first.candidateCommitOid)
    assert.equal(await readFile(context.artifactPath, 'utf8'), artifact)
    assert.deepEqual(remote.counts(), { reads: 3, pushes: 0 })
    const settled = context.ledger
      .listEvidence(context.runId)
      .find((row) => row.stage_id === 'push' && row.round_index === 0)
    assert.equal(settled?.artifact_sha256, sha256(artifact))
  } finally {
    context.ledger.close()
    await rm(context.temp, { force: true, recursive: true })
  }
})

test('a settled push round with different facts rejects before any remote access', async () => {
  const context = await fixture('settled-mismatch')
  try {
    const digest = evidenceSha256({
      artifactSha256: 'd'.repeat(64),
      baseCommitOid: context.base,
      candidateCommitOid: context.third,
      exitCode: 0,
      round: 0,
      runId: context.runId,
      stage: 'push',
      summary: 'stale settlement',
      workerIdentity: 'publisher'
    })
    context.ledger.recordEvidence({
      artifactPath: path.join(context.temp, 'stale-push.json'),
      artifactSha256: 'd'.repeat(64),
      baseCommitOid: context.base,
      candidateCommitOid: context.third,
      evidenceSha256: digest,
      exitCode: 0,
      roundIndex: 0,
      runId: context.runId,
      stageId: 'push',
      summary: 'stale settlement',
      workerIdentity: 'publisher'
    })
    const remote = fakeRemote(null)
    await admit(context, remote, context.destination)
    await assert.rejects(
      publish(context, remote, context.destination),
      /already settled with different facts/
    )
    assert.equal(remote.counts().reads, 1)
    assert.equal(remote.counts().pushes, 0)
    assert.equal(existsSync(context.artifactPath), false)
  } finally {
    context.ledger.close()
    await rm(context.temp, { force: true, recursive: true })
  }
})
