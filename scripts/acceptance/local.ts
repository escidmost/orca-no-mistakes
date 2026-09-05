import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const locale = platform() === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
const root = fileURLToPath(new URL('../../', import.meta.url))
const output = path.resolve(process.argv[2] ?? `acceptance-results/local-${Date.now()}`)
// Refuse reused evidence directories so a failed invocation cannot inherit a passing result.
mkdirSync(path.dirname(output), { recursive: true })
mkdirSync(output, { recursive: false })
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const report = {
  platform: platform(), architecture: arch(), node: process.version, locale, userId: process.getuid?.(),
  git: null as string | null, startedAt: new Date().toISOString(),
  tests: [] as string[], status: 'running', exitCode: null as number | null,
}
const record = () => writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
record()
const log = openSync(path.join(output, 'tests.tap'), 'wx')
try {
  report.git = git('--version')
  const files = readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('.test.ts')).sort()
  if (!files.length) throw new Error('No acceptance tests found')
  const source = {
    commit: git('rev-parse', 'HEAD'),
    trackedDiffSha256: createHash('sha256').update(git('diff', 'HEAD', '--binary')).digest('hex'),
    files: Object.fromEntries(['scripts', 'tests'].flatMap((directory) =>
      readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .map((entry) => {
          const filename = path.join(entry.parentPath, entry.name)
          return [path.relative(root, filename), createHash('sha256').update(readFileSync(filename)).digest('hex')]
        }))),
  }
  Object.assign(report, { source, tests: files })
  record()
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=4', ...files.map((name) => `tests/${name}`)], {
    cwd: root, env: { ...process.env, LC_ALL: locale, LANG: locale }, stdio: ['ignore', log, log],
  })
  if (result.error) throw result.error
  report.exitCode = result.status
  report.status = result.status === 0 ? 'passed' : 'failed'
  record()
  console.log(`${report.status === 'passed' ? 'LOCAL ACCEPTANCE PASSED' : 'LOCAL ACCEPTANCE FAILED'}: ${output}`)
  process.exitCode = result.status === 0 ? 0 : 1
} catch (error) {
  report.status = 'failed'
  report.exitCode = 1
  Object.assign(report, { error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) } })
  record()
  writeFileSync(log, 'Bail out! acceptance runner failed; see result.json\n')
  throw error
} finally {
  closeSync(log)
}
