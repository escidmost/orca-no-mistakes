import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pullRequestContent } from '../pull-request.ts'
import type { StageReport } from '../orca-no-mistakes.ts'

// Drive the installed product interface with real subprocesses and retained output.
const root = path.resolve(import.meta.dirname, '../..')
execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'bin', 'scripts'], { cwd: root })
const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const home = await mkdtemp(path.join(tmpdir(), 'onm-live-acceptance-'))
const directory = path.join(home, 'artifacts', 'live-validation')
await mkdir(directory, { recursive: true })
const transcript: { args: string[]; status: number | null; stdout: string; stderr: string }[] = []
function invoke(args: string[], input?: unknown) {
  const result = spawnSync(path.join(root, 'bin/orca-no-mistakes'), args, {
    cwd: root, env: { ...process.env, ORCA_NO_MISTAKES_HOME: home },
    encoding: 'utf8', input: input === undefined ? undefined : JSON.stringify(input), timeout: 30_000,
  })
  if (result.error) throw result.error
  transcript.push({ args, status: result.status, stdout: result.stdout, stderr: result.stderr })
  return result
}
const invalidPath = path.join(directory, 'rejected.json')
const invalid = invoke(['report', '--stage', 'test', '--role', 'reviewer', '--out', invalidPath], { findings: [], summary: 'Unsupported empty-evidence claim' })
assert.equal(invalid.status, 1)
assert.match(invalid.stderr, /invalid liveValidation/)
assert.equal(existsSync(invalidPath), false)

const repairPath = path.join(directory, 'fixer.json')
const repair = invoke(['report', '--stage', 'test', '--role', 'fixer', '--out', repairPath], { findings: [], summary: 'Repair handoff without checker evidence' })
assert.equal(repair.status, 0, repair.stderr)
assert.equal(JSON.parse(await readFile(repairPath, 'utf8')).liveValidation, undefined)

const transcriptPath = path.join(directory, 'cli-transcript.json')
await writeFile(transcriptPath, JSON.stringify({ candidate, transcript }, null, 2))
const report: StageReport = {
  findings: [], summary: 'Real CLI rejects unsupported Test claims and accepts the separate fixer contract.',
  artifacts: [transcriptPath], tested: transcript.map((t) => `./bin/orca-no-mistakes ${t.args.join(' ')}`),
  liveValidation: {
    verdict: 'go', reason: 'Both report-submission scenarios ran against the committed executable and produced the expected filesystem outcomes.',
    scenarios: [
      { name: 'Reject an unsupported Test checker claim', result: 'pass', live: true, evidence: [`Exit ${invalid.status}: ${invalid.stderr.trim()}`, 'No rejected.json was written', transcriptPath], limitation: '' },
      { name: 'Accept a fixer handoff without requiring checker evidence', result: 'pass', live: true, evidence: [`Exit ${repair.status}: ${repair.stdout.trim()}`, `Persisted ${repairPath} without liveValidation`, transcriptPath], limitation: '' },
    ],
  },
}
const out = path.join(directory, 'test.json')
const accepted = invoke(['report', '--stage', 'test', '--role', 'reviewer', '--out', out], report)
assert.equal(accepted.status, 0, accepted.stderr)
const persisted: StageReport = JSON.parse(await readFile(out, 'utf8'))
assert.deepEqual(persisted.liveValidation, report.liveValidation)
assert.equal(persisted.findings.length, 0)
const { body } = pullRequestContent('ONM-98: Require structured live-validation scenarios and verdicts', {
  candidateCommitOid: candidate, whatChanged: 'Structured live Test evidence.',
  risk: { level: 'medium', rationale: 'New checker reports must use the explicit contract.' },
  testing: { summary: persisted.summary, tested: persisted.tested ?? [], artifacts: [], liveValidation: persisted.liveValidation, evidenceCommitOid: candidate },
  pipelineSteps: [{ name: 'test', status: 'completed', rounds: [{ summary: persisted.summary, findings: [], liveValidation: persisted.liveValidation, evidenceCommitOid: candidate }] }],
})
assert.match(body, /Reject an unsupported Test checker claim: pass; live: true/)
assert.match(body, /Accept a fixer handoff without requiring checker evidence: pass; live: true/)
assert.ok(body.includes(candidate))
await writeFile(path.join(directory, 'report.md'), body)
await writeFile(path.join(directory, 'submission-receipt.json'), JSON.stringify(transcript.at(-1), null, 2))
console.log(`LIVE VALIDATION ACCEPTANCE PASSED: ${directory}/report.md (candidate ${candidate})`)
