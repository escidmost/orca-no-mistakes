import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  pullRequestArtifacts,
  streamArtifactHashAndPreview,
  validateReport,
  type StageReport
} from '../scripts/orca-no-mistakes.ts'

test('streamArtifactHashAndPreview streams hash and caps preview without buffering entire file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'onm-stream-test-'))
  try {
    // 1. Empty file
    const emptyFile = path.join(dir, 'empty.txt')
    await writeFile(emptyFile, Buffer.alloc(0))
    const emptyHandle = await open(emptyFile, 'r')
    try {
      const { digest, previewBytes } = await streamArtifactHashAndPreview(emptyHandle, 1024)
      assert.equal(digest, createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
      assert.equal(previewBytes.length, 0)
    } finally {
      await emptyHandle.close()
    }

    // 2. Large multi-chunk file (> 64 KiB, e.g., 160 KiB)
    const largeFile = path.join(dir, 'large.txt')
    const largeContent = Buffer.alloc(160 * 1024, 'x')
    largeContent.write('START_OF_FILE', 0)
    largeContent.write('END_OF_FILE', largeContent.length - 20)
    const expectedDigest = createHash('sha256').update(largeContent).digest('hex')

    await writeFile(largeFile, largeContent)
    const largeHandle = await open(largeFile, 'r')
    try {
      const maxPreview = 16 * 1024
      const { digest, previewBytes } = await streamArtifactHashAndPreview(largeHandle, maxPreview)
      assert.equal(digest, expectedDigest)
      assert.equal(previewBytes.length, maxPreview)
      assert.equal(previewBytes.subarray(0, 13).toString('utf8'), 'START_OF_FILE')
    } finally {
      await largeHandle.close()
    }
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
})

test('validateReport streams artifact SHA-256 for multi-chunk files without whole-file buffering', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'onm-validate-report-'))
  try {
    const artifactName = 'large-artifact.log'
    const artifactPath = path.join(dir, artifactName)
    const content = Buffer.alloc(128 * 1024, 'a')
    content.write('log line 1\n', 0)
    const expectedDigest = createHash('sha256').update(content).digest('hex')
    await writeFile(artifactPath, content)

    const rawReport: StageReport = {
      artifacts: [artifactName],
      findings: [],
      summary: 'test run complete'
    }

    const validated = await validateReport(rawReport, 'review', dir)
    assert.equal(validated.artifactDigests?.[artifactName], expectedDigest)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
})

test('pullRequestArtifacts streams large artifact and bounds preview content to 16 KiB', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'onm-pr-artifacts-'))
  try {
    const artifactName = 'build.log'
    const artifactPath = path.join(dir, artifactName)
    // 100 KiB text file
    const line = 'INFO: Build step succeeded without warnings.\n'
    const repetitions = Math.ceil((100 * 1024) / line.length)
    const content = Buffer.from(line.repeat(repetitions), 'utf8')
    const expectedDigest = createHash('sha256').update(content).digest('hex')
    await writeFile(artifactPath, content)

    const report: StageReport = {
      artifactDigests: {
        [artifactName]: expectedDigest
      },
      artifacts: [artifactName],
      findings: [],
      summary: 'build succeeded'
    }

    const trustedPublicationApprovals = [expectedDigest]
    const extracted = await pullRequestArtifacts(dir, report, { trustedPublicationApprovals })
    assert.equal(extracted.length, 1)
    assert.equal(extracted[0].name, 'Build')
    assert.ok(Buffer.byteLength(extracted[0].content) <= 16 * 1024)
    assert.ok(extracted[0].content.startsWith('INFO: Build step succeeded'))

    // Mismatched digest skips the artifact
    const mismatchedReport: StageReport = {
      artifactDigests: {
        [artifactName]: 'f'.repeat(64)
      },
      artifacts: [artifactName],
      findings: [],
      summary: 'build succeeded'
    }
    const skipped = await pullRequestArtifacts(dir, mismatchedReport, { trustedPublicationApprovals })
    assert.equal(skipped.length, 0)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
})
