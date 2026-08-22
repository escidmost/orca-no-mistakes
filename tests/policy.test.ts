import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  canonicalPolicyJson,
  effectivePolicyHash,
  extractTrustedBaseConfig,
  loadLocalPolicyConfig,
  resolveRunPolicy
} from '../scripts/policy.ts'
import type { PolicyGitSource } from '../scripts/policy.ts'

function fakeGit(
  files: Record<string, string>,
  shas: Record<string, string> = {},
  existing: Record<string, boolean> = {}
): PolicyGitSource & {
  requested: string[]
} {
  const requested: string[] = []
  return {
    requested,
    async resolveRefSha(ref: string) {
      requested.push(`sha:${ref}`)
      return shas[ref] ?? `sha-${ref.replaceAll('/', '-')}`
    },
    async showFile(ref: string, filePath: string) {
      requested.push(`show:${ref}:${filePath}`)
      return files[`${ref}:${filePath}`]
    },
    async pathExists(ref: string, filePath: string) {
      requested.push(`exists:${ref}:${filePath}`)
      return `${ref}:${filePath}` in existing
    }
  }
}

test('canonicalPolicyJson is key-order independent and array order preserving', () => {
  assert.equal(
    canonicalPolicyJson({ b: 1, a: { d: [2, 1], c: true } }),
    canonicalPolicyJson({ a: { c: true, d: [2, 1] }, b: 1 })
  )
  assert.equal(canonicalPolicyJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(canonicalPolicyJson([3, 1, 2]), '[3,1,2]')
})

test('effectivePolicyHash is stable across key order and changes with content', () => {
  const left = effectivePolicyHash({ defaults: { model: 'm' }, stages: { review: {} } })
  const right = effectivePolicyHash({ stages: { review: {} }, defaults: { model: 'm' } })
  assert.equal(left, right)
  assert.match(left, /^[0-9a-f]{64}$/)
  assert.notEqual(left, effectivePolicyHash({ defaults: { model: 'n' }, stages: { review: {} } }))
})

test('extractTrustedBaseConfig reads .orca/no-mistakes.yaml from the base ref', async () => {
  const yaml = 'stages:\n  review:\n    reviewer:\n      agent: claude\n'
  const git = fakeGit({ 'origin/main:.orca/no-mistakes.yaml': yaml }, { 'origin/main': 'basesha' })
  const { config, provenance } = await extractTrustedBaseConfig(git, 'main')
  assert.deepEqual(config, { stages: { review: { reviewer: { agent: 'claude' } } } })
  assert.equal(provenance.baseRef, 'origin/main')
  assert.equal(provenance.baseRefSha, 'basesha')
  assert.equal(provenance.localBypass, false)
  assert.equal(provenance.effectivePolicyHash, effectivePolicyHash(config))
  assert.ok(git.requested.includes('show:origin/main:.orca/no-mistakes.yaml'))
})

test('a missing config on the trusted base resolves to an empty policy', async () => {
  const git = fakeGit({})
  const { config, provenance } = await extractTrustedBaseConfig(git, 'main')
  assert.deepEqual(config, {})
  assert.equal(provenance.localBypass, false)
  assert.equal(provenance.effectivePolicyHash, effectivePolicyHash({}))
})

test('a failed read of an existing base config fails closed instead of certifying an empty policy', async () => {
  const git = fakeGit(
    {},
    {},
    { 'origin/main:.orca/no-mistakes.yaml': true }
  )
  await assert.rejects(
    extractTrustedBaseConfig(git, 'main'),
    /could not read \.orca\/no-mistakes\.yaml from origin\/main/
  )
})

test('an unresolvable trusted base ref fails closed instead of certifying a local ref', async () => {
  const git = fakeGit({ 'main:.orca/no-mistakes.yaml': 'stages:\n  review:\n    max_fix_rounds: 9\n' })
  git.resolveRefSha = async () => undefined
  await assert.rejects(
    extractTrustedBaseConfig(git, 'main'),
    /could not resolve trusted base ref origin\/main; fetch origin or pass --allow-local-config/
  )
  await assert.rejects(
    resolveRunPolicy({ base: 'main', git, repoRoot: '/repo' }),
    /could not resolve trusted base ref origin\/main/
  )
  assert.deepEqual(git.requested.filter((entry) => entry.startsWith('show:')), [])
})

test('invalid YAML on the trusted base fails closed', async () => {
  const git = fakeGit({ 'origin/main:.orca/no-mistakes.yaml': 'defaults: [unclosed\n' })
  await assert.rejects(extractTrustedBaseConfig(git, 'main'), /YAML parse error|Invalid configuration/)
})

test('resolveRunPolicy flags local bypasses and prefers explicit --config paths', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'policy-bypass-'))
  try {
    const configFile = path.join(temp, 'local-policy.yaml')
    await writeFile(configFile, 'auto_fix:\n  max_rounds: 7\n')
    const git = fakeGit({})

    const bypass = await resolveRunPolicy({
      allowLocalConfig: true,
      base: 'main',
      configPath: configFile,
      git,
      repoRoot: '/nonexistent-repo'
    })
    assert.equal(bypass.provenance.localBypass, true)
    assert.equal(bypass.provenance.baseRefSha, undefined)
    assert.deepEqual(bypass.config.auto_fix, { max_rounds: 7 })

    // Missing working-tree config under the bypass is still a valid empty policy.
    const implicit = await resolveRunPolicy({
      allowLocalConfig: true,
      base: 'main',
      git,
      repoRoot: temp
    })
    assert.deepEqual(implicit.config, {})
    assert.equal(implicit.provenance.localBypass, true)

    // An explicit --config path that does not exist fails loudly.
    await assert.rejects(
      loadLocalPolicyConfig(path.join(temp, 'missing.yaml')),
      /--config could not read/
    )
    await assert.rejects(
      resolveRunPolicy({
        base: 'main',
        configPath: path.join(temp, 'missing.yaml'),
        git,
        repoRoot: temp
      }),
      /--config could not read/
    )
    assert.ok(!git.requested.some((call) => call.startsWith('sha:')), 'bypass never touches git')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
