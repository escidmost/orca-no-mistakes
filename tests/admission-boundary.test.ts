import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  anchorPermanentRef,
  launchDetachedCoordinator,
  type GateMetadata,
  sanitizeCoordinatorEnvironment,
  waitForPermanentRef
} from '../scripts/admission.ts'

const oid = (character: string) => character.repeat(40)

function git(repo: string, ...args: string[]): string {
  return String(execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })).trim()
}

test('acceptance anchors the exact permanent feature ref and rejects supersession', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-admission-boundary-'))
  const repo = path.join(temp, 'repo')
  const gate = path.join(temp, 'gate.git')
  try {
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
    execFileSync('git', ['init', '--bare', gate], { stdio: 'ignore' })
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await writeFile(path.join(repo, 'file.txt'), 'first\n')
    git(repo, 'add', 'file.txt')
    git(repo, 'commit', '-m', 'first')
    const metadata: GateMetadata = {
      commonDir: temp,
      defaultBranch: 'main',
      gateIdentity: 'gate-identity',
      gatePath: gate,
      hookVersion: 1,
      remoteName: 'orca-no-mistakes',
      repoRoot: repo,
      stateDir: temp,
      version: 1
    }
    const first = git(repo, 'rev-parse', 'HEAD')
    await writeFile(path.join(repo, 'file.txt'), 'second\n')
    git(repo, 'commit', '-am', 'second')
    const second = git(repo, 'rev-parse', 'HEAD')
    execFileSync('git', ['--git-dir', gate, 'fetch', '--quiet', repo, first, second])
    execFileSync('git', ['--git-dir', gate, 'update-ref', 'refs/heads/feature', first])
    anchorPermanentRef(metadata, { newOid: first, oldOid: oid('a'), refName: 'refs/heads/feature' }, 'run-1')
    assert.equal(git(gate, 'rev-parse', 'refs/orca-no-mistakes/heads/run-1'), first)
    execFileSync('git', ['--git-dir', gate, 'update-ref', 'refs/heads/feature', second, first])
    await assert.rejects(
      waitForPermanentRef(
        metadata,
        { newOid: first, oldOid: oid('a'), refName: 'refs/heads/feature' },
        1
      ),
      /superseded/
    )
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('acceptance rejects disappearance of an existing feature ref', async () => {
  const metadata: GateMetadata = {
    commonDir: tmpdir(),
    defaultBranch: 'main',
    gateIdentity: 'gate-identity',
    gatePath: path.join(tmpdir(), 'missing-gate.git'),
    hookVersion: 1,
    remoteName: 'orca-no-mistakes',
    repoRoot: tmpdir(),
    stateDir: tmpdir(),
    version: 1
  }
  const update = {
    oldOid: oid('a'),
    newOid: oid('b'),
    refName: 'refs/heads/feature'
  }
  await assert.rejects(
    waitForPermanentRef(metadata, update, 0),
    /superseded/
  )
})

test('coordinator launch drops receive state and unrelated inherited secrets', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-coordinator-env-'))
  const entrypoint = path.join(temp, 'probe.mjs')
  try {
    await writeFile(
      entrypoint,
      `import { writeFileSync } from 'node:fs'
import path from 'node:path'
writeFileSync(path.join(process.env.ORCA_NO_MISTAKES_HOME, 'env.json'), JSON.stringify({
  quarantine: process.env.GIT_QUARANTINE_PATH,
  option: process.env.GIT_PUSH_OPTION_0,
  secret: process.env.SECRET_TOKEN
}))
`
    )
    const environment = sanitizeCoordinatorEnvironment({
      GIT_PUSH_OPTION_0: 'no-mistakes.intent=bad',
      GIT_QUARANTINE_PATH: '/quarantine',
      ORCA_NO_MISTAKES_HOME: temp,
      SECRET_TOKEN: 'do-not-inherit'
    })
    assert.equal(environment.GIT_QUARANTINE_PATH, undefined)
    await launchDetachedCoordinator({
      args: [],
      cwd: temp,
      entrypoint,
      environment: {
        ...environment,
        GIT_PUSH_OPTION_0: 'no-mistakes.intent=bad',
        GIT_QUARANTINE_PATH: '/quarantine',
        SECRET_TOKEN: 'do-not-inherit'
      }
    })
    let probe: { quarantine?: string; option?: string; secret?: string } | undefined
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        probe = JSON.parse(await readFile(path.join(temp, 'env.json'), 'utf8'))
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    assert.deepEqual(probe, {})
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
