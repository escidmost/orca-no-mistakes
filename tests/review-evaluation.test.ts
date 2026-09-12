import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  adjudicate, bestEffortCapture, captureCase, compare, completeAutomaticCapture, identity,
  importCase, loadCase, loadGold, loadResult, pruneCase, replayCase, score, seedCorpus, selectCases,
} from '../scripts/review-evaluation.ts'
import { parseConfig } from '../scripts/config.ts'
import { CliOrca, main } from '../scripts/orca-no-mistakes.ts'
import { cleanGitEnvironment } from '../scripts/ledger.ts'

test('replay CLI help succeeds without corpus access while missing commands still fail', async t => {
  const output: string[] = []
  t.mock.method(console, 'log', (message: unknown) => output.push(String(message)))
  for (const flag of ['--help', '-h']) await main(['evaluation', flag])
  assert.equal(output.length, 2)
  assert.ok(output.every(line => line.startsWith('Usage: orca-no-mistakes evaluation ')))
  await assert.rejects(main(['evaluation']), /Usage:/)
  await assert.rejects(main(['evaluation', 'list', '--unknown-option']), /Unknown option/)
})

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'onm-evaluation-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'source'), corpus = path.join(root, 'corpus')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...cleanGitEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Corpus fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Corpus fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' },
  }).trim()
  git('init', '-b', 'main')
  writeFileSync(path.join(repo, 'total.mjs'), 'export const total = (price, quantity) => price * quantity;\n')
  git('add', '.'); git('commit', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  writeFileSync(path.join(repo, 'total.mjs'), 'export const total = (price, quantity) => price + quantity;\n')
  git('commit', '-am', 'introduce known defect')
  const candidate = git('rev-parse', 'HEAD')
  const source = { reference: 'fixture:human-review', note: 'Test-only explicit annotation: multiplication, not addition.' }
  const options = { repo, corpus, base, candidate, intent: 'Calculate price times quantity', source }
  const acpx = path.join(root, 'acpx')
  writeFileSync(acpx, `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
assert.equal(args[args.indexOf('--format') + 1], 'quiet');
assert.match(prompt, /independent read-only review worker/);
assert.match(prompt, /Do NOT run tests during review/);
assert.match(prompt, /Repository: \./);
assert.match(prompt, /Do not edit or commit files/);
assert.equal(cp.execFileSync('git', ['remote'], {encoding:'utf8'}).trim(), '');
const model = args[args.indexOf('--model') + 1];
if (model === 'mutate') fs.writeFileSync('total.mjs', 'repaired without permission');
if (model === 'invalid') { console.log('not a report'); process.exit(0); }
if (model === 'failure') { console.error('provider failed'); process.exit(3); }
const findings = [];
if (fs.readFileSync('total.mjs', 'utf8').includes('price + quantity')) findings.push({id:'total', action:'auto-fix', severity:'error', file:'total.mjs', line:1, description:'total(2,3) returns 5, expected 6.'});
if (model === 'extra') findings.push({id:'overflow', action:'ask-user', severity:'warning', file:'total.mjs', line:1, description:'Should unusually large totals be bounded?'});
console.log(JSON.stringify({findings, summary:'Offline fixture review complete', riskLevel:'low', riskRationale:'Fixture'}));
`)
  chmodSync(acpx, 0o700)
  const config = (model = 'exact') => ({ harness: 'acp:fixture', model, timeout_ms: 5000, environment: 'offline-test-fixture-v1' })
  return { root, repo, corpus, git, base, candidate, source, options, acpx, config }
}

test('capture validates immutable inputs, deduplicates, deterministically selects fixed corpus and retains provenance', t => {
  const f = fixture(t)
  assert.throws(() => selectCases(f.corpus), /Select at least one case, with no duplicate IDs/)
  const defect = captureCase(f.options)
  assert.equal(captureCase(f.options).id, defect.id)
  const clean = captureCase({ ...f.options, candidate: f.base })
  assert.notEqual(defect.id, clean.id)
  assert.deepEqual(selectCases(f.corpus, [defect.id, clean.id]), [defect.id, clean.id].sort())
  assert.throws(() => selectCases(f.corpus, [defect.id, defect.id]), /duplicate/)
  assert.equal(defect.source.reference, f.source.reference)
  assert.equal(captureCase({ ...f.options, source: { ...f.source, reference: 'another-run' } }).id, defect.id)
  assert.equal(readdirSync(path.join(f.corpus, 'cases', defect.id, 'sources')).length, 2)
  assert.equal(identity(defect.inputs), defect.id)
  assert.match(defect.inputs.prompt, /price \+ quantity/)
  assert.equal(f.git('for-each-ref', '--format=%(refname)', 'refs/orca-review-capture'), '')
  const dir = path.join(f.corpus, 'cases', defect.id)
  const parsed = JSON.parse(readFileSync(path.join(dir, 'case.json'), 'utf8'))
  parsed.inputs.intent = 'silently changed'
  writeFileSync(path.join(dir, 'case.json'), JSON.stringify(parsed))
  assert.throws(() => loadCase(f.corpus, defect.id), /identity mismatch/)
})

test('historical capture rejects missing prompt and bundle instead of substituting current policy', t => {
  const f = fixture(t)
  const value = captureCase(f.options)
  const historical = path.join(f.root, 'historical')
  mkdirSync(path.join(historical, 'cases', value.id), { recursive: true })
  writeFileSync(path.join(historical, 'cases', value.id, 'case.json'), JSON.stringify({ findings: [], verdict: 'passed' }))
  assert.throws(() => importCase(historical, path.join(f.root, 'imported'), value.id), /Incomplete historical review inputs/)
  const imported = importCase(f.corpus, path.join(f.root, 'imported'), value.id)
  assert.deepEqual(imported, value)
  captureCase({ ...f.options, source: { ...f.source, reference: 'another-run' } })
  importCase(f.corpus, path.join(f.root, 'imported'), value.id)
  assert.equal(readdirSync(path.join(f.root, 'imported', 'cases', value.id, 'sources')).length, 2)
  assert.deepEqual(loadGold(path.join(f.root, 'imported'), value.id).issues, [])
  writeFileSync(path.join(f.corpus, 'cases', value.id, 'repository.bundle'), 'corrupt')
  assert.throws(() => loadCase(f.corpus, value.id), /bundle identity/)
  rmSync(path.join(f.corpus, 'cases', value.id, 'repository.bundle'))
  assert.throws(() => loadCase(f.corpus, value.id), /Incomplete historical review inputs/)
})

test('retention survives source ref deletion and garbage collection; pruning never damages another case', async t => {
  const f = fixture(t)
  const defect = captureCase(f.options)
  const clean = captureCase({ ...f.options, candidate: f.base })
  f.git('reset', '--hard', f.base)
  f.git('reflog', 'expire', '--expire=now', '--all')
  f.git('gc', '--prune=now')
  assert.throws(() => f.git('cat-file', '-e', f.candidate))
  assert.equal((await replayCase(f.corpus, defect.id, f.config(), f.acpx)).findings.length, 1)
  pruneCase(f.corpus, clean.id)
  assert.deepEqual(selectCases(f.corpus), [defect.id])
  assert.equal((await replayCase(f.corpus, defect.id, f.config(), f.acpx)).findings.length, 1)
})

test('replay uses two explicit configurations and fixed inputs with isolated findings and source state', async t => {
  const f = fixture(t)
  const value = captureCase(f.options)
  const before = f.git('show-ref')
  const sourceState = path.join(f.repo, 'source-run.json')
  writeFileSync(sourceState, JSON.stringify({ verdict: 'passed', findings: ['original'], decisions: ['approve'] }))
  const state = readFileSync(sourceState, 'utf8')
  const exact = await replayCase(f.corpus, value.id, f.config(), f.acpx)
  const extra = await replayCase(f.corpus, value.id, f.config('extra'), f.acpx)
  assert.equal(exact.caseId, extra.caseId)
  assert.notEqual(exact.configId, extra.configId)
  assert.equal(exact.findings.length, 1)
  assert.equal(extra.findings.length, 2)
  assert.equal(exact.usage, null)
  assert.match(exact.usageReason, /unavailable, not zero/)
  assert.ok(exact.latencyMs > 0)
  assert.equal(f.git('show-ref'), before)
  assert.equal(readFileSync(sourceState, 'utf8'), state)
  assert.deepEqual(loadResult(f.corpus, value.id, exact.id), exact)
  await assert.rejects(replayCase(f.corpus, value.id, { harness: 'acp:fixture' }, f.acpx))
  await assert.rejects(replayCase(f.corpus, value.id, { ...f.config(), harness: 'claude' }, f.acpx))
  await assert.rejects(replayCase(f.corpus, value.id, f.config('mutate'), f.acpx), /isolation violated/)
  await assert.rejects(replayCase(f.corpus, value.id, f.config('invalid'), f.acpx), /invalid report/)
  await assert.rejects(replayCase(f.corpus, value.id, f.config('failure'), f.acpx), /failed/)
  assert.equal(readdirSync(path.join(f.corpus, 'cases', value.id, 'results')).length, 2)
  const inherited = process.env.GIT_DIR
  process.env.GIT_DIR = path.join(f.repo, '.git')
  try { assert.equal((await replayCase(f.corpus, value.id, f.config(), f.acpx)).findings.length, 1) }
  finally { if (inherited === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = inherited }
  assert.match(readFileSync(path.join(f.repo, 'total.mjs'), 'utf8'), /price \+ quantity/)
})

test('gold adjudication and scoring preserve unknowns, issue denominators and explicit rejected findings', async t => {
  const f = fixture(t)
  const value = captureCase(f.options)
  const result = await replayCase(f.corpus, value.id, f.config('extra'), f.acpx)
  let scored = score(result, loadGold(f.corpus, value.id))
  assert.equal(scored.pending, 2)
  assert.equal(scored.judgedFindingPrecision, null)
  assert.equal(scored.knownIssueRecall, null)
  const issue = { id: 'multiply', description: 'Price must be multiplied by quantity.' }
  adjudicate(f.corpus, value.id, { issue, source: f.source })
  scored = score(result, loadGold(f.corpus, value.id))
  assert.equal(scored.knownIssues, 1)
  assert.equal(scored.knownIssueRecall, 0)
  assert.equal(scored.pending, 2)
  adjudicate(f.corpus, value.id, { issue, source: f.source, resultId: result.id, findingIndex: 0 })
  scored = score(result, loadGold(f.corpus, value.id))
  assert.equal(scored.knownIssueRecall, 1)
  assert.equal(scored.pending, 1)
  assert.equal(scored.rejected, 0)
  adjudicate(f.corpus, value.id, { reject: true, source: f.source, resultId: result.id, findingIndex: 1 })
  scored = score(result, loadGold(f.corpus, value.id))
  assert.equal(scored.judgedFindingPrecision, 0.5)
  assert.equal(scored.coverage, 'incomplete')
  assert.equal(scored.pending, 0)
  assert.equal(readdirSync(path.join(f.corpus, 'cases', value.id, 'labels')).length, 3)
  assert.throws(() => adjudicate(f.corpus, value.id, { reject: true, source: f.source }), /result/)
  assert.throws(() => adjudicate(f.corpus, value.id, { reject: true, source: f.source, resultId: result.id, findingIndex: 9 }), /outside/)
  assert.throws(() => adjudicate(f.corpus, value.id, { issue: { ...issue, description: 'other definition' }, source: f.source }), /another definition/)
  const clean = captureCase({ ...f.options, candidate: f.base })
  const cleanResult = await replayCase(f.corpus, clean.id, f.config(), f.acpx)
  assert.equal(cleanResult.findings.length, 0)
  assert.equal(score(cleanResult, loadGold(f.corpus, clean.id)).coverage, 'incomplete')
  adjudicate(f.corpus, clean.id, { complete: true, source: f.source })
  const extraClean = await replayCase(f.corpus, clean.id, f.config('extra'), f.acpx)
  assert.equal(score(extraClean, loadGold(f.corpus, clean.id)).pending, 1)
  assert.throws(() => score(result, loadGold(f.corpus, clean.id)), /another case/)
})

test('comparison enforces equal fixed case sets across explicit configurations and reports incomplete labels', async t => {
  const f = fixture(t)
  const seed = seedCorpus(f.repo, f.corpus, { version: 1, cases: [
    { name: 'defect', base: f.base, candidate: f.candidate, intent: f.options.intent, source: f.source,
      issues: [{ id: 'multiply', description: 'Multiply price and quantity.', source: f.source }] },
    { name: 'clean', base: f.base, candidate: f.base, intent: f.options.intent, source: f.source, issues: [] },
  ] })
  const selections: { caseId: string; resultId: string }[] = []
  for (const model of ['exact', 'extra']) for (const entry of seed) {
    const result = await replayCase(f.corpus, entry.caseId, f.config(model), f.acpx)
    selections.push({ caseId: entry.caseId, resultId: result.id })
  }
  const report = compare(f.corpus, selections)
  assert.match(report, /model=exact/)
  assert.match(report, /model=extra/)
  assert.match(report, /pending human judgment/)
  assert.match(report, /labels=incomplete/)
  assert.match(report, /issues=0\/1/)
  assert.throws(() => compare(f.corpus, selections.slice(0, 3)), /same fixed case set/)
  assert.throws(() => compare(f.corpus, [...selections, selections[0]]), /exactly one result/)
})

test('automatic completion capture is opt-in, deduplicated, label-free and failure-isolated', t => {
  const f = fixture(t)
  assert.equal(parseConfig({}).evaluation?.capture_on_completion ?? false, false)
  assert.equal(parseConfig({ evaluation: { capture_on_completion: true } }).evaluation?.capture_on_completion, true)
  const value = captureCase(f.options)
  adjudicate(f.corpus, value.id, { issue: { id: 'multiply', description: 'Multiply' }, source: f.source })
  const retained = path.join(f.root, 'retained')
  completeAutomaticCapture(f.corpus, retained)
  completeAutomaticCapture(f.corpus, retained)
  assert.deepEqual(selectCases(retained), [value.id])
  assert.deepEqual(loadGold(retained, value.id).issues, [])
  const warnings: string[] = []
  bestEffortCapture(() => { throw new Error('disk full') }, message => warnings.push(message))
  assert.match(warnings[0], /pipeline outcome unchanged.*disk full/)
  const absent = path.join(f.root, 'absent')
  completeAutomaticCapture(absent, path.join(f.root, 'unused'))
  assert.equal(existsSync(path.join(f.root, 'unused')), false)
})

test('capture refuses external LFS and submodule inputs instead of certifying incomplete cases', t => {
  const f = fixture(t)
  writeFileSync(path.join(f.repo, 'notes'), '# LFS documentation\nversion https://git-lfs.github.com/spec/v1\n')
  f.git('add', '.'); f.git('commit', '-m', 'LFS mention is not a pointer')
  assert.doesNotThrow(() => captureCase({ ...f.options, candidate: 'HEAD' }))
  writeFileSync(path.join(f.repo, 'asset'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n')
  f.git('add', '.'); f.git('commit', '-m', 'LFS pointer')
  assert.throws(() => captureCase({ ...f.options, candidate: 'HEAD' }), /LFS/)
  f.git('reset', '--hard', f.candidate)
  f.git('update-index', '--add', '--cacheinfo', `160000,${f.base},submodule`)
  f.git('commit', '-m', 'submodule')
  assert.throws(() => captureCase({ ...f.options, candidate: 'HEAD' }), /submodule/)
})

test('capture and replay retain the source SHA-256 object format', async t => {
  const version = execFileSync('git', ['--version'], { encoding: 'utf8' }).match(/git version (\d+)\.(\d+)/)
  assert.ok(version, 'Git version must be identifiable')
  if (Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 29)) {
    t.skip('SHA-256 bundles require Git >=2.29')
    return
  }
  const f = fixture(t)
  rmSync(path.join(f.repo, '.git'), { recursive: true })
  f.git('init', '--object-format=sha256', '-b', 'main')
  f.git('add', '.'); f.git('commit', '-m', 'SHA-256 candidate')
  const value = captureCase({ ...f.options, base: 'HEAD', candidate: 'HEAD' })
  assert.equal(value.inputs.candidate.length, 64)
  assert.equal((await replayCase(f.corpus, value.id, f.config(), f.acpx)).caseId, value.id)
})

test('automatic import isolates corrupt cases and pruning keeps validated path boundaries', t => {
  const f = fixture(t)
  const valid = captureCase(f.options)
  const malformed = captureCase({ ...f.options, intent: 'malformed' })
  const corrupt = captureCase({ ...f.options, intent: 'corrupt' })
  writeFileSync(path.join(f.corpus, 'cases', malformed.id, 'case.json'), '{}')
  writeFileSync(path.join(f.corpus, 'cases', corrupt.id, 'repository.bundle'), 'corrupt')
  const warnings: string[] = []
  t.mock.method(console, 'error', (message: string) => warnings.push(message))
  const destination = path.join(f.root, 'imported')
  completeAutomaticCapture(f.corpus, destination)
  assert.deepEqual(selectCases(destination), [valid.id])
  assert.equal(warnings.length, 2)
  for (const id of [malformed.id, corrupt.id]) pruneCase(f.corpus, id)
  assert.throws(() => pruneCase(f.corpus, '../source'), /Invalid/)
  assert.throws(() => pruneCase(f.corpus, corrupt.id), /No such review case/)
  assert.deepEqual(selectCases(f.corpus), [valid.id])
})

test('replay failed outcomes are not reported as isolation violations', async t => {
  const f = fixture(t)
  const value = captureCase(f.options)
  t.mock.method(CliOrca.prototype, 'startWorker', async () => ({ failedOutcome: true }))
  t.mock.method(CliOrca.prototype, 'finishWorker', async () => {})
  await assert.rejects(replayCase(f.corpus, value.id, f.config(), f.acpx), /Review replay failed/)
})

test('capture fixture excludes inherited repository-scoping environment', t => {
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']
  const prior = keys.map(key => process.env[key])
  try {
    for (const key of keys) process.env[key] = '/nonexistent/onm-fixture-sentinel'
    const f = fixture(t)
    assert.equal(f.git('rev-parse', 'HEAD'), f.candidate)
  } finally {
    keys.forEach((key, index) => { if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index] })
  }
})
