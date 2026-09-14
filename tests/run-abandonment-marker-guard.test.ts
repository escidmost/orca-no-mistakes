import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DomainLedger } from '../scripts/ledger.ts'
import { main } from '../scripts/orca-no-mistakes.ts'

const commit = 'a'.repeat(40)
const policy = 'b'.repeat(64)
const exited = spawnSync(process.execPath, ['-e', ''])
assert.equal(exited.status, 0)

test('abandon requires stranded cleanup for direct and gate markers', async (t) => {
  for (const [name, marker] of [
    ['direct', { kind: 'direct-run', runId: 'run' }],
    ['gate', { domainRunId: 'run', gate: { kind: 'orca' }, runId: 'orca-run' }],
  ] as const) {
    await t.test(name, async (t) => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'onm-abandon-marker-')))
      t.after(() => rmSync(root, { recursive: true, force: true }))
      execFileSync('git', ['init', '--quiet', root])
      const ledger = new DomainLedger({ repositoryPath: root })
      ledger.startRun({ repoRoot: root, runId: 'run', branch: 'feature', baseBranch: 'main',
        intent: 'Retain marker-owned resources', policySha256: policy, submissionCommitOid: commit })
      const generationToken = ledger.acquireLease({ repoRoot: root, branch: 'feature', runId: 'run' })
      ledger.startAttempt({ runId: 'run', attemptId: 'attempt', coordinatorIdentity: `no-mistakes:${exited.pid}`,
        actorIdentity: 'operator', generationToken, startedAt: new Date().toISOString() })
      ledger.close()
      const markersDir = path.join(root, '.orca', 'no-mistakes')
      mkdirSync(markersDir, { recursive: true })
      writeFileSync(path.join(markersDir, `gate-${name}.json`), JSON.stringify(marker))

      await assert.rejects(
        main(['abandon', '--repo', root, '--run-id', 'run', '--reason', 'Close dead run']),
        /run prune --stranded before abandon/,
      )

      const reopened = new DomainLedger({ repositoryPath: root })
      assert.equal(reopened.runStatus('run'), 'in-progress')
      assert.equal(reopened.leaseFor(root, 'feature')?.generation_token, generationToken)
      reopened.close()
    })
  }
})
