import { z } from 'zod'
import type { Finding } from './orca-no-mistakes.ts'

const text = z.string().trim().min(1)

export const LiveValidationSchema = z.strictObject({
  verdict: z.enum(['go', 'no-go', 'inconclusive', 'no-surface']),
  reason: text,
  scenarios: z.array(z.strictObject({
    name: text,
    result: z.enum(['pass', 'fail', 'untested']),
    live: z.boolean(),
    evidence: z.array(text),
    limitation: z.string().trim(),
  })),
}).superRefine((report, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (report.verdict === 'no-surface') {
    if (report.scenarios.length !== 0) invalid('no-surface requires an empty scenario list and a reason')
  } else if (report.scenarios.length === 0) {
    invalid('live validation requires named scenarios')
  }
  const names = new Set<string>()
  for (const scenario of report.scenarios) {
    if (names.has(scenario.name)) invalid('scenario names must be unique')
    names.add(scenario.name)
    if (scenario.result === 'untested') {
      if (scenario.live || !scenario.limitation) invalid('untested scenarios must be non-live with a limitation')
    } else if (!scenario.live || scenario.evidence.length === 0) {
      invalid('pass/fail scenarios require live execution and evidence')
    }
  }
  if (report.scenarios.some((s) => s.result === 'fail') && report.verdict !== 'no-go') {
    invalid('a failed scenario requires no-go')
  }
  if (report.verdict === 'go' && !report.scenarios.some((s) => s.result === 'pass')) {
    invalid('go requires at least one live passed scenario')
  }
})

export type LiveValidation = z.infer<typeof LiveValidationSchema>

export const LIVE_VALIDATION_FINDING_ID = 'coordinator-live-validation'

export function liveValidationFinding(report: LiveValidation): Finding[] {
  if (report.verdict === 'go') return []
  return [{
    id: LIVE_VALIDATION_FINDING_ID,
    action: report.verdict === 'no-go' ? 'auto-fix' : 'ask-user',
    severity: report.verdict === 'no-go' ? 'error' : 'warning',
    description: `Live validation ${report.verdict}: ${report.reason}\n${report.scenarios.map((s) => `${s.name}: ${s.result}; evidence: ${s.evidence.join('; ') || 'none'}; limitation: ${s.limitation || 'none'}`).join('\n')}`,
  }]
}

export function liveValidationText(report: LiveValidation, candidate?: string): string {
  return [
    `Live validation: ${report.verdict}${candidate ? ` (candidate ${candidate})` : ''}`,
    `Reason: ${report.reason}`,
    ...report.scenarios.map((s) => `- ${s.name}: ${s.result}; live: ${s.live}\n  Evidence: ${s.evidence.join('; ') || 'none'}\n  Limitation: ${s.limitation || 'none'}`),
  ].join('\n')
}
