import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  GitShell,
  runPipeline,
  type FixerChangesVerdict,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";

const oid = (value: number): string => value.toString(16).padStart(40, "0");
const pass = (summary: string): StageReport => ({ findings: [], summary });

class ResumeGit implements GitOperations {
  readonly baseOid = oid(100);
  readonly root: string;
  headOid = oid(1);

  constructor(root: string) {
    this.root = root;
  }

  async assertReady() {
    return {
      base: "main",
      baseOid: this.baseOid,
      branch: "feature",
      head: this.headOid,
      root: this.root,
    };
  }

  async assertClean(): Promise<void> {}

  async assertFixerChangesAllowed(): Promise<FixerChangesVerdict> {
    return { changed: true, guardrailViolations: [] };
  }

  async head(): Promise<string> {
    return this.headOid;
  }

  async diffBase(): Promise<string> {
    return "";
  }

  async rebase(): Promise<StageReport> {
    this.headOid = oid(2);
    return { ...pass("rebased"), rebaseUpstreamHead: this.baseOid };
  }

  async resolveRefSha(): Promise<string> {
    return this.baseOid;
  }

  async showFile(): Promise<undefined> {
    return undefined;
  }

  async pathExists(): Promise<boolean> {
    return false;
  }

  async policySha256(): Promise<string> {
    return "f".repeat(64);
  }

  async resolveBaseOid(): Promise<string> {
    return this.baseOid;
  }

  async applyWorktreeCommits(): Promise<boolean> {
    return false;
  }

  async headOf(): Promise<string> {
    return this.headOid;
  }

  async worktreeIsReusable(): Promise<boolean> {
    return false;
  }

  async anchorRecoveryRef(): Promise<void> {}
}

class ResumeOrca implements OrcaOperations {
  readonly launches: WorkerLaunch[] = [];
  readonly runId: string;
  interruptWorkers = false;
  #task = 0;

  constructor(runId: string) {
    this.runId = runId;
  }

  async createRun(): Promise<string> {
    return this.runId;
  }

  async createTask(): Promise<string> {
    return `task-${++this.#task}`;
  }

  async startWorker(
    taskId: string,
    launch: WorkerLaunch,
  ): Promise<WorkerResult> {
    this.launches.push(launch);
    if (this.interruptWorkers) throw new Error(`${launch.stage} worker interrupted`);
    return {
      dispatchId: `dispatch-${taskId}`,
      report: pass(`${launch.stage} passed`),
      taskId,
      terminalHandle: `term-${taskId}`,
    };
  }

  async finishWorker(worker: WorkerResult): Promise<void> {
    worker.shutdownConfirmed = true;
  }

  async removeWorktree(): Promise<void> {}

  async completeTask(): Promise<void> {}

  async createGate(): Promise<string> {
    throw new Error("unexpected gate");
  }

  async waitForGate(): Promise<string> {
    throw new Error("unexpected gate wait");
  }

  async setWorktreeStatus(): Promise<void> {}
}

class CrashBeforeReviewCheckpointLedger extends DomainLedger {
  #crashed = false;

  override recordCheckpoint(
    input: Parameters<DomainLedger["recordCheckpoint"]>[0],
  ): void {
    if (!this.#crashed && input.stageId === "review") {
      this.#crashed = true;
      throw new Error("crash before review checkpoint");
    }
    super.recordCheckpoint(input);
  }
}

test("resume reruns review without its durable checkpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-resume-review-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const runId = "resume-uncheckpointed-review";
  const intent = "Resume only checkpointed review output.";
  const git = new ResumeGit(root);
  const ledger = new CrashBeforeReviewCheckpointLedger(":memory:");

  try {
    await assert.rejects(
      runPipeline({ intent }, new ResumeOrca(runId), git, ledger),
      /crash before review checkpoint/,
    );
    const reviewEvidence = ledger
      .listEvidence(runId)
      .find((entry) => entry.stage_id === "review");
    const resumeCheckpoint = ledger.listCheckpoints(runId).at(-1);
    assert.ok(reviewEvidence);
    assert.equal(resumeCheckpoint?.stage_id, "rebase");
    assert.equal(
      reviewEvidence.candidate_commit_oid,
      resumeCheckpoint.output_commit_oid,
    );

    const resumed = new ResumeOrca("replacement-orchestration-run");
    resumed.interruptWorkers = true;
    await assert.rejects(
      runPipeline({ intent, resumeRunId: runId }, resumed, git, ledger),
      /review worker interrupted/,
    );
    assert.equal(resumed.launches[0]?.stage, "review");
  } finally {
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("legacy recovery anchoring cannot cross a generation fence", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-legacy-recovery-fence-"));
  const repo = path.join(temp, "repo");
  try {
    git(temp, "-c", "init.templateDir=", "init", "-b", "main", repo);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "commit.gpgsign", "false");
    await writeFile(path.join(repo, "state.txt"), "checkpoint\n");
    git(repo, "add", "state.txt");
    git(repo, "commit", "-m", "checkpoint");
    const checkpoint = git(repo, "rev-parse", "HEAD");
    await writeFile(path.join(repo, "state.txt"), "legacy tip\n");
    git(repo, "commit", "-am", "legacy tip");
    const legacyTip = git(repo, "rev-parse", "HEAD");
    const runId = "legacy-recovery-fence";
    const recoveryRef = `refs/no-mistakes/recover/${runId}`;
    git(repo, "update-ref", recoveryRef, checkpoint);
    const shell = new GitShell({ repo });
    await shell.anchorRecoveryRef(runId, checkpoint, 2);

    await shell.anchorRecoveryRef(runId, checkpoint);
    await assert.rejects(
      shell.anchorRecoveryRef(runId, legacyTip),
      /recovery generation ownership is required/,
    );
    assert.equal(git(repo, "rev-parse", recoveryRef), checkpoint);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});
