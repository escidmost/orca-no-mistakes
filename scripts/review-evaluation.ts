import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { canonicalJson, cleanGitEnvironment, noMistakesHome } from './ledger.ts'
import { checkerPrompt, CliOrca, validateReport, type Finding } from './orca-no-mistakes.ts'

const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const Text = z.string().trim().min(1)
const Source = z.strictObject({ reference: Text, note: Text })
const Inputs = z.strictObject({
  version: z.literal(1), base: Oid, candidate: Oid, branch: Text,
  intent: Text, decisionHistory: z.string(), prompt: Text,
  coordinator: Hash,
})
const Case = z.strictObject({ id: Hash, inputs: Inputs, bundleHash: Hash, source: Source })
export type ReviewCase = z.infer<typeof Case>
export const ReviewerConfig = z.strictObject({
  harness: z.string().regex(/^acp:[a-zA-Z0-9_-]+$/), model: Text,
  timeout_ms: z.number().int().positive(),
  // Operator records the external harness build/settings, which the coordinator cannot freeze.
  environment: Text,
})
export type ReviewerConfiguration = z.infer<typeof ReviewerConfig>
const FindingSchema = z.strictObject({
  id: Text, action: z.enum(['auto-fix', 'ask-user', 'no-op']),
  severity: z.enum(['error', 'warning', 'info']), description: Text,
  file: Text.optional(), line: z.number().int().positive().optional(),
})
const CandidateFinding = z.strictObject({ key: Hash, finding: FindingSchema })
const ResultBody = z.strictObject({
  version: z.literal(1), caseId: Hash, configId: Hash, config: ReviewerConfig,
  coordinator: Hash, startedAt: Text, latencyMs: z.number().nonnegative(),
  usage: z.null(), usageReason: Text, findings: z.array(CandidateFinding), summary: Text,
})
const Result = ResultBody.extend({ id: Hash })
export type ReplayResult = z.infer<typeof Result>
const Issue = z.strictObject({ id: Text, description: Text, source: Source })
const Judgment = z.strictObject({ key: Hash, issue: Text.nullable(), source: Source })
const Gold = z.strictObject({
  version: z.literal(1), caseId: Hash, issues: z.array(Issue), judgments: z.array(Judgment),
  coverage: z.enum(['incomplete', 'complete']), coverageSource: Source.optional(),
})
export type GoldLabels = z.infer<typeof Gold>

export function identity(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
function bytesHash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}
function json(file: string): unknown { return JSON.parse(readFileSync(file, 'utf8')) }
function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${canonicalJson(value)}\n`, { flag: 'wx', mode: 0o600 })
}
// ponytail: serial local Git blocks during capture; use async operations if large corpora need responsive progress/cancellation.
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...cleanGitEnvironment(), GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd()
}
function commit(repo: string, ref: string): string {
  return Oid.parse(git(repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`))
}
function caseDir(corpus: string, id: string): string { return path.join(corpus, 'cases', Hash.parse(id)) }

// ponytail: one short-lived writer lock per corpus; explicit retry after a concurrent writer finishes.
function locked<T>(corpus: string, work: () => T): T {
  mkdirSync(corpus, { recursive: true, mode: 0o700 })
  const lock = path.join(corpus, '.writer')
  mkdirSync(lock)
  try { return work() } finally { rmSync(lock, { recursive: true }) }
}

export function coordinatorIdentity(): string {
  return identity(['orca-no-mistakes.ts', 'review-evaluation.ts', 'adapters.ts', 'config.ts'].map(name =>
    [name, bytesHash(fileURLToPath(new URL(name, import.meta.url)))]))
}

export function loadCase(corpus: string, id: string): ReviewCase {
  const dir = caseDir(corpus, id)
  let value: ReviewCase
  let bundleHash: string
  try {
    value = Case.parse(json(path.join(dir, 'case.json')))
    bundleHash = bytesHash(path.join(dir, 'repository.bundle'))
  }
  catch (cause) {
    throw new Error('Incomplete historical review inputs: need a captured case.json, frozen prompt and repository.bundle; current policy will not be substituted', { cause })
  }
  if (value.id !== id || identity(value.inputs) !== id) throw new Error('Review case input identity mismatch')
  if (bundleHash !== value.bundleHash) throw new Error('Review case bundle identity mismatch')
  return value
}

export function selectCases(corpus: string, requested?: string[]): string[] {
  const dir = path.join(corpus, 'cases')
  const ids = requested ?? (existsSync(dir) ? readdirSync(dir).filter(name => Hash.safeParse(name).success) : [])
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error('Select at least one case, with no duplicate IDs')
  for (const id of ids) loadCase(corpus, id)
  return [...ids].sort()
}

export type CaptureOptions = {
  repo: string; corpus: string; base: string; candidate: string; intent: string;
  source: z.infer<typeof Source>; decisionHistory?: string; branch?: string;
}

export function captureCase(options: CaptureOptions): ReviewCase {
  const source = Source.parse(options.source)
  const base = commit(options.repo, options.base)
  const candidate = commit(options.repo, options.candidate)
  if (git(options.repo, 'rev-parse', '--is-shallow-repository') !== 'false') throw new Error('Cannot capture incomplete shallow history; unshallow first')
  const tree = `${git(options.repo, 'ls-tree', '-r', base)}\n${git(options.repo, 'ls-tree', '-r', candidate)}`
  if (/^160000 /m.test(tree)) throw new Error('Cannot capture submodule contents in a Git-only case')
  let lfs = ''
  try { lfs = git(options.repo, 'grep', '-I', '-l', '-z', '-F', '-e', 'version https://git-lfs.github.com/spec/v1', base, candidate, '--') }
  catch (error) { if ((error as { status?: number }).status !== 1) throw error }
  if (lfs.split('\0').filter(Boolean).some(file => git(options.repo, 'show', file).startsWith('version https://git-lfs.github.com/spec/v1\n'))) {
    throw new Error('Cannot capture external Git LFS objects in a Git-only case')
  }
  const diff = git(options.repo, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', `${base}...${candidate}`)
  let agents: string | undefined
  if (git(options.repo, 'ls-tree', candidate, '--', 'AGENTS.md')) agents = git(options.repo, 'show', `${candidate}:AGENTS.md`)
  const branch = options.branch ?? 'captured-change'
  const decisionHistory = options.decisionHistory ?? ''
  const inputs = Inputs.parse({
    version: 1, base, candidate, branch, intent: options.intent, decisionHistory,
    coordinator: coordinatorIdentity(),
    prompt: checkerPrompt('review', options.intent,
      { root: '.', branch, base, baseOid: base, head: candidate }, '', 'acp', {
        headOid: candidate, branchAgentsMd: agents?.trim() ? agents : undefined,
        branchDiff: diff.length > 200_000 ? `${diff.slice(0, 200_000)}\n[branch diff truncated by the no-mistakes coordinator]` : diff || undefined,
      }, decisionHistory),
  })
  const id = identity(inputs)
  return locked(options.corpus, () => {
    const destination = caseDir(options.corpus, id)
    if (existsSync(destination)) {
      const existing = loadCase(options.corpus, id)
      retainSource(destination, source)
      return existing
    }
    const staging = mkdtempSync(path.join(options.corpus, '.capture-'))
    const refs = `refs/orca-review-capture/${randomUUID()}`
    try {
      git(options.repo, 'update-ref', `${refs}/base`, base)
      git(options.repo, 'update-ref', `${refs}/candidate`, candidate)
      const bundle = path.join(staging, 'repository.bundle')
      git(options.repo, 'bundle', 'create', bundle, `${refs}/base`, `${refs}/candidate`)
      git(options.repo, 'bundle', 'verify', bundle)
      const value = Case.parse({ id, inputs, bundleHash: bytesHash(bundle), source })
      writeJson(path.join(staging, 'case.json'), value)
      retainSource(staging, source)
      mkdirSync(path.dirname(destination), { recursive: true })
      renameSync(staging, destination)
      return value
    } finally {
      git(options.repo, 'update-ref', '-d', `${refs}/base`)
      git(options.repo, 'update-ref', '-d', `${refs}/candidate`)
      rmSync(staging, { recursive: true, force: true })
    }
  })
}

function retainSource(dir: string, source: z.infer<typeof Source>): void {
  mkdirSync(path.join(dir, 'sources'), { recursive: true })
  const file = path.join(dir, 'sources', `${identity(source)}.json`)
  if (!existsSync(file)) writeJson(file, source)
}

export function importCase(sourceCorpus: string, corpus: string, id: string): ReviewCase {
  const value = loadCase(sourceCorpus, id)
  const sourcesDir = path.join(caseDir(sourceCorpus, id), 'sources')
  const sources = [value.source, ...(existsSync(sourcesDir) ? readdirSync(sourcesDir).map(file => Source.parse(json(path.join(sourcesDir, file)))) : [])]
  return locked(corpus, () => {
    if (existsSync(caseDir(corpus, id))) {
      const existing = loadCase(corpus, id)
      for (const source of sources) retainSource(caseDir(corpus, id), source)
      return existing
    }
    const staging = mkdtempSync(path.join(corpus, '.import-'))
    try {
      writeJson(path.join(staging, 'case.json'), value)
      cpSync(path.join(caseDir(sourceCorpus, id), 'repository.bundle'), path.join(staging, 'repository.bundle'))
      for (const source of sources) retainSource(staging, source)
      if (bytesHash(path.join(staging, 'repository.bundle')) !== value.bundleHash) throw new Error('Capture changed during import')
      mkdirSync(path.join(corpus, 'cases'), { recursive: true })
      renameSync(staging, caseDir(corpus, id))
      return value
    } finally { rmSync(staging, { recursive: true, force: true }) }
  })
}

export function pruneCase(corpus: string, id: string): void {
  locked(corpus, () => {
    const dir = caseDir(corpus, id)
    if (!existsSync(dir)) throw new Error('No such review case in this corpus')
    // Every case owns a self-contained bundle; no shared object or source ref is deleted.
    rmSync(dir, { recursive: true })
  })
}

export function bestEffortCapture(work: () => unknown, warn: (message: string) => void = console.error): void {
  try { work() } catch (error) { warn(`Review corpus capture failed (pipeline outcome unchanged): ${String(error)}`) }
}

export function completeAutomaticCapture(sourceCorpus: string, corpus: string): void {
  bestEffortCapture(() => {
    const dir = path.join(sourceCorpus, 'cases')
    if (!existsSync(dir)) return
    const ids = readdirSync(dir).filter(name => Hash.safeParse(name).success).sort()
    for (const id of ids) bestEffortCapture(() => importCase(sourceCorpus, corpus, id))
  })
}

export function findingKey(finding: Finding): string { return identity(FindingSchema.parse(finding)) }

export async function replayCase(corpus: string, id: string, configInput: unknown, acpxCommand?: string): Promise<ReplayResult> {
  const config = ReviewerConfig.parse(configInput)
  const value = loadCase(corpus, id)
  const temp = mkdtempSync(path.join(tmpdir(), 'orca-review-'))
  const repo = path.join(temp, 'repo')
  let worker: Awaited<ReturnType<CliOrca['startWorker']>> | undefined
  let orca: CliOrca | undefined
  try {
    // Independent object database, not a linked worktree or clone with alternates.
    git(temp, 'init', `--object-format=${value.inputs.candidate.length === 64 ? 'sha256' : 'sha1'}`, repo)
    git(repo, 'fetch', '--no-tags', path.join(caseDir(corpus, id), 'repository.bundle'), '+refs/orca-review-capture/*:refs/review-inputs/*')
    git(repo, 'checkout', '--detach', value.inputs.candidate)
    if (commit(repo, value.inputs.base) !== value.inputs.base) throw new Error('Captured base object is unavailable')
    orca = new CliOrca({ cwd: repo, acpxCommand, acpxEnvironment: cleanGitEnvironment() })
    const startedAt = new Date().toISOString()
    const started = performance.now()
    worker = await orca.startWorker(`review-evaluation-${randomUUID()}`, {
      name: 'review-evaluation', role: 'reviewer', stage: 'review', worktree: 'current',
      commitOid: value.inputs.candidate, prompt: value.inputs.prompt,
      agent: { harness: config.harness, model: config.model, timeoutMs: config.timeout_ms },
    })
    if (worker.failedOutcome) throw new Error('Review replay failed: the reviewer reported a failed outcome')
    const report = await validateReport(worker.report, 'review', temp)
    if (commit(repo, 'HEAD') !== value.inputs.candidate || git(repo, 'status', '--porcelain') || git(repo, 'remote')) {
      throw new Error('Review-only isolation violated: reviewer changed checkout or remotes')
    }
    const body = ResultBody.parse({
      version: 1, caseId: id, configId: identity(config), config, coordinator: coordinatorIdentity(),
      startedAt, latencyMs: performance.now() - started,
      usage: null, usageReason: 'Existing ACP quiet transport exposes no token/usage receipt; unavailable, not zero.',
      findings: report.findings.map(finding => ({ key: findingKey(finding), finding })), summary: report.summary,
    })
    const result = Result.parse({ ...body, id: identity(body) })
    locked(corpus, () => {
      loadCase(corpus, id)
      const dir = path.join(caseDir(corpus, id), 'results')
      mkdirSync(dir, { recursive: true })
      writeJson(path.join(dir, `${result.id}.json`), result)
    })
    return result
  } finally {
    try { if (worker && orca) await orca.finishWorker(worker, 'release') }
    finally { rmSync(temp, { recursive: true, force: true }) }
  }
}

export function loadResult(corpus: string, caseId: string, resultId: string): ReplayResult {
  const result = Result.parse(json(path.join(caseDir(corpus, caseId), 'results', `${Hash.parse(resultId)}.json`)))
  const { id, ...body } = result
  if (id !== resultId || result.caseId !== caseId || identity(body) !== id || identity(result.config) !== result.configId ||
      result.findings.some(item => findingKey(item.finding) !== item.key)) throw new Error('Replay result identity mismatch')
  return result
}

export function loadGold(corpus: string, caseId: string): GoldLabels {
  const file = path.join(caseDir(corpus, caseId), 'gold.json')
  const gold = Gold.parse(existsSync(file) ? json(file) : { version: 1, caseId, issues: [], judgments: [], coverage: 'incomplete' })
  if (gold.caseId !== caseId || new Set(gold.issues.map(i => i.id)).size !== gold.issues.length ||
      new Set(gold.judgments.map(j => j.key)).size !== gold.judgments.length ||
      gold.judgments.some(j => j.issue !== null && !gold.issues.some(i => i.id === j.issue)) ||
      (gold.coverage === 'complete' && !gold.coverageSource)) throw new Error('Invalid gold references or coverage provenance')
  return gold
}

export function adjudicate(corpus: string, caseId: string, input: {
  source: z.infer<typeof Source>; issue?: { id: string; description: string };
  resultId?: string; findingIndex?: number; reject?: boolean; complete?: boolean;
}): GoldLabels {
  const source = Source.parse(input.source)
  if (!input.issue && !input.reject && !input.complete) throw new Error('Choose issue, reject or complete')
  if (Number(Boolean(input.issue)) + Number(Boolean(input.reject)) + Number(Boolean(input.complete)) !== 1) throw new Error('Choose exactly one judgment')
  return locked(corpus, () => {
    loadCase(corpus, caseId)
    const gold = loadGold(corpus, caseId)
    if (input.issue) {
      const issue = Issue.parse({ ...input.issue, source })
      const existing = gold.issues.find(i => i.id === issue.id)
      if (existing && existing.description !== issue.description) throw new Error('Issue ID already has another definition')
      if (!existing) gold.issues.push(issue)
    }
    if (input.resultId !== undefined || input.findingIndex !== undefined || input.reject) {
      if (!input.resultId || input.findingIndex === undefined || !Number.isInteger(input.findingIndex) || input.findingIndex < 0 || input.complete) throw new Error('Judgment needs a result and zero-based finding index')
      const result = loadResult(corpus, caseId, input.resultId)
      const item = result.findings[input.findingIndex]
      if (!item) throw new Error('Finding index is outside the result')
      const judgment = Judgment.parse({ key: item.key, issue: input.issue?.id ?? null, source })
      gold.judgments = gold.judgments.filter(j => j.key !== judgment.key)
      gold.judgments.push(judgment)
    }
    if (input.complete) { gold.coverage = 'complete'; gold.coverageSource = source }
    if (identity(gold) === identity(loadGold(corpus, caseId))) return gold
    const dir = caseDir(corpus, caseId)
    // Keep each human label revision as provenance; the pointer is replaced atomically.
    const revisions = path.join(dir, 'labels')
    mkdirSync(revisions, { recursive: true })
    const revision = `${Date.now()}-${randomUUID()}.json`
    writeJson(path.join(revisions, revision), gold)
    const temporary = path.join(dir, `.gold-${randomUUID()}.json`)
    writeJson(temporary, gold)
    renameSync(temporary, path.join(dir, 'gold.json'))
    return gold
  })
}

export function score(result: ReplayResult, gold: GoldLabels) {
  if (result.caseId !== gold.caseId) throw new Error('Cannot score labels from another case')
  const matched = new Set<string>()
  let accepted = 0, rejected = 0, pending = 0
  const findings = result.findings.map((item, index) => {
    const judgment = gold.judgments.find(j => j.key === item.key)
    if (!judgment) { pending++; return { index, key: item.key, status: 'pending human judgment' } }
    if (judgment.issue === null) { rejected++; return { index, key: item.key, status: 'human rejected' } }
    accepted++; matched.add(judgment.issue)
    return { index, key: item.key, status: 'confirmed issue', issue: judgment.issue }
  })
  return {
    knownIssues: gold.issues.length, matchedIssues: matched.size, accepted, rejected, pending,
    knownIssueRecall: gold.issues.length ? matched.size / gold.issues.length : null,
    judgedFindingPrecision: accepted + rejected ? accepted / (accepted + rejected) : null,
    coverage: gold.coverage, goldId: identity(gold), findings,
  }
}

export function compare(corpus: string, selections: { caseId: string; resultId: string }[]): string {
  if (!selections.length) throw new Error('Comparison needs explicit result selections')
  const groups = new Map<string, { result: ReplayResult; score: ReturnType<typeof score> }[]>()
  const labels = new Map<string, GoldLabels>()
  for (const selection of selections) {
    loadCase(corpus, selection.caseId)
    const result = loadResult(corpus, selection.caseId, selection.resultId)
    const rows = groups.get(result.configId) ?? []
    if (rows.some(row => row.result.caseId === result.caseId)) throw new Error('Choose exactly one result per case/config')
    if (!labels.has(selection.caseId)) labels.set(selection.caseId, loadGold(corpus, selection.caseId))
    rows.push({ result, score: score(result, labels.get(selection.caseId)!) })
    groups.set(result.configId, rows)
  }
  const sets = [...groups.values()].map(rows => rows.map(row => row.result.caseId).sort().join(','))
  if (sets.some(set => set !== sets[0])) throw new Error('Configurations must use the same fixed case set')
  const lines = ['Review comparison', 'Matching: exact finding-content SHA-256 explicitly mapped by a human to a case-local issue.',
    'Recall = unique matched / known confirmed issues; precision = accepted / (accepted + human rejected) findings.',
    'Unmatched findings are pending human judgment, never automatic false positives. Null denominators are n/a.',
    'Coverage may be incomplete, including cases with no known issues. Usage: unavailable via ACP quiet transport.']
  for (const [configId, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const config = rows[0].result.config
    lines.push(`\n${config.harness} model=${config.model} config=${configId} environment=${config.environment}`)
    for (const { result, score: s } of rows.sort((a, b) => a.result.caseId.localeCompare(b.result.caseId))) {
      lines.push(`  case=${result.caseId} result=${result.id} gold=${s.goldId}`,
        `  issues=${s.matchedIssues}/${s.knownIssues} accepted=${s.accepted} rejected=${s.rejected} pending=${s.pending} labels=${s.coverage} latencyMs=${result.latencyMs.toFixed(1)} usage=n/a`,
        `  knownIssueRecall=${s.knownIssueRecall ?? 'n/a'} judgedFindingPrecision=${s.judgedFindingPrecision ?? 'n/a'}`,
        ...s.findings.map(f => `    [${f.index}] ${f.status}${'issue' in f ? ` ${f.issue}` : ''}: ${result.findings[f.index].finding.description}`))
    }
  }
  return lines.join('\n')
}

const Seed = z.strictObject({ version: z.literal(1), cases: z.array(z.strictObject({
  name: Text, base: Text, candidate: Text, intent: Text, source: Source,
  issues: z.array(Issue),
})).min(1) })

export function seedCorpus(repo: string, corpus: string, manifest: unknown): { name: string; caseId: string }[] {
  return Seed.parse(manifest).cases.map(entry => {
    const value = captureCase({ repo, corpus, ...entry })
    for (const issue of entry.issues) adjudicate(corpus, value.id, { issue, source: issue.source })
    return { name: entry.name, caseId: value.id }
  })
}

export async function evaluationMain(argv: string[]): Promise<void> {
  const usage = 'Usage: orca-no-mistakes evaluation <seed|capture|list|replay|adjudicate|compare|prune> [--corpus PATH]; see docs/review-evaluation.md'
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' },
    corpus: { type: 'string', default: path.join(noMistakesHome(), 'evaluation') }, repo: { type: 'string', default: process.cwd() },
    base: { type: 'string' }, candidate: { type: 'string' }, intent: { type: 'string' },
    source: { type: 'string' }, note: { type: 'string' }, from: { type: 'string' },
    case: { type: 'string', multiple: true }, config: { type: 'string' }, result: { type: 'string' },
    finding: { type: 'string' }, issue: { type: 'string' }, description: { type: 'string' },
    reject: { type: 'boolean' }, complete: { type: 'boolean' }, selections: { type: 'string' },
    manifest: { type: 'string' },
  } })
  if (values.help) { console.log(usage); return }
  const corpus = path.resolve(values.corpus!)
  const required = (key: keyof typeof values): string => {
    const value = values[key]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--${key} is required`)
    return value
  }
  const oneCase = () => {
    if (values.case?.length !== 1) throw new Error('Exactly one --case is required')
    return values.case[0]
  }
  switch (positionals[0]) {
    case 'seed': console.log(JSON.stringify(seedCorpus(path.resolve(values.repo!), corpus, json(required('manifest'))))); break
    case 'capture': {
      const value = values.from ? importCase(path.resolve(values.from), corpus, oneCase()) : captureCase({
        repo: path.resolve(values.repo!), corpus, base: required('base'), candidate: required('candidate'),
        intent: readFileSync(required('intent'), 'utf8'), source: { reference: required('source'), note: required('note') },
      })
      console.log(value.id); break
    }
    case 'list': console.log(selectCases(corpus, values.case).join('\n')); break
    case 'replay': {
      const config = ReviewerConfig.parse(json(required('config')))
      const ids = selectCases(corpus, values.case)
      console.error('Selected model provider may receive repository code. Local corpus storage is not offline model execution.')
      for (const id of ids) console.log(JSON.stringify(await replayCase(corpus, id, config)))
      break
    }
    case 'adjudicate': {
      console.log(JSON.stringify(adjudicate(corpus, oneCase(), {
        source: { reference: required('source'), note: required('note') },
        ...(values.issue ? { issue: { id: values.issue, description: required('description') } } : {}),
        resultId: values.result, findingIndex: values.finding === undefined ? undefined : Number(values.finding),
        reject: values.reject, complete: values.complete,
      }))); break
    }
    case 'compare': console.log(compare(corpus, z.array(z.strictObject({ caseId: Hash, resultId: Hash })).parse(json(required('selections'))))); break
    case 'prune': pruneCase(corpus, oneCase()); console.log('Case pruned; other case bundles retained.'); break
    default: throw new Error(usage)
  }
}
