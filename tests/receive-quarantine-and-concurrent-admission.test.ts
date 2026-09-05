import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { anchorPermanentRef, initializeLocalGate, readGateRef, waitForPermanentRef } from '../scripts/admission.ts'
import { DomainLedger } from '../scripts/ledger.ts'

const admissionModule = new URL('../scripts/admission.ts', import.meta.url).href
const ledgerModule = new URL('../scripts/ledger.ts', import.meta.url).href

// The coordinator is controlled here; Git's actual receive/quarantine lifecycle
// and the installed hook's production admission primitives are exercised.
test('a real receive validates quarantined objects before promotion and anchors only the permanent candidate', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-receive-quarantine-'))
  const repo = path.join(temp, 'repo')
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
    git('config', 'user.name', 'Acceptance fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('remote', 'add', 'origin', path.join(temp, 'origin.git'))
    await writeFile(path.join(repo, 'candidate'), 'quarantined candidate\n')
    git('add', 'candidate')
    git('commit', '-m', 'candidate')
    execFileSync('git', ['init', '--bare', '-b', 'main', path.join(temp, 'origin.git')], { stdio: 'ignore' })
    git('push', 'origin', 'main')
    const candidate = git('rev-parse', 'HEAD')
    const probe = path.join(temp, 'receive.json')
    const entrypoint = path.join(temp, 'coordinator.mjs')
    await writeFile(entrypoint, `#!/usr/bin/env node
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { anchorPermanentRef, decodeIntentPushOption, parseReceiveUpdates, readGateMetadata, readGateRef, sanitizeCoordinatorEnvironment, validateQuarantinedCommit, validateReceiveUpdate } from ${JSON.stringify(admissionModule)};
      const metadata = await readGateMetadata(process.argv.at(-1));
      const update = validateReceiveUpdate(parseReceiveUpdates(readFileSync(0, 'utf8')), metadata.defaultBranch, decodeIntentPushOption(process.env));
      assert.ok(process.env.GIT_QUARANTINE_PATH);
      validateQuarantinedCommit(metadata.gatePath, update.newOid);
      assert.throws(() => validateQuarantinedCommit(metadata.gatePath, update.newOid, sanitizeCoordinatorEnvironment(process.env)), /not available/);
      assert.equal(readGateRef(metadata, update.refName), undefined);
      assert.throws(() => anchorPermanentRef(metadata, update, 'quarantine-control'), /could not atomically anchor/);
      writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ update, quarantine: process.env.GIT_QUARANTINE_PATH }));
    `, { mode: 0o700 })
    const metadata = await initializeLocalGate(repo, entrypoint)
    git('checkout', '-b', 'feature')
    git('push', `--push-option=no-mistakes.intent=${Buffer.from('Accept quarantine boundary.').toString('base64url')}`, metadata.remoteName, 'HEAD:refs/heads/feature')
    const observed = JSON.parse(await readFile(probe, 'utf8'))
    assert.equal(observed.update.newOid, candidate)
    await assert.rejects(stat(observed.quarantine), { code: 'ENOENT' })
    await waitForPermanentRef(metadata, observed.update)
    anchorPermanentRef(metadata, observed.update, 'quarantine-control')
    assert.equal(readGateRef(metadata, 'refs/orca-no-mistakes/heads/quarantine-control'), candidate)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

for (const replay of [false, true]) {
  test(`simultaneous cross-process ${replay ? 'replay shares one admission lease' : 'competing admission admits exactly one candidate'}`, { timeout: 30_000 }, async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'onm-admission-race-'))
    const ledgerPath = path.join(temp, 'ledger.sqlite')
    new DomainLedger(ledgerPath).close()
    const children: ReturnType<typeof spawn>[] = []
    try {
      const workers = Array.from({ length: 4 }, (_, index) => {
        const character = replay ? 'a' : 'abcd'[index]!
        const script = `
          import { DomainLedger } from ${JSON.stringify(ledgerModule)};
          const ledger = new DomainLedger(${JSON.stringify(ledgerPath)});
          process.once('message', () => {
            try {
              const row = ledger.beginSubmissionAdmission({ admissionId: 'admission-' + '${character}'.repeat(64), gateIdentity: 'gate', intent: 'Race admission.', newOid: '${character}'.repeat(40), oldOid: '0'.repeat(40), refName: 'refs/heads/feature', repoRoot: '/repo', source: '${index % 2 ? 'direct' : 'gate'}' });
              process.send({ admitted: true, id: row.admission_id, token: row.lease_token });
            } catch (error) {
              process.send({ admitted: false, error: error.message });
            } finally { ledger.close(); process.disconnect(); }
          });
          process.send('ready');
        `
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
        children.push(child)
        let result: { admitted: boolean; id?: string; token?: string; error?: string }
        const ready = new Promise<void>((resolve, reject) => {
          child.once('error', reject)
          child.on('message', (message) => {
            if (message === 'ready') resolve()
            else result = message as typeof result
          })
          child.once('exit', () => reject(new Error('worker exited before readiness')))
        })
        const done = new Promise<typeof result>((resolve, reject) => {
          child.once('error', reject)
          child.once('exit', (code) => code === 0 && result ? resolve(result) : reject(new Error(`worker exited ${code}`)))
        })
        return { child, ready, done }
      })
      const [, results] = await Promise.all([
        Promise.all(workers.map((worker) => worker.ready)).then(() => {
          for (const worker of workers) worker.child.send('start')
        }),
        Promise.all(workers.map((worker) => worker.done)),
      ])
      const admitted = results.filter((result) => result.admitted)
      assert.equal(admitted.length, replay ? 4 : 1)
      assert.equal(new Set(admitted.map((result) => result.token)).size, 1)
      assert.equal(new Set(admitted.map((result) => result.id)).size, 1)
      for (const result of results.filter((result) => !result.admitted)) assert.match(result.error!, /pending admission lease already exists/)
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill()
      await rm(temp, { recursive: true, force: true })
    }
  })
}
