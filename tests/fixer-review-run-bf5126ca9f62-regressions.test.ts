import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PIPELINE_STEPS, type StageName } from "../scripts/config.ts";
import { DomainLedger } from "../scripts/ledger.ts";
import {
  createGateWorktree,
  runPipeline,
  type FixerChangesVerdict,
  type GitOperations,
  type OrcaOperations,
  type RepoSnapshot,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";
import type { PresentationSnapshot } from "../scripts/presentation.ts";
import { RailTuiRenderer, wrap } from "../scripts/tui.ts";

class FakeInput extends EventEmitter {
  isRaw = false;
  isTTY = true;
  paused = true;

  isPaused(): boolean {
    return this.paused;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

class FakeOutput extends EventEmitter {
  columns = 100;
  isTTY = true;
  rows = 24;
  readonly writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

function cleanScreen(screen: string): string {
  return screen
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, "")
    .replace(/\r/gu, "")
    .replace(/\u0007/gu, "");
}

function nextDraw(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function baseSnapshot(stage: StageName, attempt = 1): PresentationSnapshot {
  return {
    attempt,
    currentStage: stage,
    mode: { autoFix: false },
    runId: "run-test",
    sequence: 1,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      approvedFindings: 0,
      fixedFindings: 0,
      id,
      openFindings: 0,
      retainedFixer: false,
      round: 0,
      status: id === stage ? ("active" as const) : ("pending" as const),
      totalFindings: 0,
    })),
    status: "in-progress",
    transition: { attempt, kind: "attempt-started" },
    updatedAt: new Date(0).toISOString(),
    version: 1,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function pass(stage: string): StageReport {
  return {
    findings: [],
    summary: `${stage} passed`,
  };
}

class FakeGit implements GitOperations {
  readonly calls: string[] = [];
  static #oid(counter: number): string {
    return counter.toString(16).padStart(40, "0");
  }
  #counter = 1;
  #head = FakeGit.#oid(1);
  #baseOid = FakeGit.#oid(0);
  readonly #branch: string;
  readonly #root: string;

  constructor(root = "/repo", branch = "feature") {
    this.#root = root;
    this.#branch = branch;
  }

  async assertReady(): Promise<{
    base: string;
    baseOid: string;
    branch: string;
    head: string;
    root: string;
  }> {
    this.calls.push("assert-ready");
    return {
      base: "main",
      baseOid: this.#baseOid,
      branch: this.#branch,
      head: this.#head,
      root: this.#root,
    };
  }

  async assertClean(): Promise<void> {
    this.calls.push("assert-clean");
  }

  async assertFixerChangesAllowed(): Promise<FixerChangesVerdict> {
    return { changed: true, guardrailViolations: [] };
  }

  async head(): Promise<string> {
    return this.#head;
  }

  async diffBase(base: string): Promise<string> {
    this.calls.push(`diff:${base}`);
    return "";
  }

  async headOf(): Promise<string> {
    return FakeGit.#oid(++this.#counter);
  }

  async worktreeIsReusable(): Promise<boolean> {
    return false;
  }

  async resolveRefSha(ref: string): Promise<string | undefined> {
    return `sha-${ref.replaceAll("/", "-")}`;
  }

  async showFile(): Promise<string | undefined> {
    return undefined;
  }

  async pathExists(): Promise<boolean> {
    return false;
  }

  async rebase(base: string): Promise<StageReport> {
    this.calls.push(`rebase:${base}`);
    return {
      findings: [],
      rebaseUpstreamHead: this.#baseOid,
      summary: "rebased",
    };
  }

  async policySha256(): Promise<string> {
    return "f".repeat(64);
  }

  async resolveBaseOid(): Promise<string> {
    return this.#baseOid;
  }

  async applyWorktreeCommits(): Promise<boolean> {
    return true;
  }

  async anchorRecoveryRef(): Promise<void> {}
}

class FakeOrca implements OrcaOperations {
  readonly calls: string[] = [];
  readonly tasks: {
    deps: string[];
    id: string;
    parent?: string;
    spec: string;
  }[] = [];
  readonly reports = new Map<string, StageReport[]>();
  #taskNumber = 0;
  #dispatchNumber = 0;
  readonly #runId: string;

  constructor(runId = "test-run") {
    this.#runId = runId;
  }

  async createRun(objective: string): Promise<string> {
    this.calls.push(`run:${objective}`);
    return this.#runId;
  }

  async createTask(
    spec: string,
    options: { deps?: string[]; parent?: string } = {},
  ): Promise<string> {
    const id = `task-${++this.#taskNumber}`;
    this.tasks.push({
      id,
      spec,
      deps: options.deps ?? [],
      parent: options.parent,
    });
    return id;
  }

  async startWorker(
    taskId: string,
    launch: WorkerLaunch,
  ): Promise<WorkerResult> {
    const dispatchId = `dispatch-${++this.#dispatchNumber}`;
    const stage = launch.stage;
    const reports = this.reports.get(stage) ?? [pass(stage)];
    const report = reports.shift() ?? pass(stage);
    this.reports.set(stage, reports);
    return {
      deliveryId: `delivery-${dispatchId}`,
      dispatchId,
      report,
      taskId,
      terminalHandle: `term-${dispatchId}`,
    };
  }

  async finishWorker(
    worker: WorkerResult,
    disposition: "release" | "retain",
  ): Promise<void> {
    this.calls.push(`${disposition}:${worker.dispatchId}`);
    if (disposition === "release") worker.shutdownConfirmed = true;
  }

  async removeWorktree(): Promise<void> {}

  async completeTask(taskId: string, report: StageReport): Promise<void> {
    this.calls.push(`complete:${taskId}:${report.summary}`);
  }

  #resolveResumeGate?: (resolution: string) => void;

  async createGate(_taskId?: string, _question?: string, options?: readonly string[]): Promise<string> {
    return options?.includes("resume") ? "gate-resume" : "gate-1";
  }

  async waitForGate(gateId?: string): Promise<string> {
    if (gateId === "gate-resume") {
      return await new Promise((resolve) => {
        this.#resolveResumeGate = resolve;
      });
    }
    return "approve";
  }

  async resolveGate(gateId: string, resolution: string): Promise<void> {
    if (gateId === "gate-resume") {
      this.#resolveResumeGate?.(resolution);
      return;
    }
  }

  async setWorktreeStatus(comment: string, status?: string): Promise<void> {
    this.calls.push(`status:${status ?? ""}:${comment}`);
  }
}

test("Finding 3: wrap respects width when hyphen is at boundary column", () => {
  const lines1 = wrap("abcdef-ghij", 6);
  assert.deepEqual(lines1, ["abcdef", "-ghij"]);
  for (const line of lines1) {
    assert.ok(line.length <= 6, `line '${line}' length ${line.length} exceeds width 6`);
  }

  const lines2 = wrap("abcde-fghij", 6);
  assert.deepEqual(lines2, ["abcde-", "fghij"]);
  for (const line of lines2) {
    assert.ok(line.length <= 6, `line '${line}' length ${line.length} exceeds width 6`);
  }
});

test("Finding 2: RailTuiRenderer replaces applied fixes with verified outcomes per cycle", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 100;
  output.rows = 24;
  const renderer = new RailTuiRenderer(input, output, "/unused");

  const base = baseSnapshot("review", 1);
  renderer.render({ ...base, transition: { attempt: 1, kind: "attempt-started" } });
  renderer.render({ ...base, transition: { kind: "stage-started", stage: "review" } });
  renderer.render({
    ...base,
    transition: { actionable: 2, kind: "findings-recorded", round: 0, stage: "review", total: 2 },
  });
  renderer.render({
    ...base,
    transition: { decision: "fix", gateId: "g1", kind: "gate-resolved", round: 0, stage: "review" },
  });

  renderer.render({
    ...base,
    stages: base.stages.map((s) => (s.id === "review" ? {
      ...s,
      findings: [
        { description: "first", disposition: "fixed" as const, id: "first", severity: "error" as const },
        { description: "second", disposition: "open" as const, id: "second", severity: "error" as const },
      ],
      fixedFindings: 1,
    } : s)),
    transition: {
      approvedFindings: 0,
      findingIds: ["first"],
      kind: "fix-completed",
      round: 1,
      stage: "review",
    },
  });
  // Cycle 1: analysis 2 starts after fix 1 has been recorded.
  renderer.render({
    ...base,
    stages: base.stages.map((s) => (s.id === "review" ? { ...s, fixedFindings: 0 } : s)),
    transition: { kind: "round-started", round: 1, stage: "review" },
  });
  // Cycle 1 re-analysis records one remaining finding.
  renderer.render({
    ...base,
    stages: base.stages.map((s) => (s.id === "review" ? {
      ...s,
      findings: [
        { description: "first", disposition: "fixed" as const, id: "first", severity: "error" as const },
        { description: "second", disposition: "open" as const, id: "second", severity: "error" as const },
      ],
      fixedFindings: 1,
    } : s)),
    transition: { actionable: 1, kind: "findings-recorded", round: 1, stage: "review", total: 2 },
  });

  // Cycle 2: gate resolved with fix 2.
  renderer.render({
    ...base,
    transition: { decision: "fix", gateId: "g2", kind: "gate-resolved", round: 1, stage: "review" },
  });

  renderer.render({
    ...base,
    stages: base.stages.map((s) => (s.id === "review" ? {
      ...s,
      findings: [
        { description: "first", disposition: "fixed" as const, id: "first", severity: "error" as const },
        { description: "second", disposition: "fixed" as const, id: "second", severity: "error" as const },
      ],
      fixedFindings: 2,
    } : s)),
    transition: {
      approvedFindings: 0,
      findingIds: ["second"],
      kind: "fix-completed",
      round: 2,
      stage: "review",
    },
  });

  // Each fix row reports that cycle, not the cumulative fixed total.
  await nextDraw();
  let screen = cleanScreen(output.writes.at(-1) ?? "");
  assert.match(screen, /Review fix 1\s+· 1 fixed/u);
  assert.match(screen, /Review fix 2\s+· 1 fix applied/u);

  // Analysis 3 starts only after fix 2 has been recorded.
  renderer.render({
    ...base,
    stages: base.stages.map((s) => (s.id === "review" ? {
      ...s,
      findings: [
        { description: "first", disposition: "fixed" as const, id: "first", severity: "error" as const },
        { description: "second", disposition: "fixed" as const, id: "second", severity: "error" as const },
      ],
      fixedFindings: 2,
    } : s)),
    transition: { kind: "round-started", round: 2, stage: "review" },
  });
  renderer.render({
    ...base,
    stages: base.stages.map((s) => (s.id === "review" ? {
      ...s,
      findings: [
        { description: "first", disposition: "fixed" as const, id: "first", severity: "error" as const },
        { description: "second", disposition: "fixed" as const, id: "second", severity: "error" as const },
      ],
      fixedFindings: 2,
    } : s)),
    transition: { actionable: 0, kind: "findings-recorded", round: 2, stage: "review", total: 2 },
  });

  await nextDraw();
  screen = cleanScreen(output.writes.at(-1) ?? "");
  assert.match(screen, /Review analysis 3/u);
  assert.match(screen, /Review fix 2\s+· 1 fixed/u);
  assert.doesNotMatch(screen, /Review fix \d+.*applied.*fixed/u);
  renderer.close();
});

test("Finding 1: fresh-process resume with initial auto-fix on preserves initial source and keeps TUI auto-fix disabled", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-resume-autofix-"));
  const ledgerPath = path.join(temp, "ledger.db");
  const ledger = new DomainLedger(ledgerPath);
  const runId = "test-resume-initial-autofix";
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "Test resume initial autofix",
    policySha256: "a".repeat(64),
    repoRoot: temp,
    runId,
    submissionCommitOid: "1".repeat(40),
  });
  ledger.recordAutoFixMode(runId, true, "initial");

  const latestEvent = ledger.listAutoFixModeEvents(runId).at(-1);
  assert.equal(latestEvent?.source, "initial");
  assert.equal(latestEvent?.enabled, true);

  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 100;
  output.rows = 24;
  const renderer = new RailTuiRenderer(input, output, "/unused");

  const base = baseSnapshot("review", 1);
  const resumedInitial = {
    ...base,
    mode: { autoFix: latestEvent.enabled },
    transition: {
      enabled: latestEvent.enabled,
      kind: "mode-changed" as const,
      source: latestEvent.source,
    },
  };
  renderer.render(resumedInitial);
  await nextDraw();
  const screen = cleanScreen(output.writes.at(-1) ?? "");
  assert.match(screen, /auto-fix off/iu);
  renderer.close();
  ledger.close();
  await rm(temp, { recursive: true, force: true });
});

test("Finding 4: explicit --repo honors target worktree rather than environment parent worktree", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-explicit-repo-"));
  const origin = path.join(temp, "origin.git");
  const repoA = path.join(temp, "repoA");
  const repoB = path.join(temp, "repoB");
  const fakeOrca = path.join(temp, "orca");
  const callsPath = path.join(temp, "calls.jsonl");
  const previousEnvWorktree = process.env.ORCA_WORKTREE_ID;

  try {
    git(temp, "init", "--bare", origin);
    git(temp, "clone", origin, repoA);
    git(repoA, "config", "user.email", "test@example.com");
    git(repoA, "config", "user.name", "Test User");
    git(repoA, "checkout", "-b", "main");
    await writeFile(path.join(repoA, "README.md"), "main\n");
    git(repoA, "add", "README.md");
    git(repoA, "commit", "-m", "main");
    git(repoA, "push", "-u", "origin", "main");
    git(temp, `--git-dir=${origin}`, "symbolic-ref", "HEAD", "refs/heads/main");

    // Add linked worktree B in the same repo
    git(repoA, "worktree", "add", "-b", "feature-b", repoB, "main");

    const canonicalRepoA = await realpath(repoA);
    const canonicalRepoB = await realpath(repoB);

    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const repoB = ${JSON.stringify(canonicalRepoB)}
const repoA = ${JSON.stringify(canonicalRepoA)}
let result = { accepted: true }
if (args[0] === 'worktree' && args[1] === 'show') {
  result = { worktree: { id: 'wt-a-id', path: repoA, displayName: 'Worktree A' } }
} else if (args[0] === 'worktree' && args[1] === 'current') {
  result = { worktree: { id: 'wt-b-id', path: repoB, displayName: 'Worktree B' } }
} else if (args[0] === 'worktree' && args[1] === 'create') {
  const gateName = args[args.indexOf('--name') + 1]
  result = { worktree: { id: 'gate-id', path: repoB + '-gate', branch: 'refs/heads/' + gateName } }
}
console.log(JSON.stringify({ result }))
`,
    );
    await chmod(fakeOrca, 0o755);

    process.env.ORCA_WORKTREE_ID = "wt-a-id";

    const repoSnapshotB: RepoSnapshot = {
      base: "main",
      baseOid: git(repoB, "rev-parse", "main"),
      branch: "feature-b",
      head: git(repoB, "rev-parse", "HEAD"),
      root: canonicalRepoB,
    };

    const gate = await createGateWorktree(repoSnapshotB, fakeOrca);
    assert.equal(gate.kind, "orca");

    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const worktreeCreate = calls.find(
      (args) => args[0] === "worktree" && args[1] === "create",
    );
    assert.ok(worktreeCreate, "worktree create was called");
    const parentWorktree =
      worktreeCreate[worktreeCreate.indexOf("--parent-worktree") + 1];
    assert.notEqual(
      parentWorktree,
      "id:wt-a-id",
      "parent worktree selector must not use wt-a-id from environment when target repo is repoB",
    );
    assert.ok(
      parentWorktree === "id:wt-b-id" || parentWorktree === `path:${canonicalRepoB}`,
      `parent worktree selector must identify repoB, got: ${parentWorktree}`,
    );
  } finally {
    if (previousEnvWorktree === undefined) delete process.env.ORCA_WORKTREE_ID;
    else process.env.ORCA_WORKTREE_ID = previousEnvWorktree;
    await rm(temp, { recursive: true, force: true });
  }
});

test("Finding 5: stopped notification retries through temporary dual transport outage", async () => {
  let statusAttempts = 0;
  let notifyAttempts = 0;
  let resumeTriggered = false;

  const gitOps = new FakeGit();
  class CrashingReviewerOrca extends FakeOrca {
    notified: { outcome: string; summary: string }[] = [];
    attempts = 0;

    override async startWorker(
      taskId: string,
      launch: WorkerLaunch,
    ): Promise<WorkerResult> {
      const worker = await super.startWorker(taskId, launch);
      if (launch.role === "reviewer") {
        this.attempts += 1;
        if (this.attempts === 1) {
          worker.failedOutcome = true;
        }
      }
      return worker;
    }

    override async setWorktreeStatus(comment: string, status?: string): Promise<void> {
      if (status === "stopped") {
        statusAttempts++;
        if (statusAttempts < 3) {
          throw new Error("temporary worktree status outage");
        }
      }
      await super.setWorktreeStatus(comment, status);
    }

    async notifyRunResult(outcome: string, summary: string): Promise<void> {
      if (outcome === "stopped") {
        notifyAttempts++;
        if (notifyAttempts < 3) {
          throw new Error("temporary notification outage");
        }
        this.notified.push({ outcome, summary });
      }
    }
  }

  const orca = new CrashingReviewerOrca("stopped-retry-run");
  orca.reports.set("review", [
    {
      findings: [
        {
          action: "auto-fix",
          description: "Crash finding",
          id: "crash-finding",
          severity: "error",
        },
      ],
      summary: "one finding",
    },
    pass("clean review"),
  ]);

  await runPipeline(
    {
      intent: "Test stopped notification retry",
      rendererFactory: (
        _artifactsDir,
        _stageLogs,
        _resolveGate,
        _setAutoFix,
        requestResume,
        onResumeAvailable,
      ) => {
        onResumeAvailable?.();
        setTimeout(() => {
          if (!resumeTriggered) {
            resumeTriggered = true;
            requestResume?.();
          }
        }, 1200);
        return {
          close() {},
          render() {},
        };
      },
    },
    orca,
    gitOps,
  );

  assert.ok(notifyAttempts >= 3, `notifyRunResult should retry through outage, got ${notifyAttempts}`);
  assert.equal(orca.notified[0]?.outcome, "stopped");
  assert.equal(resumeTriggered, true, "resume was triggered");
});
