import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { approvedMediaBytes, attachmentUrl, MediaUploadError, uploadGithubMedia } from '../scripts/media-publication.ts'

const png = Buffer.from('89504e470d0a1a0a0000000049454e44', 'hex')
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const url = 'https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

test('approved snapshot is exactly the uploaded image/video bytes, with bounded protocol and validated response', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'onm-media-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [name, bytes] of [['screen.png', png], ['clip.mp4', Buffer.from('000000186674797069736f6d', 'hex')], ['clip.webm', Buffer.from('1a45dfa3000000', 'hex')]] as const) {
    await writeFile(path.join(root, name), bytes)
    const media = await approvedMediaBytes(root, name, digest(bytes), new Set([digest(bytes)]))
    await writeFile(path.join(root, name), 'changed after snapshot')
    const result = await uploadGithubMedia({ ...media, host: 'github.com', repositoryId: '42', token: 'gho_test' }, async (endpoint, init) => {
      assert.equal(new URL(String(endpoint)).origin, 'https://uploads.github.com')
      assert.equal(new URL(String(endpoint)).searchParams.get('repository_id'), '42')
      assert.equal(new URL(String(endpoint)).searchParams.get('name'), `${digest(bytes)}${path.extname(name)}`)
      assert.equal(init?.method, 'POST')
      assert.equal(init?.redirect, 'error')
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer gho_test')
      assert.deepEqual(Buffer.from(init!.body as Uint8Array), bytes)
      return Response.json({ url }, { status: 201 })
    })
    assert.equal(result, url)
  }
})

test('unapproved, changed, linked, outside-root, empty, spoofed, and oversized artifacts are rejected', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'onm-media-safety-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const evidence = path.join(root, 'evidence')
  await mkdir(evidence)
  await writeFile(path.join(evidence, 'screen.png'), png)
  const sha = digest(png)
  const read = (name: string, approvals = new Set([sha])) => approvedMediaBytes(evidence, name, sha, approvals)
  assert.deepEqual((await read('screen.png')).bytes, png) // positive control for all refusals
  await assert.rejects(read('screen.png', new Set()), /approval/)
  await writeFile(path.join(evidence, 'changed.png'), Buffer.concat([png, Buffer.from('changed')]))
  await assert.rejects(read('changed.png'), /changed/)
  await writeFile(path.join(root, 'outside.png'), png)
  await assert.rejects(read('../outside.png'), /outside/)
  await symlink(path.join(root, 'outside.png'), path.join(evidence, 'linked.png'))
  await assert.rejects(read('linked.png'), /Symlink/)
  await symlink(evidence, path.join(evidence, 'nested'))
  await assert.rejects(read('nested/screen.png'), /Symlink/)
  await link(path.join(evidence, 'screen.png'), path.join(evidence, 'hard.png'))
  await assert.rejects(read('hard.png'), /singly-linked/)
  await writeFile(path.join(evidence, 'empty.png'), '')
  await assert.rejects(read('empty.png'), /nonempty/)
  await assert.rejects(read('file.svg'), /Unsupported/)
  await writeFile(path.join(evidence, 'fake.png'), 'not an image')
  const fakeSha = digest(Buffer.from('not an image'))
  await assert.rejects(approvedMediaBytes(evidence, 'fake.png', fakeSha, new Set([fakeSha])), /type/)
  for (const [name, size] of [['large.png', 10 * 1024 * 1024 + 1], ['large.mp4', 100 * 1024 * 1024 + 1]] as const) {
    const handle = await open(path.join(evidence, name), 'w')
    await handle.truncate(size)
    await handle.close()
    await assert.rejects(read(name), /limit/)
  }
})

test('unsupported hosts/tokens never request; upload failures and ambiguous results never return URLs', async () => {
  const input = { bytes: png, name: 'screen.png', mime: 'image/png', kind: 'image' as const, host: 'github.com', repositoryId: '42', token: 'ghp_test' }
  const never: typeof fetch = async () => { assert.fail('request must not run') }
  await assert.rejects(uploadGithubMedia({ ...input, host: 'ghe.example.com' }, never), /github.com only/)
  for (const token of ['', 'ghs_actions', 'ghu_app', 'unknown']) await assert.rejects(uploadGithubMedia({ ...input, token }, never), /authentication type/)
  for (const token of ['gho_oauth', 'ghp_pat', 'github_pat_fine']) assert.equal(await uploadGithubMedia({ ...input, token }, async () => Response.json({ url })), url)
  for (const status of [403, 404, 413, 500]) {
    await assert.rejects(uploadGithubMedia(input, async () => new Response('secret server response', { status })), error => error instanceof MediaUploadError && error.uncertain === (status >= 500) && !error.message.includes('secret'))
  }
  for (const reply of ['not JSON', JSON.stringify({ url: 'https://evil.example/asset' }), 'x'.repeat(17000)]) {
    await assert.rejects(uploadGithubMedia(input, async () => new Response(reply)), error => error instanceof MediaUploadError && error.uncertain)
  }
  await assert.rejects(uploadGithubMedia(input, async () => { throw new Error('secret token') }), /outcome uncertain/)
  for (const bad of [url + '?secret=x', url + '#fragment', url.replace('github.com', 'github.com.evil'), url.replace('https:', 'http:'), 'javascript:alert(1)']) assert.throws(() => attachmentUrl(bad, 'github.com'))
})
