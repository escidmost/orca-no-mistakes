import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runCommand, type CommandRunner } from '../scripts/github.ts'
import { DomainLedger, evidenceSha256, sha256 } from '../scripts/ledger.ts'
import {
  admitCandidatePublication,
  publishCandidate,
  type RepositoryIdentityResolver
} from '../scripts/publication.ts'

const POLICY = 'f'.repeat(64)
const TIME = '2026-09-01T12:00:00.000Z'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function fixture(
  name: string,
  options: { multiAttemptChain?: boolean } = {}
): Promise<{
  artifactPath: string
  attemptId: string
  base: string
  candidate: string
  destination: string
  generationToken: number
  ledger: DomainLedger
  remote: string
  repo: string
  resolveRepositoryIdentity: RepositoryIdentityResolver
  runner: CommandRunner
  runId: string
  temp: string
  third: string
}> {
  const temp = await mkdtemp(path.join(tmpdir(), `onm-publication-${name}-`))
  const repo = path.join(temp, 'source')
  const remote = path.join(temp, 'remote.git')
  const fork = name.includes('fork')
  const headOwner = fork ? 'fork-owner' : 'owner'
  const destination = `https://github.com/${headOwner}/repo.git`
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '-b', 'main', repo])
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'commit', '--allow-empty', '-m', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'commit', '--allow-empty', '-m', 'candidate')
  const firstCandidate = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'commit', '--allow-empty', '-m', 'third')
  const third = git(repo, 'rev-parse', 'HEAD')
  const candidate = options.multiAttemptChain ? third : firstCandidate
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '--bare', remote])

  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
  const runId = `run-${name}`
  const attemptId = `attempt-${name}`
  ledger.setRepositoryPublicationRoute({
    actorId: 'A_actor',
    actorLogin: 'owner',
    actorNodeId: 'AN_actor',
    backend: 'gh',
    backendVersion: 'test',
    baseBranch: 'main',
    baseRepositoryId: 'R_base',
    baseRepositoryName: 'owner/repo',
    baseRepositoryNodeId: 'RN_base',
    credentialSource: 'GH_TOKEN',
    forgeHost: 'github.com',
    headBranch: 'feature',
    headOwner,
    headRepositoryId: fork ? 'R_fork' : 'R_base',
    headRepositoryName: `${headOwner}/repo`,
    headRepositoryNodeId: fork ? 'RN_fork' : 'RN_base',
    networkRootRepositoryId: 'R_base',
    observedAt: TIME,
    repoRoot: repo
  })
  ledger.startRun({
    baseBranch: 'main',
    branch: 'feature',
    intent: 'Publish the exact candidate.',
    policySha256: POLICY,
    repoRoot: repo,
    runId,
    stagePlan: [
      { requirement: 'required', stageId: 'lint' },
      { requirement: 'required', stageId: 'push' }
    ],
    submissionCommitOid: base
  })
  const lintCheckpoints: Array<[string, string, number]> = options.multiAttemptChain
    ? [[base, firstCandidate, 1], [base, firstCandidate, 1], [firstCandidate, candidate, 2], [firstCandidate, candidate, 2]]
    : [[base, candidate, 0]]
  for (const [inputCommitOid, outputCommitOid, roundIndex] of lintCheckpoints) {
    ledger.recordCheckpoint({
      inputCommitOid,
      outputCommitOid,
      roundIndex,
      runId,
      stageId: 'lint'
    })
  }
  const lintArtifactPath = path.join(temp, 'lint.json')
  const lintArtifact = 'lint passed\n'
  await writeFile(lintArtifactPath, lintArtifact)
  const lintEvidence = {
    artifactSha256: sha256(lintArtifact),
    baseCommitOid: base,
    candidateCommitOid: candidate,
    exitCode: 0,
    round: options.multiAttemptChain ? 2 : 0,
    runId,
    stage: 'lint',
    summary: 'lint passed',
    workerIdentity: 'lint-worker'
  }
  const lintEvidenceSha256 = evidenceSha256(lintEvidence)
  ledger.recordEvidence({
    artifactPath: lintArtifactPath,
    artifactSha256: lintEvidence.artifactSha256,
    baseCommitOid: base,
    candidateCommitOid: candidate,
    evidenceSha256: lintEvidenceSha256,
    exitCode: 0,
    roundIndex: lintEvidence.round,
    runId,
    stageId: 'lint',
    summary: lintEvidence.summary,
    workerIdentity: lintEvidence.workerIdentity
  })
  ledger.recordStageDisposition({
    disposition: 'satisfied',
    evidenceSha256: lintEvidenceSha256,
    runId,
    stageId: 'lint'
  })
  const generationToken = ledger.acquireLease({ branch: 'feature', repoRoot: repo, runId })
  ledger.startAttempt({
    actorIdentity: 'operator',
    attemptId,
    coordinatorIdentity: 'coordinator',
    generationToken,
    runId,
    startedAt: TIME
  })
  const resolveRepositoryIdentity: RepositoryIdentityResolver = async () => ({
    id: fork ? 'R_fork' : 'R_base',
    nodeId: fork ? 'RN_fork' : 'RN_base'
  })
  const runner: CommandRunner = (executable, args, options) => runCommand(
    executable,
    args.map((argument) => argument === destination ? remote : argument),
    options
  )
  return {
    artifactPath: path.join(temp, 'artifacts', 'push.json'),
    attemptId,
    base,
    candidate,
    destination,
    generationToken,
    ledger,
    remote,
    repo,
    resolveRepositoryIdentity,
    runner,
    runId,
    temp,
    third
  }
}

async function publish(
  context: Awaited<ReturnType<typeof fixture>>,
  options: { reconcileExactCandidate?: boolean; runner?: CommandRunner } = {}
) {
  return publishCandidate({
    ledger: context.ledger,
    runId: context.runId,
    attemptId: context.attemptId,
    generationToken: context.generationToken,
    destination: context.destination,
    resolveRepositoryIdentity: context.resolveRepositoryIdentity,
    artifactPath: context.artifactPath,
    workerIdentity: 'publisher',
    reconcileExactCandidate: options.reconcileExactCandidate,
    runner: options.runner ?? context.runner,
    now: () => TIME
  })
}

async function admit(
  context: Awaited<ReturnType<typeof fixture>>,
  options: { runner?: CommandRunner } = {}
) {
  return admitCandidatePublication({
    ledger: context.ledger,
    runId: context.runId,
    destination: context.destination,
    resolveRepositoryIdentity: context.resolveRepositoryIdentity,
    runner: options.runner ?? context.runner,
    observedAt: TIME
  })
}

function remoteHead(context: Awaited<ReturnType<typeof fixture>>): string {
  return git(context.repo, 'ls-remote', '--refs', context.remote, 'refs/heads/feature').split('\t')[0]!
}

function push(context: Awaited<ReturnType<typeof fixture>>, oid: string): void {
  git(context.repo, 'push', '--force', context.remote, `${oid}:refs/heads/feature`)
}

test('same-repository and fork publication create the exact absent head', async (t) => {
  for (const name of ['same-create', 'fork-create']) {
    await t.test(name, async () => {
      const context = await fixture(name)
      try {
        const admission = await admit(context)
        assert.equal(admission.headCommitOid, null)
        let pushArgs: string[] | undefined
        const runner: CommandRunner = async (executable, args, options) => {
          if (args[0] === 'push') pushArgs = [...args]
          return context.runner(executable, args, options)
        }
        const result = await publish(context, { runner })
        assert.equal(result.outcome, 'created')
        assert.deepEqual(pushArgs, [
          'push',
          '--porcelain',
          '--force-with-lease=refs/heads/feature:',
          context.destination,
          `${context.candidate}:refs/heads/feature`
        ])
        assert.equal(remoteHead(context), context.candidate)
        assert.equal(
          context.ledger.remoteReceipt(context.runId, 'candidate-publication')?.candidate_commit_oid,
          context.candidate
        )
      } finally {
        context.ledger.close()
        await rm(context.temp, { force: true, recursive: true })
      }
    })
  }
})

test('replacement uses the exact fully qualified compare-and-swap arguments', async () => {
  const context = await fixture('replace')
  try {
    push(context, context.base)
    await admit(context)
    let pushArgs: string[] | undefined
    const runner: CommandRunner = async (executable, args, options) => {
      if (args[0] === 'push') pushArgs = [...args]
      return context.runner(executable, args, options)
    }
    const result = await publish(context, { runner })
    assert.equal(result.outcome, 'updated')
    assert.deepEqual(pushArgs, [
      'push',
      '--porcelain',
      `--force-with-lease=refs/heads/feature:${context.base}`,
      context.destination,
      `${context.candidate}:refs/heads/feature`
    ])
    assert.equal(remoteHead(context), context.candidate)
  } finally {
    context.ledger.close()
    await rm(context.temp, { force: true, recursive: true })
  }
})

test('an unchanged candidate is reconciled without a push', async () => {
  const context = await fixture('no-op')
  try {
    push(context, context.candidate)
    await admit(context)
    let pushes = 0
    const runner: CommandRunner = async (executable, args, options) => {
      if (args[0] === 'push') pushes += 1
      return context.runner(executable, args, options)
    }
    const result = await publish(context, { runner })
    assert.equal(result.outcome, 'unchanged')
    assert.equal(pushes, 0)
  } finally {
    context.ledger.close()
    await rm(context.temp, { force: true, recursive: true })
  }
})

test('publication accepts a stage fixer chain spanning attempts', async () => {
  const context = await fixture('multi-attempt-chain', { multiAttemptChain: true })
  try {
    await admit(context)
    const result = await publish(context)
    assert.equal(result.outcome, 'created')
    assert.equal(remoteHead(context), context.candidate)
  } finally {
    context.ledger.close()
    await rm(context.temp, { force: true, recursive: true })
  }
})

test('stale creation, movement, and deletion reject without mutation', async (t) => {
  for (const scenario of ['creation', 'movement', 'deletion'] as const) {
    await t.test(scenario, async () => {
      const context = await fixture(`stale-${scenario}`)
      try {
        if (scenario !== 'creation') push(context, context.base)
        await admit(context)
        if (scenario === 'creation') push(context, context.base)
        if (scenario === 'movement') push(context, context.third)
        if (scenario === 'deletion') git(context.repo, 'push', context.remote, ':refs/heads/feature')
        let pushes = 0
        const runner: CommandRunner = async (executable, args, options) => {
          if (args[0] === 'push') pushes += 1
          return context.runner(executable, args, options)
        }
        await assert.rejects(publish(context, { runner }), /changed after admission/)
        assert.equal(pushes, 0)
      } finally {
        context.ledger.close()
        await rm(context.temp, { force: true, recursive: true })
      }
    })
  }
})

test('publication rejects destination, branch-chain, and lease changes before mutation', async (t) => {
  await t.test('destination', async () => {
    const context = await fixture('destination-reject')
    try {
      await admit(context)
      await assert.rejects(
        publishCandidate({
          ledger: context.ledger,
          runId: context.runId,
          attemptId: context.attemptId,
          generationToken: context.generationToken,
          destination: `${context.destination}-changed`,
          resolveRepositoryIdentity: context.resolveRepositoryIdentity,
          artifactPath: context.artifactPath,
          workerIdentity: 'publisher',
          runner: context.runner
        }),
        /differs from the immutable admission route/
      )
    } finally {
      context.ledger.close()
      await rm(context.temp, { force: true, recursive: true })
    }
  })

  await t.test('lease', async () => {
    const context = await fixture('lease-reject')
    try {
      await admit(context)
      await assert.rejects(
        publishCandidate({
          ledger: context.ledger,
          runId: context.runId,
          attemptId: context.attemptId,
          generationToken: context.generationToken + 1,
          destination: context.destination,
          resolveRepositoryIdentity: context.resolveRepositoryIdentity,
          artifactPath: context.artifactPath,
          workerIdentity: 'publisher',
          runner: context.runner
        }),
        /lease is no longer owned/
      )
    } finally {
      context.ledger.close()
      await rm(context.temp, { force: true, recursive: true })
    }
  })

  await t.test('lease lost before push', async () => {
    const context = await fixture('lease-race-reject')
    try {
      await admit(context)
      let leaseChecks = 0
      context.ledger.ownsLease = () => ++leaseChecks === 1
      let pushes = 0
      const runner: CommandRunner = async (executable, args, options) => {
        if (args[0] === 'push') pushes += 1
        return context.runner(executable, args, options)
      }
      await assert.rejects(publish(context, { runner }), /lease was lost before mutation/)
      assert.equal(pushes, 0)
    } finally {
      context.ledger.close()
      await rm(context.temp, { force: true, recursive: true })
    }
  })

  await t.test('candidate chain', async () => {
    const context = await fixture('chain-reject')
    try {
      await admit(context)
      context.ledger.recordCheckpoint({
        inputCommitOid: context.third,
        outputCommitOid: context.candidate,
        roundIndex: 1,
        runId: context.runId,
        stageId: 'lint'
      })
      await assert.rejects(publish(context), /does not extend the contiguous candidate chain/)
    } finally {
      context.ledger.close()
      await rm(context.temp, { force: true, recursive: true })
    }
  })
})

test('admission rejects authentication failures and malformed remote output', async (t) => {
  for (const [name, result, message] of [
    ['authentication', { code: 128, stdout: '', stderr: 'authentication failed' }, /authentication failed/],
    ['malformed', { code: 0, stdout: 'not-an-oid\trefs/heads/feature\n', stderr: '' }, /malformed/]
  ] as const) {
    await t.test(name, async () => {
      const context = await fixture(`read-${name}`)
      try {
        await assert.rejects(
          admit(context, {
            runner: async (_executable, args) => args[0] === 'config'
              ? { code: 1, stdout: '', stderr: '' }
              : result
          }),
          message
        )
        assert.equal(context.ledger.publicationBaseline(context.runId), undefined)
      } finally {
        context.ledger.close()
        await rm(context.temp, { force: true, recursive: true })
      }
    })
  }
})

test('uncertain push results succeed only when the post-read proves the candidate', async (t) => {
  for (const mode of ['timeout', 'disconnect'] as const) {
    await t.test(mode, async () => {
      const context = await fixture(`uncertain-${mode}`)
      try {
        await admit(context)
        const runner: CommandRunner = async (executable, args, options) => {
          const result = await context.runner(executable, args, options)
          if (args[0] !== 'push') return result
          if (mode === 'disconnect') throw new Error('connection dropped')
          return { ...result, code: 124, stderr: 'timed out' }
        }
        const result = await publish(context, { runner })
        assert.equal(result.outcome, 'created')
        assert.equal(remoteHead(context), context.candidate)
        const artifact = JSON.parse(await readFile(context.artifactPath, 'utf8')) as {
          pushExitCode: number | null
        }
        assert.equal(artifact.pushExitCode, mode === 'timeout' ? 124 : null)
      } finally {
        context.ledger.close()
        await rm(context.temp, { force: true, recursive: true })
      }
    })
  }
})

test('a successful-looking push is rejected when the post-read does not match', async () => {
  const context = await fixture('post-mismatch')
  try {
    push(context, context.base)
    await admit(context)
    const runner: CommandRunner = async (executable, args, options) => {
      if (args[0] === 'push') return { code: 0, stdout: 'ok', stderr: '' }
      return context.runner(executable, args, options)
    }
    await assert.rejects(publish(context, { runner }), /post-read did not prove the exact candidate/)
    assert.equal(context.ledger.remoteReceipt(context.runId, 'candidate-publication'), undefined)
    assert.equal(remoteHead(context), context.base)
  } finally {
    context.ledger.close()
    await rm(context.temp, { force: true, recursive: true })
  }
})

test('explicit reconciliation adopts only an already-present exact candidate', async () => {
  const context = await fixture('reconcile')
  try {
    await admit(context)
    push(context, context.candidate)
    await assert.rejects(publish(context), /changed after admission/)

    const second = await fixture('reconcile-explicit')
    try {
      await admit(second)
      push(second, second.candidate)
      let pushes = 0
      const runner: CommandRunner = async (executable, args, options) => {
        if (args[0] === 'push') pushes += 1
        return second.runner(executable, args, options)
      }
      const result = await publish(second, { reconcileExactCandidate: true, runner })
      assert.equal(result.outcome, 'unchanged')
      assert.equal(pushes, 0)
    } finally {
      second.ledger.close()
      await rm(second.temp, { force: true, recursive: true })
    }
  } finally {
    context.ledger.close()
    await rm(context.temp, { force: true, recursive: true })
  }
})

test('a recorded publication receipt survives a later failed attempt outcome', async () => {
  const context = await fixture('receipt-custody')
  try {
    await admit(context)
    const result = await publish(context)
    context.ledger.recordAttemptOutcome({
      actorIdentity: 'operator',
      attemptId: context.attemptId,
      candidateCommitOid: context.candidate,
      completedAt: TIME,
      coordinatorIdentity: 'coordinator',
      custody: { recoveryRef: `refs/orca-no-mistakes/recover/${context.runId}` },
      reason: 'later local cleanup failed',
      receiptDigests: [result.receiptSha256],
      resumeEligible: true,
      runId: context.runId,
      stoppingFact: 'local-custody-cleanup',
      verdict: 'failed'
    })
    assert.equal(
      context.ledger.remoteReceipt(context.runId, 'candidate-publication')?.receipt_sha256,
      result.receiptSha256
    )
    assert.equal(remoteHead(context), context.candidate)
  } finally {
    context.ledger.close()
    await rm(context.temp, { force: true, recursive: true })
  }
})
