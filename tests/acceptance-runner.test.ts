import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

for (const scenario of ['missing-git', 'missing-tests', 'empty-tests', 'missing-git-head', 'passed', 'failed'] as const) {
  test(`acceptance runner retains evidence for ${scenario}`, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'onm-acceptance-runner-'))
    try {
      const runner = path.join(root, 'scripts/acceptance/local.ts')
      mkdirSync(path.dirname(runner), { recursive: true })
      copyFileSync(new URL('../scripts/acceptance/local.ts', import.meta.url), runner)
      if (scenario !== 'missing-tests') mkdirSync(path.join(root, 'tests'))
      if (scenario !== 'missing-tests' && scenario !== 'empty-tests') {
        writeFileSync(path.join(root, 'tests/control.test.ts'), `import test from 'node:test'; test('control', () => { ${scenario === 'failed' ? "throw new Error('fixture failure')" : ''} });\n`)
      }
      if (scenario === 'passed' || scenario === 'failed') {
        const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
        git('init')
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture')
      }
      const output = path.join(root, 'evidence')
      const env = { ...process.env }
      if (scenario === 'missing-git') env.PATH = root
      delete env.NODE_TEST_CONTEXT // The fixture launches an independent test runner.
      const result = spawnSync(process.execPath, [runner, output], { encoding: 'utf8', env })
      assert.equal(result.status, scenario === 'passed' ? 0 : 1, result.stderr)
      const report = JSON.parse(readFileSync(path.join(output, 'result.json'), 'utf8'))
      const tap = readFileSync(path.join(output, 'tests.tap'), 'utf8')
      assert.equal(report.status, scenario === 'passed' ? 'passed' : 'failed')
      assert.equal(report.exitCode, result.status)
      if (scenario === 'passed' || scenario === 'failed') {
        assert.equal(report.error, undefined)
        assert.match(report.source.commit, /^[a-f0-9]{40,64}$/)
        assert.deepEqual(report.tests, ['control.test.ts'])
        assert.match(tap, /# tests 1\n/)
        assert.match(tap, scenario === 'passed' ? /# pass 1\n/ : /# fail 1\n/)
      } else {
        assert.equal(report.error.name, 'Error')
        assert.match(report.error.message, scenario === 'missing-git' ? /ENOENT/ : scenario === 'empty-tests' ? /No acceptance tests found/ : scenario === 'missing-tests' ? /ENOENT/ : /git rev-parse HEAD/)
        assert.match(tap, /^Bail out!/)
        assert.ok(report.startedAt)
      }
      // A repeated invocation must not overwrite either passing or failing evidence.
      const before = readFileSync(path.join(output, 'result.json'), 'utf8')
      assert.notEqual(spawnSync(process.execPath, [runner, output]).status, 0)
      assert.equal(readFileSync(path.join(output, 'result.json'), 'utf8'), before)
      assert.equal(readFileSync(path.join(output, 'tests.tap'), 'utf8'), tap)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
