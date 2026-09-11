import type { LiveValidation } from '../scripts/live-validation.ts'
import type { StageReport, WorkerLaunch } from '../scripts/orca-no-mistakes.ts'

// Simulated worker evidence for pipeline tests, never actual live-run evidence.
export const livePass: LiveValidation = {
  verdict: 'go', reason: 'Simulated product scenario succeeded',
  scenarios: [{ name: 'Simulated end-user workflow', result: 'pass', live: true, evidence: ['Simulated product output'], limitation: '' }],
}

export function withLivePass(launch: WorkerLaunch, report: StageReport): StageReport {
  return launch.stage === 'test' && launch.role === 'reviewer'
    ? { liveValidation: livePass, ...report }
    : report
}
