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
const report = {
  source, platform: platform(), architecture: arch(), node: process.version, locale, userId: process.getuid?.(),
  git: git('--version'), startedAt: new Date().toISOString(),
  tests: files, status: 'running', exitCode: null as number | null,
}
const record = () => writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
record()
const log = openSync(path.join(output, 'tests.tap'), 'wx')
let result
try {
  result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=4', ...files.map((name) => `tests/${name}`)], {
    cwd: root, env: { ...process.env, LC_ALL: locale, LANG: locale }, stdio: ['ignore', log, log],
  })
} finally {
  closeSync(log)
}
report.exitCode = result.status
report.status = result.status === 0 ? 'passed' : 'failed'
record()
if (result.error) console.error(result.error.message)
console.log(`${report.status === 'passed' ? 'LOCAL ACCEPTANCE PASSED' : 'LOCAL ACCEPTANCE FAILED'}: ${output}`)
process.exitCode = result.status === 0 ? 0 : 1
