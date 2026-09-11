import assert from "node:assert/strict";
import { withLivePass } from './live-validation-fixture.ts';
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  installAbortReaping,
  runPipeline,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";
import type { PresentationSnapshot } from "../scripts/presentation.ts";

const head = "1".repeat(40);
const base = "0".repeat(40);

const autoFixableFinding: StageReport = {
  findings: [
    {
      action: "auto-fix",
      description: "Repair the pipeline automatically.",
      id: "test-autofix",
      severity: "error",
    },
  ],
  summary: "auto-fix finding recorded",
};

const approvalFinding: StageReport = {
  findings: [
    {
      action: "ask-user",
      description: "Needs a durable approval",
      id: "review-approval",
      severity: "error",
    },
  ],
  summary: "approval required",
};

class FailAfterOpenGateLedger extends DomainLedger {
  #failOpenGate = true;

  override openGateAudit(
    input: Parameters<DomainLedger["openGateAudit"]>[0],
  ): void {
    super.openGateAudit(input);
    if (this.#failOpenGate) {
      this.#failOpenGate = false;
      throw new Error("stop after open gate audit");
    }
  }
}

class LegacyPresentationLedger extends DomainLedger {
  legacyPresentation = true;

  override recordPresentationSnapshot(
    runId: string,
    eventKey: string,
    snapshot: PresentationSnapshot,
  ): boolean {
    if (!this.legacyPresentation) {
      return super.recordPresentationSnapshot(runId, eventKey, snapshot);
    }
    const priorStages = new Map(
      (this.listPresentationSnapshots(runId).at(-1)?.stages ?? []).map(
        (stage) => [stage.id, stage],
      ),
    );
    const transition = snapshot.transition;
    return super.recordPresentationSnapshot(runId, eventKey, {
      ...snapshot,
      stages: snapshot.stages.map((stage) => {
        const prior = priorStages.get(stage.id);
        if (
          transition.kind === "findings-recorded" &&
          transition.stage === stage.id
        ) {
          return {
            actionableFindings: transition.actionable,
            id: stage.id,
            round: transition.round,
            status: transition.actionable > 0 ? "blocked" : "active",
            totalFindings: transition.total,
          };
        }
        return {
          actionableFindings: prior?.actionableFindings ?? 0,
          id: stage.id,
          round: stage.round,
          status: stage.status,
          totalFindings: prior?.totalFindings ?? 0,
        };
      }),
    });
  }
}

type OrcaHarness = {
  operations: OrcaOperations;
  gateCount: () => number;
  fixerLaunches: () => WorkerLaunch[];
};

const makeOrca = (
  runId: string,
  reports: Record<string, StageReport | Error>,
  gateNamespace: string,
): OrcaHarness => {
  let dispatch = 0;
  let gates = 0;
  const launches: WorkerLaunch[] = [];
  const operations: OrcaOperations = {
    async createRun() {
      return runId;
    },
    async createTask() {
      return `task-${++dispatch}`;
    },
    async startWorker(
      taskId: string,
      launch: WorkerLaunch,
    ): Promise<WorkerResult> {
      launches.push(launch);
      const report = reports[launch.stage];
      if (report instanceof Error) throw report;
      return {
        dispatchId: `dispatch-${launches.length}`,
        report: withLivePass(launch, structuredClone(report ?? { findings: [], summary: "passed" })),
        taskId,
        terminalHandle: `term-${launches.length}`,
      };
    },
    async finishWorker(worker) {
      worker.shutdownConfirmed = true;
    },
    async removeWorktree() {},
    async completeTask() {},
    async createGate() {
      gates += 1;
      return `${gateNamespace}-gate-${gates}`;
    },
    async waitForGate() {
      return "approve";
    },
    async setWorktreeStatus() {},
  };
  return {
    operations,
    gateCount: () => gates,
    fixerLaunches: () => launches.filter((launch) => launch.role === "fixer"),
  };
};

const makeGit = (root: string): GitOperations => ({
  async assertReady() {
    return {
      base: "main",
      baseOid: base,
      branch: "feature",
      head,
      root,
    };
  },
  async assertClean() {},
  async assertFixerChangesAllowed() {
    return { changed: false, guardrailViolations: [] };
  },
  async head() {
    return head;
  },
  async diffBase() {
    return "";
  },
  async rebase() {
    return { findings: [], rebaseUpstreamHead: base, summary: "rebased" };
  },
  async resolveRefSha() {
    return base;
  },
  async showFile() {
    return undefined;
  },
  async pathExists() {
    return false;
  },
  async policySha256() {
    return "f".repeat(64);
  },
  async resolveBaseOid() {
    return base;
  },
  async applyWorktreeCommits() {
    return false;
  },
  async headOf() {
    return head;
  },
  async worktreeIsReusable() {
    return false;
  },
  async anchorRecoveryRef() {},
});

const stageOf = (snapshot: PresentationSnapshot, id: string) =>
  snapshot.stages.find((stage) => stage.id === id)!;

test("resume restores finding-time auto-fix mode for unresolved recorded findings", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-resume-mode-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = temp;
  const ledger = new FailAfterOpenGateLedger(":memory:");

  try {
    let setAutoFix: ((enabled: boolean) => void) | undefined;
    let toggledOff = false;
    const first = makeOrca(
      "mode-run",
      { test: autoFixableFinding },
      "attempt1",
    );
    await assert.rejects(
      runPipeline(
        {
          intent: "Resume keeps finding-time auto-fix mode.",
          rendererFactory: (_artifactsDir, _stageLogs, _resolveGate, toggle) => {
            setAutoFix = toggle;
            return {
              render() {
                if (toggledOff) return;
                toggledOff = true;
                setAutoFix?.(false);
              },
            };
          },
        },
        first.operations,
        makeGit(temp),
        ledger,
      ),
      /stop after open gate audit/,
    );
    assert.equal(ledger.runStatus("mode-run"), "failed");
    const recordedModeOff = ledger
      .listPresentationSnapshots("mode-run")
      .some(
        (snapshot) =>
          snapshot.transition.kind === "findings-recorded" &&
          snapshot.transition.stage === "test" &&
          !snapshot.mode.autoFix,
      );
    assert.ok(recordedModeOff);
    assert.equal(ledger.latestAutoFixMode("mode-run"), false);

    await installAbortReaping({ pid: process.pid });
    let toggledOn = false;
    const resumed = makeOrca(
      "orchestration-resume",
      {
        test: autoFixableFinding,
      },
      "attempt2",
    );
    const result = await runPipeline(
      {
        intent: "Resume keeps finding-time auto-fix mode.",
        resumeRunId: "mode-run",
        rendererFactory: (_artifactsDir, _stageLogs, _resolveGate, toggle) => ({
          render() {
            if (toggledOn) return;
            toggledOn = true;
            toggle?.(true);
          },
        }),
      },
      resumed.operations,
      makeGit(temp),
      ledger,
    );

    assert.ok(ledger.latestAutoFixMode("mode-run"));

    assert.ok(result.attestation);
    assert.equal(resumed.fixerLaunches().length, 0);
    assert.equal(resumed.gateCount(), 1);
    const finalSnapshot = ledger
      .listPresentationSnapshots("mode-run")
      .at(-1)!;
    const testStage = stageOf(finalSnapshot, "test");
    assert.equal(testStage.status, "passed");
    assert.equal(testStage.approvedFindings, 1);
    assert.equal(testStage.openFindings, 0);
    assert.equal(testStage.findings?.[0]?.disposition, "approved");
  } finally {
    await installAbortReaping({ pid: process.pid });
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});

test("resume normalizes approved legacy stages without per-finding detail", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-legacy-approved-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = temp;
  const ledger = new LegacyPresentationLedger(":memory:");

  try {
    const first = makeOrca(
      "legacy-run",
      {
        review: approvalFinding,
        test: new Error("test worker interrupted"),
      },
      "attempt1",
    );
    await assert.rejects(
      runPipeline(
        { intent: "Resume normalizes legacy approved stages." },
        first.operations,
        makeGit(temp),
        ledger,
      ),
      /test worker interrupted/,
    );
    assert.equal(ledger.runStatus("legacy-run"), "failed");
    const legacySnapshot = ledger
      .listPresentationSnapshots("legacy-run")
      .at(-1)!;
    const legacyReview = stageOf(legacySnapshot, "review");
    assert.equal(legacyReview.status, "passed");
    assert.equal(legacyReview.actionableFindings, 1);
    assert.equal(legacyReview.findings, undefined);

    ledger.legacyPresentation = false;
    await installAbortReaping({ pid: process.pid });
    const resumed = makeOrca("orchestration-resume", {}, "attempt2");
    const result = await runPipeline(
      { intent: "Resume normalizes legacy approved stages.", resumeRunId: "legacy-run" },
      resumed.operations,
      makeGit(temp),
      ledger,
    );

    assert.ok(result.attestation);
    assert.equal(resumed.gateCount(), 0);
    const finalSnapshot = ledger
      .listPresentationSnapshots("legacy-run")
      .at(-1)!;
    assert.equal(finalSnapshot.status, "passed");
    const review = stageOf(finalSnapshot, "review");
    assert.equal(review.status, "passed");
    assert.equal(review.actionableFindings, 0);
    assert.equal(review.approvedFindings, 1);
    assert.equal(review.openFindings, 0);
    assert.equal(review.findings?.[0]?.disposition, "approved");
  } finally {
    await installAbortReaping({ pid: process.pid });
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});
