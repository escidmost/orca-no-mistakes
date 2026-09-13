import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
  const ownership = { repoRoot: root, branch: 'feature', generationToken: ledger.acquireLease({ runId: 'media-run', repoRoot: root, branch: 'feature' }) }
  let uploads = 0
  const url = 'https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const context: MediaPublicationContext = { ledger, ownership, runId: 'media-run', candidate: 'b'.repeat(40), evidenceCandidate: 'b'.repeat(40), repositoryId: '42', host: 'github.com', upload: async media => { assert.deepEqual(media.bytes, bytes); uploads++; return url } }
  const report = { findings: [], summary: 'test', artifacts: ['screen.png'], artifactDigests: { 'screen.png': digest } }
  const render = (media = context, approvals = [digest]) => pullRequestArtifacts(root, report, { media, trustedPublicationApprovals: approvals })
  assert.equal((await render())[0].media?.url, url)
  const key = { runId: context.runId, candidate: context.candidate, digest, repositoryId: context.repositoryId, host: context.host }
  const firstPath = await realpath(path.join(root, 'screen.png'))
  const secondPath = path.join(path.dirname(firstPath), 'copy.png')
  await writeFile(secondPath, bytes)
  assert.equal(ledger.mediaPublication(key, secondPath), undefined)
  report.artifacts.push('copy.png')
  Object.assign(report.artifactDigests, { 'copy.png': digest })
  assert.equal((await render(context, []))[1].media, undefined)
  assert.equal(ledger.mediaPublication(key, secondPath), undefined)
  const copies = await render()
  assert.deepEqual(copies.map(artifact => artifact.media?.url), [url, url])
  assert.equal(ledger.mediaPublication(key, firstPath)?.artifactPath, firstPath)
  assert.equal(ledger.mediaPublication(key, secondPath)?.artifactPath, secondPath)
  assert.equal(uploads, 1)
  ledger.close()
  ledger = new DomainLedger(path.join(root, 'ledger.sqlite'))
  context.ledger = ledger
  assert.equal(ledger.mediaPublication(key, firstPath)?.artifactPath, firstPath)
  assert.equal(ledger.mediaPublication(key, secondPath)?.artifactPath, secondPath)
  assert.deepEqual((await render()).map(artifact => artifact.media?.url), [url, url])
  assert.equal(uploads, 1)
  // An older ledger has the upload outcome but no artifact associations yet.
  ledger.close()
  const legacy = new DatabaseSync(path.join(root, 'ledger.sqlite'))
  legacy.exec('DROP TABLE media_publication_artifacts')
  legacy.close()
  ledger = new DomainLedger(path.join(root, 'ledger.sqlite'))
  context.ledger = ledger
  assert.deepEqual((await render()).map(artifact => artifact.media?.url), [url, url])
  assert.equal(ledger.mediaPublication(key, firstPath)?.artifactPath, firstPath)
  assert.equal(ledger.mediaPublication(key, secondPath)?.artifactPath, secondPath)
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
    const ownership = { repoRoot: root, branch: mode, generationToken: ledger.acquireLease({ runId: mode, repoRoot: root, branch: mode }) }
    const artifactPath = await realpath(path.join(root, 'clip.mp4'))
    if (mode === 'pending') ledger.beginMediaPublication(key, artifactPath, ownership)
    let uploads = 0
    const media: MediaPublicationContext = { ...key, ledger, ownership, evidenceCandidate: key.candidate, upload: async () => { uploads++; throw new MediaUploadError('Upload failed; local evidence retained.', mode === 'uncertain') } }
    for (let i = 0; i < 2; i++) {
      const artifacts = await pullRequestArtifacts(root, { findings: [], summary: 'test', artifacts: ['clip.mp4'], artifactDigests: { 'clip.mp4': digest } }, { media, trustedPublicationApprovals: [digest] })
      assert.equal(artifacts[0].media, undefined)
      assert.match(artifacts[0].content, /Not confirmed viewable remotely/)
      assert.deepEqual(await readFile(path.join(root, 'clip.mp4')), bytes)
    }
    assert.equal(uploads, mode === 'pending' ? 0 : 1)
    assert.equal(ledger.mediaPublication(key, artifactPath)?.status, mode)
  }
})

test('upload completion cannot change a pending record after lease replacement', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'onm-media-completion-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('89504e470d0a1a0a0000000049454e44', 'hex')
  const digest = createHash('sha256').update(bytes).digest('hex')
  await writeFile(path.join(root, 'screen.png'), bytes)
  const artifactPath = await realpath(path.join(root, 'screen.png'))
  const ledger = new DomainLedger(':memory:')
  t.after(() => ledger.close())
  for (const replacement of ['same-run', 'other-run']) for (const outcome of ['success', 'failed', 'uncertain']) {
    const runId = `${replacement}-${outcome}`
    const start = (id: string) => ledger.startRun({ runId: id, repoRoot: root, branch: runId, baseBranch: 'main', intent: 'test', policySha256: 'a'.repeat(64), submissionCommitOid: 'b'.repeat(40) })
    start(runId)
    const ownership = { repoRoot: root, branch: runId, generationToken: ledger.acquireLease({ runId, repoRoot: root, branch: runId }) }
    const key = { runId, candidate: 'b'.repeat(40), digest, repositoryId: '42', host: 'github.com' }
    let pending: ReturnType<DomainLedger['mediaPublication']>
    let uploads = 0
    const media: MediaPublicationContext = { ...key, ledger, ownership, evidenceCandidate: key.candidate, upload: async () => {
      uploads++
      pending = ledger.mediaPublication(key, artifactPath)
      assert.equal(pending?.status, 'pending')
      ledger.releaseLease(runId)
      const nextRun = replacement === 'same-run' ? runId : `${runId}-replacement`
      if (nextRun !== runId) start(nextRun)
      assert.notEqual(ledger.acquireLease({ runId: nextRun, repoRoot: root, branch: runId }), ownership.generationToken)
      if (outcome !== 'success') throw new MediaUploadError('upload failed', outcome === 'uncertain')
      return 'https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    } }
    for (let i = 0; i < 2; i++) {
      const artifacts = await pullRequestArtifacts(root, { findings: [], summary: 'test', artifacts: ['screen.png'], artifactDigests: { 'screen.png': digest } }, { media, trustedPublicationApprovals: [digest] })
      assert.equal(artifacts[0].media, undefined)
      assert.match(artifacts[0].content, /Not confirmed viewable remotely/)
      assert.deepEqual(ledger.mediaPublication(key, artifactPath), pending)
    }
    assert.equal(uploads, 1)
  }
})

test('a revoked or stale lease cannot reserve or upload media, while its current owner can', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'onm-media-lease-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('89504e470d0a1a0a0000000049454e44', 'hex')
  const digest = createHash('sha256').update(bytes).digest('hex')
  await writeFile(path.join(root, 'screen.png'), bytes)
  const ledger = new DomainLedger(':memory:')
  t.after(() => ledger.close())
  ledger.startRun({ runId: 'lease-run', repoRoot: root, branch: 'feature', baseBranch: 'main', intent: 'test', policySha256: 'a'.repeat(64), submissionCommitOid: 'b'.repeat(40) })
  const ownership = { repoRoot: root, branch: 'feature', generationToken: ledger.acquireLease({ runId: 'lease-run', repoRoot: root, branch: 'feature' }) }
  const key = { runId: 'lease-run', candidate: 'b'.repeat(40), digest, repositoryId: '42', host: 'github.com' }
  let uploads = 0
  const media: MediaPublicationContext = { ...key, ledger, ownership, evidenceCandidate: key.candidate, upload: async () => { uploads++; return 'https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }
  const render = () => pullRequestArtifacts(root, { findings: [], summary: 'test', artifacts: ['screen.png'], artifactDigests: { 'screen.png': digest } }, { media, trustedPublicationApprovals: [digest] })
  ledger.releaseLease(key.runId)
  assert.match((await render())[0].content, /no longer owns the branch lease/)
  const currentGeneration = ledger.acquireLease({ runId: key.runId, repoRoot: root, branch: 'feature' })
  assert.notEqual(currentGeneration, ownership.generationToken)
  assert.match((await render())[0].content, /no longer owns the branch lease/)
  assert.equal(uploads, 0)
  assert.equal(ledger.mediaPublication(key, await realpath(path.join(root, 'screen.png'))), undefined)
  ownership.generationToken = currentGeneration
  assert.ok((await render())[0].media)
  assert.equal(uploads, 1)
})
