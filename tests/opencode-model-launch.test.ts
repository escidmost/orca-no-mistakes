import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CliOrca, startWorkerWithFallback, type WorkerLaunch } from '../scripts/orca-no-mistakes.ts'

process.env.WORKER_SHELL_STARTUP_DELAY_MS ??= '0'

test('OpenCode normal and contract-repair launches validate before execution and preserve model/effort', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'opencode-model-'))
  const command = path.join(temp, 'orca')
  const callsPath = path.join(temp, 'calls.jsonl')
  const runId = path.basename(temp)
  const evidence = path.join(homedir(), '.orca-no-mistakes', 'artifacts', runId)
  const reportPath = path.join(evidence, 'report.json')
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const out = result => console.log(JSON.stringify({ result }))
if (args[0] === 'orchestration' && args[1] === 'run-create') {
  out({ run: { id: ${JSON.stringify(runId)} } })
} else if (args[0] === 'terminal' && args[1] === 'create') {
  out({ terminal: { handle: 'worker-shell' } })
} else if (args[0] === 'terminal' && args[1] === 'show') {
  out({ terminal: { connected: true, title: 'OpenCode', preview: 'ready' } })
} else if (args[0] === 'orchestration' && args[1] === 'dispatch') {
  out({ dispatch: { id: 'dispatch-review' }, injected: true, preamble: 'authenticated' })
} else if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ findings: [], summary: 'reviewed' }))
  out({ messages: [{ type: 'worker_done', payload: JSON.stringify({ taskId: 'task-review', dispatchId: 'dispatch-review', outcome: 'succeeded', reportPath: ${JSON.stringify(reportPath)} }) }] })
} else {
  out({ ok: true })
}
`)
    await chmod(command, 0o755)
    const calls = async () => (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    for (const repair of [false, true]) {
      for (const model of ['gpt-6-astra', 'openai/gpt-6-astra']) {
        await writeFile(callsPath, '')
        let attempts = 0
        class RepairOrca extends CliOrca {
          override async startWorker(taskId: string, launch: WorkerLaunch) {
            if (repair && attempts++ === 0) throw new Error('worker previous returned an invalid report')
            if (repair) assert.match(launch.prompt, /REPORT REPAIR/)
            return super.startWorker(taskId, launch)
          }
        }
        const orca = new RepairOrca({ command, cwd: temp })
        await orca.createRun('OpenCode model validation')
        const launch: WorkerLaunch = {
          agent: { harness: 'opencode', model, effort: 'medium' },
          name: 'model-review', prompt: 'Review.', reportPath,
          role: 'reviewer', stage: 'review', worktree: 'current',
        }
        const run = startWorkerWithFallback(orca, async () => 'task-review', [launch])
        if (model === 'gpt-6-astra') {
          await assert.rejects(run, /agent opencode: invalid model 'gpt-6-astra'.*provider\/model/)
          assert.equal((await calls()).filter(args =>
            (args[0] === 'terminal' && args[1] === 'send') ||
            (args[0] === 'orchestration' && args[1] === 'dispatch'),
          ).length, 0, 'invalid model must never execute or receive a task')
          assert.ok((await calls()).some(args =>
            args[0] === 'terminal' && args[1] === 'close' && args.includes('worker-shell'),
          ), 'validation failure must clean up the prepared terminal')
        } else {
          assert.equal((await run).worker.report.summary, 'reviewed')
          const sends = (await calls()).filter(args => args[0] === 'terminal' && args[1] === 'send')
          assert.equal(sends.length, 1)
          assert.equal(sends[0][sends[0].indexOf('--text') + 1],
            `OPENCODE_CONFIG_CONTENT='{"agent":{"build":{"model":"openai/gpt-6-astra","variant":"medium"}}}' 'opencode' '--model' 'openai/gpt-6-astra' '--agent' 'build'`)
        }
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
    await rm(evidence, { recursive: true, force: true })
  }
})
