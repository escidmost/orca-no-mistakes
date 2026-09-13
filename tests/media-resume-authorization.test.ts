import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DomainLedger } from '../scripts/ledger.ts'
import type { MediaPublicationContext } from '../scripts/media-publication.ts'
import { pullRequestArtifacts } from '../scripts/orca-no-mistakes.ts'

test('published media of a retained body stay discoverable per candidate and route so resume can recheck approval', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'onm-media-resume-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('89504e470d0a1a0a0000000049454e44', 'hex')
  const digest = createHash('sha256').update(bytes).digest('hex')
  await writeFile(path.join(root, 'screen.png'), bytes)
  const ledger = new DomainLedger(':memory:')
  t.after(() => ledger.close())
  const candidate = 'b'.repeat(40)
  ledger.startRun({ runId: 'resume-run', repoRoot: root, branch: 'feature', baseBranch: 'main', intent: 'test', policySha256: 'a'.repeat(64), submissionCommitOid: candidate })
  const ownership = { repoRoot: root, branch: 'feature', generationToken: ledger.acquireLease({ runId: 'resume-run', repoRoot: root, branch: 'feature' }) }
  const url = 'https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const media: MediaPublicationContext = { ledger, ownership, runId: 'resume-run', candidate, evidenceCandidate: candidate, repositoryId: '42', host: 'github.com', upload: async () => url }
  const report = { findings: [], summary: 'test', artifacts: ['screen.png'], artifactDigests: { 'screen.png': digest } }

  assert.equal(ledger.publishedMediaDigests('resume-run', candidate, '42', 'github.com').length, 0)
  assert.equal((await pullRequestArtifacts(root, report, { media, trustedPublicationApprovals: [digest] }))[0].media?.url, url)
  assert.deepEqual(ledger.publishedMediaDigests('resume-run', candidate, '42', 'github.com'), [digest])
  assert.deepEqual(ledger.publishedMediaDigests('resume-run', 'c'.repeat(40), '42', 'github.com'), [])
  assert.deepEqual(ledger.publishedMediaDigests('resume-run', candidate, '43', 'github.com'), [])
  assert.deepEqual(ledger.publishedMediaDigests('resume-run', candidate, '42', 'example.com'), [])
})
