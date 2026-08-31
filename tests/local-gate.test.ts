import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  decodeIntentPushOption,
  initializeLocalGate,
  parseReceiveUpdates,
  readGateMetadata,
  validateReceiveUpdate
} from '../scripts/admission.ts'

const oid = (character: string) => character.repeat(40)
const zero = oid('0')
const intent = 'Run review, tests, and documentation.'
const encodedIntent = Buffer.from(intent).toString('base64url')

function git(repo: string, ...args: string[]): string {
  return String(execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })).trim()
}

test('the gate decodes exactly one canonical base64url intent option', () => {
  const environment = {
    GIT_PUSH_OPTION_0: `no-mistakes.intent=${encodedIntent}`,
    GIT_PUSH_OPTION_COUNT: '1'
  } as NodeJS.ProcessEnv
  assert.equal(decodeIntentPushOption(environment), intent)
  assert.throws(
    () => decodeIntentPushOption({ ...environment, GIT_PUSH_OPTION_COUNT: '2' }),
    /exactly one/
  )
  assert.throws(
    () =>
      decodeIntentPushOption({
        GIT_PUSH_OPTION_0: `no-mistakes.intent=${encodedIntent}=`,
        GIT_PUSH_OPTION_COUNT: '1'
      }),
    /unpadded/
  )
})

test('the gate accepts one feature update and rejects unsafe ref shapes', () => {
  const valid = validateReceiveUpdate(
    parseReceiveUpdates(`${zero} ${oid('b')} refs/heads/feature\n`),
    'main',
    intent
  )
  assert.equal(valid.noEvent, false)
  assert.equal(
    validateReceiveUpdate(
      [{ newOid: oid('b'), oldOid: oid('b'), refName: 'refs/heads/feature' }],
      'main',
      intent
    ).noEvent,
    true
  )
  for (const [updates, message] of [
    [[{ newOid: oid('b'), oldOid: zero, refName: 'refs/tags/v1' }], 'feature refs'],
    [[{ newOid: zero, oldOid: oid('a'), refName: 'refs/heads/feature' }], 'deletion'],
    [[{ newOid: oid('b'), oldOid: oid('a'), refName: 'refs/heads/main' }], 'default branch'],
    [
      [
        { newOid: oid('b'), oldOid: oid('a'), refName: 'refs/heads/feature' },
        { newOid: oid('c'), oldOid: oid('b'), refName: 'refs/heads/other' }
      ],
      'exactly one'
    ]
  ] as const) {
    assert.throws(() => validateReceiveUpdate(updates, 'main', intent), new RegExp(message))
  }
})

test('init is idempotent and pins the managed hook path on the bare gate', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-local-gate-'))
  const repo = path.join(temp, 'repo')
  try {
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', path.join(temp, 'origin.git')])
    const first = await initializeLocalGate(repo, path.join(temp, 'orca-no-mistakes'))
    const firstMetadata = await readFile(path.join(first.stateDir, 'gate.json'), 'utf8')
    const firstHook = await readFile(path.join(first.gatePath, 'hooks', 'pre-receive'), 'utf8')
    const second = await initializeLocalGate(repo, path.join(temp, 'orca-no-mistakes'))
    assert.deepEqual(second, first)
    assert.equal(await readFile(path.join(second.stateDir, 'gate.json'), 'utf8'), firstMetadata)
    assert.equal(await readFile(path.join(second.gatePath, 'hooks', 'pre-receive'), 'utf8'), firstHook)
    assert.equal(git(repo, 'remote', 'get-url', 'orca-no-mistakes'), first.gatePath)
    assert.equal(
      git(first.gatePath, 'config', '--get', 'core.hooksPath'),
      path.join(first.gatePath, 'hooks')
    )
    assert.equal(git(first.gatePath, 'config', '--get', 'receive.advertisePushOptions'), 'true')
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test('metadata identity is bound to the repository gate paths', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-metadata-'))
  try {
    const repo = path.join(temp, 'repo')
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', path.join(temp, 'origin.git')])
    const metadata = await initializeLocalGate(repo, process.argv[1]!)
    const metadataPath = path.join(metadata.stateDir, 'gate.json')
    await writeFile(
      metadataPath,
      `${JSON.stringify({ ...metadata, gateIdentity: '0'.repeat(64) })}\n`,
    )
    await assert.rejects(
      readGateMetadata(metadata.gatePath),
      /metadata does not match its repository/,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('the installed pre-receive hook rejects a tag before coordinator launch', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-gate-hook-'))
  const repo = path.join(temp, 'repo')
  const origin = path.join(temp, 'origin.git')
  try {
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test User')
    await writeFile(path.join(repo, 'file.txt'), 'commit\n')
    git(repo, 'add', 'file.txt')
    git(repo, 'commit', '-m', 'commit')
    execFileSync('git', ['init', '--bare', origin], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin])
    const metadata = await initializeLocalGate(repo, path.resolve('bin/orca-no-mistakes'))
    const intent = Buffer.from('Reject the tag.').toString('base64url')
    assert.throws(
      () =>
        execFileSync(
          'git',
          [
            '-C',
            repo,
            'push',
            `--push-option=no-mistakes.intent=${intent}`,
            metadata.remoteName,
            'HEAD:refs/tags/v1'
          ],
          { stdio: 'pipe' }
        ),
      /tag refs are not accepted|Command failed/
    )
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})
