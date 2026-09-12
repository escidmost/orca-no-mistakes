import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DomainLedger } from '../scripts/ledger.ts'
import { MediaUploadError, type MediaPublicationContext } from '../scripts/media-publication.ts'
import { pullRequestArtifacts } from '../scripts/orca-no-mistakes.ts'

test('PR artifact integration persists success across reopen, rechecks authorization/content, and binds candidate and repository', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'onm-media-ledger-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('89504e470d0a1a0a0000000049454e44', 'hex')
  const digest = createHash('sha256').update(bytes).digest('hex')
  await writeFile(path.join(root, 'screen.png'), bytes)
  let ledger = new DomainLedger(path.join(root, 'ledger.sqlite'))
  t.after(() => ledger.close())
  ledger.startRun({ runId: 'media-run', repoRoot: root, branch: 'feature', baseBranch: 'main', intent: 'test', policySha256: 'a'.repeat(64), submissionCommitOid: 'b'.repeat(40) })
  let uploads = 0
  const url = 'https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const context: MediaPublicationContext = { ledger, runId: 'media-run', candidate: 'b'.repeat(40), evidenceCandidate: 'b'.repeat(40), repositoryId: '42', host: 'github.com', upload: async media => { assert.deepEqual(media.bytes, bytes); uploads++; return url } }
  const report = { findings: [], summary: 'test', artifacts: ['screen.png'], artifactDigests: { 'screen.png': digest } }
  const render = (media = context, approvals = [digest]) => pullRequestArtifacts(root, report, { media, trustedPublicationApprovals: approvals })
  assert.equal((await render())[0].media?.url, url)
  ledger.close()
  ledger = new DomainLedger(path.join(root, 'ledger.sqlite'))
  context.ledger = ledger
  assert.equal((await render())[0].media?.url, url)
  assert.equal(uploads, 1)
  assert.equal((await render(context, []))[0].media, undefined)
  assert.equal((await render({ ...context, candidate: 'c'.repeat(40) }))[0].media, undefined)
  assert.equal(uploads, 1)
  await render({ ...context, repositoryId: '43' })
  assert.equal(uploads, 2)
  await writeFile(path.join(root, 'screen.png'), 'changed')
  assert.equal((await render())[0].media, undefined)
  assert.equal(uploads, 2)
  assert.equal(await readFile(path.join(root, 'screen.png'), 'utf8'), 'changed')
})

test('durable failed, uncertain, and interrupted uploads preserve evidence and never blindly retry', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'onm-media-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('000000186674797069736f6d', 'hex')
  const digest = createHash('sha256').update(bytes).digest('hex')
  await writeFile(path.join(root, 'clip.mp4'), bytes)
  const ledger = new DomainLedger(':memory:')
  t.after(() => ledger.close())
  for (const mode of ['failed', 'uncertain', 'pending']) {
    ledger.startRun({ runId: mode, repoRoot: root, branch: mode, baseBranch: 'main', intent: 'test', policySha256: 'a'.repeat(64), submissionCommitOid: 'b'.repeat(40) })
    const key = { runId: mode, candidate: 'b'.repeat(40), digest, repositoryId: '42', host: 'github.com' }
    if (mode === 'pending') ledger.beginMediaPublication(key, 'clip.mp4')
    let uploads = 0
    const media: MediaPublicationContext = { ...key, ledger, evidenceCandidate: key.candidate, upload: async () => { uploads++; throw new MediaUploadError('Upload failed; local evidence retained.', mode === 'uncertain') } }
    for (let i = 0; i < 2; i++) {
      const artifacts = await pullRequestArtifacts(root, { findings: [], summary: 'test', artifacts: ['clip.mp4'], artifactDigests: { 'clip.mp4': digest } }, { media, trustedPublicationApprovals: [digest] })
      assert.equal(artifacts[0].media, undefined)
      assert.match(artifacts[0].content, /Not confirmed viewable remotely/)
      assert.deepEqual(await readFile(path.join(root, 'clip.mp4')), bytes)
    }
    assert.equal(uploads, mode === 'pending' ? 0 : 1)
    assert.equal(ledger.mediaPublication(key)?.status, mode)
  }
})
