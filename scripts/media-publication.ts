import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { DomainLedger } from './ledger.ts'
import type { PullRequestArtifact } from './pull-request.ts'

const types: Record<string, { mime: string; kind: 'image' | 'video' }> = {
  '.png': { mime: 'image/png', kind: 'image' },
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' },
  '.gif': { mime: 'image/gif', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' },
  '.mp4': { mime: 'video/mp4', kind: 'video' },
  '.mov': { mime: 'video/quicktime', kind: 'video' },
  '.webm': { mime: 'video/webm', kind: 'video' }
}

export class MediaUploadError extends Error {
  readonly uncertain: boolean
  constructor(message: string, uncertain = false) {
    super(message)
    this.uncertain = uncertain
  }
}

export function attachmentUrl(value: unknown, host: string): string {
  if (typeof value !== 'string' || !new RegExp(`^https://${host.replaceAll('.', '\\.')}/user-attachments/assets/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`, 'i').test(value)) {
    throw new MediaUploadError('GitHub returned an invalid attachment URL; upload outcome uncertain.', true)
  }
  return value
}

export type MediaBytes = { bytes: Buffer; mime: string; kind: 'image' | 'video'; name: string }

/** Snapshot once, hash that snapshot, then upload that same buffer rather than reopening a path. */
export async function approvedMediaBytes(root: string, file: string, digest: string, approvals: ReadonlySet<string>): Promise<MediaBytes & { artifactPath: string }> {
  if (!/^[a-f0-9]{64}$/.test(digest) || !approvals.has(digest)) throw new Error('Exact-content publication approval required.')
  const type = types[path.extname(file).toLowerCase()]
  if (!type) throw new Error('Unsupported media type.')
  const base = path.resolve(root)
  const target = path.resolve(base, file)
  const relative = path.relative(base, target)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Artifact is outside its evidence root.')
  async function checkPath() {
    let current = base
    for (const component of ['', ...relative.split(path.sep)]) {
      current = path.join(current, component)
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlinked artifacts are not publishable.')
    }
    const canonicalBase = await realpath(base)
    const canonicalTarget = await realpath(target)
    if (canonicalTarget !== path.join(canonicalBase, relative)) throw new Error('Artifact path changed during validation.')
    return canonicalTarget
  }
  await checkPath()
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    const limit = (type.kind === 'image' ? 10 : 100) * 1024 * 1024
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > limit) throw new Error('Media must be a nonempty singly-linked regular file within the image (10 MiB) or video (100 MiB) limit.')
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await handle.stat()
    const named = await lstat(target)
    const artifactPath = await checkPath()
    const bytes = buffer.subarray(0, length)
    if (length !== before.size || after.nlink !== 1 || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.dev !== before.dev || named.ino !== before.ino || createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Artifact changed after approval.')
    const magic = bytes.subarray(0, 16)
    const matches = type.mime === 'image/png' ? magic.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : type.mime === 'image/jpeg' ? magic.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
      : type.mime === 'image/gif' ? /^GIF8[79]a/.test(magic.toString('ascii'))
      : type.mime === 'image/webp' ? magic.toString('ascii', 0, 4) === 'RIFF' && magic.toString('ascii', 8, 12) === 'WEBP'
      : type.mime === 'video/webm' ? magic.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))
      : magic.toString('ascii', 4, 8) === 'ftyp'
    if (!matches) throw new Error('Media bytes do not match the supported file type.')
    return { bytes, ...type, name: `${digest}${path.extname(file).toLowerCase()}`, artifactPath }
  } finally { await handle.close() }
}

// GitHub CLI v2.99.0 attachment protocol. GHES and App/Actions credentials are unsupported.
export async function uploadGithubMedia(input: MediaBytes & { host: string; repositoryId: string; token: string }, request: typeof fetch = fetch): Promise<string> {
  if (input.host !== 'github.com') throw new MediaUploadError('Media attachments currently support github.com only.')
  if (!/^(gho_|ghp_|github_pat_)/.test(input.token)) throw new MediaUploadError('Unsupported authentication type: media requires OAuth or a personal access token, not an App/Actions token.')
  if (!/^[1-9][0-9]*$/.test(input.repositoryId)) throw new MediaUploadError('Invalid attachment repository identity.')
  const endpoint = new URL('https://uploads.github.com/user-attachments/assets')
  endpoint.search = new URLSearchParams({ name: input.name, content_type: input.mime, repository_id: input.repositoryId }).toString()
  try {
    const response = await request(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${input.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(input.bytes)
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new MediaUploadError(`GitHub media upload returned HTTP ${response.status}; local evidence retained.`, response.status >= 500)
    }
    // A bounded response avoids accepting arbitrary server text as report content.
    const reader = response.body?.getReader()
    if (!reader) throw new MediaUploadError('Empty upload response.', true)
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > 16 * 1024) throw new MediaUploadError('Oversized upload response.', true)
        chunks.push(next.value)
      }
    } finally { await reader.cancel() }
    return attachmentUrl(JSON.parse(Buffer.concat(chunks).toString('utf8')).url, input.host)
  } catch (error) {
    if (error instanceof MediaUploadError) throw error
    // Never echo transport errors: they may include headers, credentials, or response bodies.
    throw new MediaUploadError('Media upload outcome uncertain; automatic retry withheld and local evidence retained.', true)
  }
}

export type MediaPublicationContext = {
  ledger: DomainLedger
  runId: string
  candidate: string
  evidenceCandidate: string
  ownership: { repoRoot: string; branch: string; generationToken: number }
  repositoryId: string
  host: string
  upload: (media: MediaBytes) => Promise<string>
}

export async function publishMediaArtifact(root: string, file: string, digest: string, approvals: ReadonlySet<string>, context: MediaPublicationContext): Promise<PullRequestArtifact> {
  const artifact: PullRequestArtifact = { name: path.basename(file), content: `Artifact: ${path.basename(file)}\nSHA-256: ${digest}\nCandidate: ${context.evidenceCandidate}` }
  let media: Awaited<ReturnType<typeof approvedMediaBytes>>
  try {
    if (context.candidate !== context.evidenceCandidate) throw new Error('Artifact evidence belongs to a different candidate.')
    media = await approvedMediaBytes(root, file, digest, approvals)
  } catch {
    artifact.content += '\nMedia not published: unapproved, invalid, unsupported, or changed artifact. Local evidence retained.'
    return artifact
  }
  const key = { runId: context.runId, candidate: context.candidate, digest, repositoryId: context.repositoryId, host: context.host }
  if (context.ledger.beginMediaPublication(key, media.artifactPath, context.ownership)) {
    try {
      const url = attachmentUrl(await context.upload(media), context.host)
      context.ledger.finishMediaPublication(key, { status: 'published', url, detail: 'GitHub attachment published.' }, context.ownership)
    } catch (error) {
      context.ledger.finishMediaPublication(key, {
        status: error instanceof MediaUploadError && !error.uncertain ? 'failed' : 'uncertain',
        detail: error instanceof MediaUploadError ? error.message : 'Upload outcome uncertain; automatic retry withheld and local evidence retained.'
      }, context.ownership)
    }
  }
  const recorded = context.ledger.mediaPublication(key, media.artifactPath)
  if (!recorded) {
    artifact.content += '\nMedia not published: coordinator no longer owns the branch lease. Local evidence retained.'
    return artifact
  }
  artifact.content += `\nSize: ${media.bytes.length} bytes\n${recorded.detail}`
  if (recorded.status === 'published' && recorded.url) artifact.media = { kind: media.kind, url: attachmentUrl(recorded.url, context.host) }
  else artifact.content += '\nNot confirmed viewable remotely; no automatic re-upload. A new run is required to retry after investigating the previous attempt.'
  return artifact
}

export function isMediaArtifact(file: string): boolean {
  return Object.hasOwn(types, path.extname(file).toLowerCase()) || /\.(svg|avi|mkv|pdf)$/i.test(file)
}
