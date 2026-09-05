import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
} from "../scripts/orca-no-mistakes.ts";

const oid = (value: number): string => value.toString(16).padStart(40, "0");

class ResumeGit implements GitOperations {
  readonly baseOid = oid(100);
  readonly root: string;
  headOid = oid(1);
  rebaseCalls = 0;

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
    this.headOid = oid(++this.rebaseCalls + 1);
    return {
      findings: [],
      rebaseUpstreamHead: this.baseOid,
      summary: "rebased",
    };
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

  async startWorker(_taskId: string, launch: WorkerLaunch): Promise<never> {
    this.launches.push(launch);
    throw new Error(`${launch.stage} worker interrupted`);
  }

  async finishWorker(): Promise<void> {}

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

class CrashBeforeRebaseCheckpointLedger extends DomainLedger {
  #crashed = false;

  override recordCheckpoint(
    input: Parameters<DomainLedger["recordCheckpoint"]>[0],
  ): void {
    if (!this.#crashed && input.stageId === "rebase") {
      this.#crashed = true;
      throw new Error("crash before rebase checkpoint");
    }
    super.recordCheckpoint(input);
  }
}

test("resume reruns rebase without its durable checkpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-resume-rebase-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const runId = "resume-uncheckpointed-rebase";
  const intent = "Resume only checkpointed rebase output.";
  const checkpoint = oid(1);
  const gate = new ResumeGit(path.join(root, "gate"));
  const delivery = new ResumeGit(path.join(root, "origin"));
  const ledger = new CrashBeforeRebaseCheckpointLedger(":memory:");

  try {
    await assert.rejects(
      runPipeline(
        { deliveryGit: delivery, intent },
        new ResumeOrca(runId),
        gate,
        ledger,
      ),
      /crash before rebase checkpoint/,
    );
    const uncheckpointed = ledger
      .listEvidence(runId)
      .find((evidence) => evidence.stage_id === "rebase");
    assert.ok(uncheckpointed);
    assert.notEqual(uncheckpointed.candidate_commit_oid, checkpoint);
    assert.deepEqual(
      ledger.listCheckpoints(runId).map((entry) => entry.stage_id),
      ["intent"],
    );

    gate.headOid = checkpoint;
    const resumed = new ResumeOrca("replacement-orchestration-run");
    await assert.rejects(
      runPipeline(
        { deliveryGit: delivery, intent, resumeRunId: runId },
        resumed,
        gate,
        ledger,
      ),
      /review worker interrupted/,
    );

    assert.equal(gate.rebaseCalls, 2);
    assert.equal(resumed.launches[0]?.stage, "review");
    const rebaseCheckpoint = ledger
      .listCheckpoints(runId)
      .findLast((entry) => entry.stage_id === "rebase");
    assert.equal(rebaseCheckpoint?.output_commit_oid, gate.headOid);
    assert.notEqual(
      rebaseCheckpoint?.output_commit_oid,
      uncheckpointed.candidate_commit_oid,
    );
  } finally {
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  }
});
