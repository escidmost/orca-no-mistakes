import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { realpath } from 'node:fs/promises'

import { deepStrictEqual, equal, rejects, strictEqual } from 'node:assert/strict'
import test from 'node:test'

import {
  admissionReadinessPath,
  anchorPermanentRef,
  awaitAdmissionLaunch,
  deriveAdmissionId,
  ensureCustodyLaunch,
  initializeLocalGate,
  launchLockPath,
  readGateMetadata,
  repositoryGatePaths,
  type GateMetadata,
  type ReceiveUpdate
} from '../scripts/admission.ts'
import { DomainLedger } from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const deadPid = (): number => {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  return result.pid ?? 1
}

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

const commitAll = async (
  repo: string,
  file: string,
  contents: string,
  message: string
): Promise<void> => {
  await writeFile(path.join(repo, file), contents)
  git(repo, 'add', file)
  git(repo, 'commit', '-m', message)
}

const gateFixture = async (
  prefix: string,
  intent: string
): Promise<{ head: string; intent: string; metadata: GateMetadata; repo: string; temp: string }> => {
  const temp = await mkdtemp(path.join(tmpdir(), prefix))
  execFileSync('git', ['init', '-b', 'main', path.join(temp, 'origin.git'), '--bare'], {
    stdio: 'ignore'
  })
  execFileSync('git', ['init', '-b', 'main', path.join(temp, 'repo')], { stdio: 'ignore' })
  const repo = await realpath(path.join(temp, 'repo'))
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  await commitAll(repo, 'base.txt', 'base\n', 'base')
  git(repo, 'remote', 'add', 'origin', path.join(temp, 'origin.git'))
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'fetch', '-q', 'origin')
  git(repo, 'checkout', '-b', 'feature')
  await commitAll(repo, 'feature.txt', 'feature\n', 'feature')
  git(repo, 'push', '-q', 'origin', 'feature')
  const metadata = await initializeLocalGate(repo, process.argv[1]!)
  execFileSync(
    'git',
    [
      '--git-dir',
      metadata.gatePath,
      'fetch',
      '-q',
      repo,
      'refs/heads/feature:refs/heads/feature'
    ],
    { stdio: 'ignore' }
  )
  return {
    head: git(repo, 'rev-parse', 'HEAD'),
    intent,
    metadata: await readGateMetadata(metadata.gatePath),
    repo,
    temp
  }
}

test('anchoring an accepted admission is idempotent across replays', async () => {
  const fixture = await gateFixture('onm-anchor-idem-', 'Anchor custody exactly once per run.')
  try {
    const metadata = { gatePath: fixture.metadata.gatePath } as unknown as GateMetadata
    const update: ReceiveUpdate = {
      newOid: fixture.head,
      oldOid: '0'.repeat(40),
      refName: 'refs/heads/feature'
    }
    git(fixture.metadata.gatePath, 'update-ref', 'refs/heads/feature', fixture.head)
    anchorPermanentRef(metadata, update, 'anchor-idem-run')
    anchorPermanentRef(metadata, update, 'anchor-idem-run')
    equal(
      git(fixture.metadata.gatePath, 'rev-parse', 'refs/orca-no-mistakes/heads/anchor-idem-run'),
      fixture.head
    )
  } finally {
    await rm(fixture.temp, { force: true, recursive: true })
  }
})

test('the custody coordinator anchors idempotently on replayed pushes', async () => {
  const intent = 'Replay accepted pushes without failing the anchor.'
  const fixture = await gateFixture('onm-custody-idem-', intent)
  const admissionId = deriveAdmissionId({
    gateIdentity: fixture.metadata.gateIdentity,
    intent,
    newOid: fixture.head,
    oldOid: fixture.head,
    refName: 'refs/heads/feature'
  })
  const ledger = new DomainLedger({ repositoryPath: fixture.repo })
  try {
    ledger.beginSubmissionAdmission({
      admissionId,
      gateIdentity: fixture.metadata.gateIdentity,
      intent,
      newOid: fixture.head,
      oldOid: fixture.head,
      refName: 'refs/heads/feature',
      repoRoot: fixture.repo,
      source: 'gate'
    })
    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent,
      policySha256: 'c'.repeat(64),
      repoRoot: fixture.repo,
      runId: 'custody-idem-run',
      submissionCommitOid: fixture.head
    })
    ledger.bindSubmissionAdmission(admissionId, 'custody-idem-run')
    ledger.markSubmissionAccepted({
      acceptedOid: fixture.head,
      admissionId,
      runId: 'custody-idem-run'
    })
    git(fixture.metadata.gatePath, 'update-ref', 'refs/heads/feature', fixture.head)
    const readinessPath = admissionReadinessPath(fixture.metadata, admissionId)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const launchNonce = `replay-launch-${attempt}`
      const lockPath = launchLockPath(readinessPath)
      await mkdir(lockPath, { recursive: true })
      await writeFile(path.join(lockPath, 'nonce'), launchNonce)
      await main([
        'gate',
        'coordinator',
        '--gate',
        fixture.metadata.gatePath,
        '--admission-id',
        admissionId,
        '--readiness',
        readinessPath,
        '--launch-nonce',
        launchNonce
      ])
    }
    equal(
      git(
        fixture.metadata.gatePath,
        'rev-parse',
        'refs/orca-no-mistakes/heads/custody-idem-run'
      ),
      fixture.head
    )
  } finally {
    ledger.close()
    await rm(fixture.temp, { force: true, recursive: true })
  }
})

const readinessDir = async (temp: string): Promise<string> => {
  const dir = path.join(temp, 'admissions')
  await mkdir(dir, { recursive: true })
  return dir
}

const admissionIdPath = (dir: string): string =>
  path.join(dir, `admission-${'a'.repeat(64)}.json`)

test('an abandoned launch claim is reclaimed and the stale readiness is not trusted', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-reclaim-'))
  try {
    const dir = await readinessDir(temp)
    const readinessPath = admissionIdPath(dir)
    const lockPath = launchLockPath(readinessPath)
    const ghost = deadPid()
    await mkdir(lockPath)
    await writeFile(path.join(lockPath, 'nonce'), 'ghost-nonce')
    await writeFile(path.join(lockPath, 'owner'), `${ghost}`)
    await writeFile(path.join(lockPath, 'coordinator'), `${ghost}`)
    await writeFile(
      readinessPath,
      `${JSON.stringify({ nonce: 'ghost-nonce', runId: 'ghost-run', state: 'ready' })}\n`
    )
    const spawns: string[] = []
    const launch = await awaitAdmissionLaunch(
      readinessPath,
      async (nonce) => {
        spawns.push(nonce)
        await writeFile(
          readinessPath,
          `${JSON.stringify({ nonce, runId: 'fresh-run', state: 'ready' })}\n`
        )
      },
      1_000
    )
    equal(launch.readiness.runId, 'fresh-run')
    equal(spawns.length, 1)
    strictEqual((JSON.parse(await readFile(readinessPath, 'utf8')) as { runId: string }).runId, 'fresh-run')
    await launch.releaseLaunch?.()
    equal(existsSync(lockPath), false)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('a live launcher claim is followed with nonce-bound readiness and no respawn', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-follow-'))
  try {
    const dir = await readinessDir(temp)
    const readinessPath = admissionIdPath(dir)
    const lockPath = launchLockPath(readinessPath)
    await mkdir(lockPath)
    await writeFile(path.join(lockPath, 'nonce'), 'live-nonce')
    await writeFile(path.join(lockPath, 'owner'), `${process.pid}`)
    await writeFile(path.join(lockPath, 'coordinator'), `${process.pid}`)
    await writeFile(
      readinessPath,
      `${JSON.stringify({ nonce: 'live-nonce', runId: 'owner-run', state: 'ready' })}\n`
    )
    const spawns: string[] = []
    const launch = await awaitAdmissionLaunch(
      readinessPath,
      async (nonce) => {
        spawns.push(nonce)
      },
      1_000
    )
    equal(launch.readiness.runId, 'owner-run')
    equal(spawns.length, 0)
    deepStrictEqual(launch.releaseLaunch, undefined)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('readiness from a different launch generation is ignored while the owner lives', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-generation-'))
  try {
    const dir = await readinessDir(temp)
    const readinessPath = admissionIdPath(dir)
    const lockPath = launchLockPath(readinessPath)
    await mkdir(lockPath)
    await writeFile(path.join(lockPath, 'nonce'), 'live-nonce')
    await writeFile(path.join(lockPath, 'owner'), `${process.pid}`)
    await writeFile(path.join(lockPath, 'coordinator'), `${process.pid}`)
    await writeFile(
      readinessPath,
      `${JSON.stringify({ nonce: 'old-nonce', runId: 'ghost-run', state: 'ready' })}\n`
    )
    const spawns: string[] = []
    await rejects(
      awaitAdmissionLaunch(
        readinessPath,
        async (nonce) => {
          spawns.push(nonce)
        },
        150
      ),
      /did not become ready/
    )
    equal(spawns.length, 0)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('legacy launch locks keep their historical readiness semantics', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-legacy-'))
  try {
    const dir = await readinessDir(temp)
    const readinessPath = admissionIdPath(dir)
    await mkdir(launchLockPath(readinessPath))
    await writeFile(
      readinessPath,
      `${JSON.stringify({ error: 'probe-legacy', state: 'failed' })}\n`
    )
    const spawns: string[] = []
    await rejects(
      awaitAdmissionLaunch(
        readinessPath,
        async (nonce) => {
          spawns.push(nonce)
        },
        150
      ),
      /probe-legacy/
    )
    equal(spawns.length, 0)
    const custody = await ensureCustodyLaunch(
      readinessPath,
      async (nonce) => {
        spawns.push(nonce)
      },
      150
    )
    equal(custody, undefined)
    equal(spawns.length, 0)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
