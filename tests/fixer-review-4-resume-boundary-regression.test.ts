import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
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
  #workerOid = 1;

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

  async applyWorktreeCommits(
    _sourcePath: string,
    expectedHead: string,
    expectedSourceHead: string,
  ): Promise<boolean> {
    if (this.headOid !== expectedHead) return false;
    this.headOid = expectedSourceHead;
    return true;
  }

  async headOf(): Promise<string> {
    this.#workerOid += 1;
    return oid(this.#workerOid);
  }

  async worktreeIsReusable(): Promise<boolean> {
    return false;
  }

  async anchorRecoveryRef(): Promise<void> {}
}

class ResumeOrca implements OrcaOperations {
  readonly createdTasks: string[] = [];
  readonly launches: WorkerLaunch[] = [];
  readonly runId: string;
  interruptStage?: string;
  #task = 0;

  constructor(runId: string) {
    this.runId = runId;
  }

  async createRun(): Promise<string> {
    return this.runId;
  }

  async createTask(): Promise<string> {
    const id = `task-${++this.#task}`;
    this.createdTasks.push(id);
    return id;
  }

  async startWorker(
    taskId: string,
    launch: WorkerLaunch,
  ): Promise<WorkerResult> {
    this.launches.push(launch);
    if (launch.stage === this.interruptStage) {
      throw new Error(`${launch.stage} worker interrupted`);
    }
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

async function failedRun(runId: string) {
  const root = await mkdtemp(path.join(tmpdir(), "onm-resume-boundary-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const intent = "Reject corrupt retained evidence before resuming.";
  const git = new ResumeGit(root);
  const ledger = new DomainLedger(":memory:");
  const first = new ResumeOrca(runId);
  first.interruptStage = "review";

  try {
    await assert.rejects(
      runPipeline({ intent }, first, git, ledger),
      /review worker interrupted/,
    );
    return {
      cleanup: async () => {
        ledger.close();
        if (previousHome === undefined)
          delete process.env.ORCA_NO_MISTAKES_HOME;
        else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
        await rm(root, { force: true, recursive: true });
      },
      git,
      intent,
      ledger,
    };
  } catch (error) {
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

test("resume rejects a corrupt retained artifact before constructing its DAG", async () => {
  const fixture = await failedRun("resume-corrupt-artifact");
  try {
    const [evidence] = fixture.ledger.listEvidence("resume-corrupt-artifact");
    await writeFile(evidence.artifact_path, '{"findings":[]}');
    const resumed = new ResumeOrca("replacement-orchestration-run");

    await assert.rejects(
      runPipeline(
        {
          intent: fixture.intent,
          resumeRunId: "resume-corrupt-artifact",
        },
        resumed,
        fixture.git,
        fixture.ledger,
      ),
      /retained stage evidence verification failed:.*does not match its recorded digest/,
    );
    assert.deepEqual(resumed.createdTasks, []);
    assert.deepEqual(resumed.launches, []);
  } finally {
    await fixture.cleanup();
  }
});

test("resume rejects corrupt retained findings before constructing its DAG", async () => {
  const runId = "resume-corrupt-findings";
  const fixture = await failedRun(runId);
  try {
    const [evidence] = fixture.ledger.listEvidence(runId);
    assert.ok(evidence.artifact_sha256);
    fixture.ledger.recordEvidence({
      artifactPath: evidence.artifact_path,
      artifactSha256: evidence.artifact_sha256,
      baseCommitOid: evidence.base_commit_oid,
      baseRefSha: evidence.base_ref_sha ?? undefined,
      candidateCommitOid: evidence.candidate_commit_oid,
      effectivePolicyHash: evidence.effective_policy_hash ?? undefined,
      evidenceSha256: evidence.evidence_sha256,
      exitCode: evidence.exit_code,
      findingsJson: JSON.stringify([
        {
          action: "auto-fix",
          description: "Untrusted injected mutation.",
          id: "injected",
          severity: "error",
        },
      ]),
      roundIndex: evidence.round_index,
      runId,
      stageId: evidence.stage_id,
      summary: evidence.summary,
      workerIdentity: evidence.worker_identity,
    });
    const resumed = new ResumeOrca("replacement-orchestration-run");

    await assert.rejects(
      runPipeline(
        { intent: fixture.intent, resumeRunId: runId },
        resumed,
        fixture.git,
        fixture.ledger,
      ),
      /retained stage evidence verification failed:.*recorded findings do not match/,
    );
    assert.deepEqual(resumed.createdTasks, []);
    assert.deepEqual(resumed.launches, []);
  } finally {
    await fixture.cleanup();
  }
});
