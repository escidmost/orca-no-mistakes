import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type GithubAuthority,
  type GithubIssueCommentObservation,
  type GithubPullRequestObservation,
} from "../scripts/github.ts";
import {
  DomainLedger,
  installAbortReaping,
  runPipeline,
  type Finding,
  type FixerChangesVerdict,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";

const oid = (value: number): string => value.toString(16).padStart(40, "0");
const pass = (summary: string): StageReport => ({ findings: [], summary });
const AUTO_FIX_CONFIG =
  "auto_fix:\n  allow_review_autofix: true\n  guardrails: strict\n";

class TestGit implements GitOperations {
  readonly baseOid = oid(100);
  headOid: string;
  readonly root: string;
  readonly trustedConfig: string;
  workerHead: string;

  constructor(root: string, headOid: string, trustedConfig: string) {
    this.root = root;
    this.headOid = headOid;
    this.trustedConfig = trustedConfig;
    this.workerHead = headOid;
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

  async showFile(): Promise<string | undefined> {
    return this.trustedConfig || undefined;
  }

  async pathExists(): Promise<boolean> {
    return this.trustedConfig.length > 0;
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
    this.workerHead = expectedSourceHead;
    return true;
  }

  async headOf(): Promise<string> {
    return this.workerHead;
  }

  async worktreeIsReusable(): Promise<boolean> {
    return false;
  }

  async anchorRecoveryRef(): Promise<void> {}
}

class TestOrca implements OrcaOperations {
  readonly runId: string;
  readonly launches: WorkerLaunch[] = [];
  readonly dispatches: string[] = [];
  readonly gates: Array<{ gateId: string; question: string; options?: string[] }> = [];
  reviewerReports: StageReport[] = [];
  gateDecision = "approve";
  #task = 0;
  #dispatch = 0;
  #gate = 0;
  onWorkerLaunch?: (launch: WorkerLaunch) => void;
  onCompleteTask?: (taskId: string, report: StageReport) => Promise<void>;

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
    this.onWorkerLaunch?.(launch);
    const dispatchId = `dispatch-${++this.#dispatch}`;
    this.dispatches.push(dispatchId);
    const report =
      launch.role === "reviewer" && this.reviewerReports.length > 0
        ? this.reviewerReports.shift()!
        : pass(`${launch.stage} ${launch.role} passed`);
    return {
      dispatchId,
      report,
      taskId,
      terminalHandle: `term-${dispatchId}`,
      worktreeId: launch.worktree === "new-child" ? dispatchId : undefined,
      worktreePath:
        launch.worktree === "new-child"
          ? path.join(this.runId, dispatchId)
          : undefined,
    };
  }

  async finishWorker(worker: WorkerResult): Promise<void> {
    worker.shutdownConfirmed = true;
  }

  async removeWorktree(): Promise<void> {}

  async completeTask(taskId: string, report: StageReport): Promise<void> {
    if (this.onCompleteTask) {
      await this.onCompleteTask(taskId, report);
    }
  }

  async createGate(
    _taskId: string,
    question: string,
    options?: string[],
    onCreated?: (gateId: string) => void,
  ): Promise<string> {
    const gateId = `${this.runId}-gate-${++this.#gate}`;
    this.gates.push({ gateId, question, options });
    onCreated?.(gateId);
    return gateId;
  }

  async waitForGate(): Promise<string> {
    return this.gateDecision;
  }

  async setWorktreeStatus(): Promise<void> {}
}

class FaultSettlementLedger extends DomainLedger {
  failReviewSettlement = false;

  override settleLocalStage(
    input: Parameters<DomainLedger["settleLocalStage"]>[0],
    presentation?: Parameters<DomainLedger["settleLocalStage"]>[1],
  ): void {
    if (
      this.failReviewSettlement &&
      input.stageId === "review" &&
      input.checkpoint.outputCommitOid === oid(2)
    ) {
      this.failReviewSettlement = false;
      throw new Error("injected review settlement failure before commit");
    }
    super.settleLocalStage(input, presentation);
  }
}

test("resume reconciles review settlement with supersedesEvidenceSha256 across candidate change", async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), "onm-resume-revalidation-settlement-"),
  );
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  });
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const runId = "resume-reval-settlement-supersession";
  const intent = "Reconcile superseded review evidence on resume settlement.";
  const submission = oid(1);
  const fixed = oid(2);
  const ledger = new FaultSettlementLedger(":memory:");
  t.after(() => ledger.close());

  let pullRequest: GithubPullRequestObservation | null = null;
  let comments: GithubIssueCommentObservation[] = [];
  const authority = {
    createIssueComment: async ({ body }: { body: string }) => {
      comments = [
        {
          author: { id: "AN_actor", login: "owner" },
          body,
          createdAt: "2026-09-02T00:00:00.000Z",
          id: "IC_node",
          updatedAt: "2026-09-02T00:00:00.000Z",
          url: "https://github.com/owner/repo/pull/80#issuecomment-1",
        },
      ];
    },
    createPullRequest: async ({
      body,
      title,
    }: {
      body: string;
      title: string;
    }) => {
      pullRequest = {
        baseBranch: "main",
        baseOid: oid(100),
        baseRepositoryId: "R_repo",
        baseRepositoryNodeId: "RN_repo",
        body,
        draft: false,
        headBranch: "feature",
        headOid: fixed,
        headRepositoryId: "R_repo",
        headRepositoryNodeId: "RN_repo",
        id: "PR_node",
        number: 80,
        state: "MERGED",
        title,
        url: "https://github.com/owner/repo/pull/80",
      };
    },
    observeIssueComments: async () => comments,
    observePullRequests: async () => ({ exact: pullRequest, nearMatches: [] }),
    observeRepository: async () => ({ id: "R_repo", nodeId: "RN_repo" }),
    updateIssueComment: async () => {},
    updatePullRequest: async ({
      body,
      title,
    }: {
      body: string;
      title: string;
    }) => {
      pullRequest = { ...pullRequest!, body, title };
    },
  } as unknown as GithubAuthority;

  let remoteRefHead = "";
  const publicationRunner = async (_executable: string, args: string[]) => {
    if (args[0] === "config" && args[1] === "--get-regexp") {
      return { code: 1, stderr: "", stdout: "" };
    }
    if (args[0] === "ls-remote") {
      return remoteRefHead
        ? { code: 0, stderr: "", stdout: remoteRefHead }
        : { code: 2, stderr: "", stdout: "" };
    }
    if (args[0] === "push") {
      remoteRefHead = `${fixed}\trefs/heads/feature\n`;
      return { code: 0, stderr: "", stdout: "" };
    }
    return { code: 0, stderr: "", stdout: "" };
  };

  ledger.setRepositoryPublicationRoute({
    actorId: "A_actor",
    actorLogin: "owner",
    actorNodeId: "AN_actor",
    backend: "gh",
    backendVersion: "test",
    baseBranch: "main",
    baseRepositoryId: "R_repo",
    baseRepositoryName: "owner/repo",
    baseRepositoryNodeId: "RN_repo",
    credentialSource: "GH_TOKEN",
    forgeHost: "github.com",
    headBranch: "feature",
    headOwner: "owner",
    headRepositoryId: "R_repo",
    headRepositoryName: "owner/repo",
    headRepositoryNodeId: "RN_repo",
    networkRootRepositoryId: "R_repo",
    observedAt: "2026-09-02T00:00:00.000Z",
    repoRoot: root,
  });

  const git = new TestGit(root, submission, AUTO_FIX_CONFIG);
  const options = {
    githubAuthority: authority,
    intent,
    publicationDestination: "https://github.com/owner/repo.git",
    publicationRunner,
  };

  const findingA: Finding = {
    action: "ask-user",
    description: "Finding on candidate A.",
    id: "review-finding-a",
    severity: "error",
  };
  const docFinding: Finding = {
    action: "auto-fix",
    description: "Fix documentation on A.",
    id: "doc-fix",
    severity: "error",
  };

  const firstOrca = new TestOrca(runId);
  firstOrca.reviewerReports = [
    { findings: [findingA], summary: "review on candidate A" },
    pass("test passed"),
    { findings: [docFinding], summary: "doc finding on A" },
  ];
  firstOrca.onWorkerLaunch = (launch) => {
    if (launch.stage === "document" && launch.role === "fixer") {
      git.workerHead = fixed;
    }
  };
  firstOrca.onCompleteTask = async () => {
    if (ledger.stageDispositions(runId).some((row) => row.stage_id === "lint")) {
      throw new Error("fixture interrupted after lint settlement");
    }
  };

  await assert.rejects(
    runPipeline(options, firstOrca, git, ledger),
    /fixture interrupted after lint settlement/,
  );

  assert.equal(git.headOid, fixed);
  const e1 = ledger
    .listEvidence(runId)
    .find((row) => row.stage_id === "review" && row.candidate_commit_oid === submission)!;
  assert.ok(e1, "evidence E1 recorded on candidate A");
  const initialReviewDisp = ledger
    .stageDispositions(runId)
    .find((row) => row.stage_id === "review")!;
  assert.equal(initialReviewDisp.disposition, "satisfied");
  assert.equal(initialReviewDisp.evidence_sha256, e1.evidence_sha256);

  await installAbortReaping({ pid: process.pid });
  const findingB: Finding = {
    action: "ask-user",
    description: "Finding on candidate B.",
    id: "review-finding-b",
    severity: "error",
  };
  const secondOrca = new TestOrca("revalidation-with-settlement-crash");
  secondOrca.reviewerReports = [
    { findings: [findingB], summary: "review revalidation on candidate B" },
  ];
  ledger.failReviewSettlement = true;

  await assert.rejects(
    runPipeline({ ...options, resumeRunId: runId }, secondOrca, git, ledger),
    /injected review settlement failure before commit/,
  );

  assert.equal(
    secondOrca.launches.filter((l) => l.stage === "review" && l.role === "reviewer").length,
    1,
    "review revalidation launched on candidate B",
  );
  assert.equal(
    secondOrca.gates.length,
    1,
    "fresh approval gate created for review on candidate B",
  );

  const e2 = ledger
    .listEvidence(runId)
    .find((row) => row.stage_id === "review" && row.candidate_commit_oid === fixed)!;
  assert.ok(e2, "evidence E2 recorded on candidate B");
  assert.notEqual(e2.evidence_sha256, e1.evidence_sha256);

  const midReviewDisp = ledger
    .stageDispositions(runId)
    .find((row) => row.stage_id === "review")!;
  assert.equal(
    midReviewDisp.evidence_sha256,
    e1.evidence_sha256,
    "review disposition still E1 because settlement commit failed",
  );
  const midReviewCheckpoints = ledger
    .listCheckpoints(runId)
    .filter((row) => row.stage_id === "review");
  assert.ok(
    !midReviewCheckpoints.some((row) => row.output_commit_oid === fixed),
    "no checkpoint for review on candidate B before resume",
  );

  // First resume: reconciles review settlement on candidate B over E1, then pauses before completion
  await installAbortReaping({ pid: process.pid });
  const thirdOrca = new TestOrca("resume-interrupted-after-reconciliation");
  thirdOrca.reviewerReports = [];
  thirdOrca.onCompleteTask = async () => {
    if (
      ledger
        .listCheckpoints(runId)
        .some((row) => row.stage_id === "review" && row.output_commit_oid === fixed)
    ) {
      throw new Error("interrupted after review reconciliation");
    }
  };

  await assert.rejects(
    runPipeline({ ...options, resumeRunId: runId }, thirdOrca, git, ledger),
    /interrupted after review reconciliation/,
  );

  const reconciledDisp = ledger
    .stageDispositions(runId)
    .find((row) => row.stage_id === "review")!;
  assert.equal(reconciledDisp.disposition, "satisfied");
  assert.equal(
    reconciledDisp.evidence_sha256,
    e2.evidence_sha256,
    "E2 is now effective after first resume reconciliation",
  );
  assert.ok(
    ledger
      .listCheckpoints(runId)
      .some((row) => row.stage_id === "review" && row.output_commit_oid === fixed),
    "review checkpoint on candidate B committed during resume reconciliation",
  );

  // Repeated resume: already reconciled E2 is preserved safely without duplicate settlement or re-dispatch
  await installAbortReaping({ pid: process.pid });
  const fourthOrca = new TestOrca("repeated-resume-completion");
  fourthOrca.reviewerReports = [];

  const result = await runPipeline(
    { ...options, resumeRunId: runId },
    fourthOrca,
    git,
    ledger,
  );

  assert.equal(result.verdict, "passed");
  assert.equal(
    fourthOrca.launches.filter((l) => l.stage === "review").length,
    0,
    "no extra review worker reused or launched on repeated resume",
  );
  assert.equal(
    fourthOrca.gates.length,
    0,
    "no extra review gate reused or launched on repeated resume",
  );

  const allEvidence = ledger.listEvidence(runId);
  assert.ok(
    allEvidence.some((row) => row.evidence_sha256 === e1.evidence_sha256),
    "old evidence E1 retained in immutable history",
  );
  assert.ok(
    allEvidence.some((row) => row.evidence_sha256 === e2.evidence_sha256),
    "evidence E2 retained in immutable history",
  );

  const finalReviewDisp = ledger
    .stageDispositions(runId)
    .find((row) => row.stage_id === "review")!;
  assert.equal(finalReviewDisp.disposition, "satisfied");
  assert.equal(
    finalReviewDisp.evidence_sha256,
    e2.evidence_sha256,
    "E2 remains the effective disposition after repeated resume",
  );

  assert.throws(
    () =>
      ledger.settleLocalStage({
        checkpoint: {
          inputCommitOid: submission,
          outputCommitOid: submission,
          roundIndex: 0,
        },
        evidenceSha256: e1.evidence_sha256,
        supersedesEvidenceSha256: e2.evidence_sha256,
        runId,
        stageId: "review",
      }),
    /already settled/,
    "older replacement evidence E1 rejected when superseding effective E2",
  );

  assert.throws(
    () =>
      ledger.settleLocalStage({
        checkpoint: {
          inputCommitOid: fixed,
          outputCommitOid: fixed,
          roundIndex: 2,
        },
        evidenceSha256: "0".repeat(64),
        supersedesEvidenceSha256: e2.evidence_sha256,
        runId,
        stageId: "review",
      }),
    /already settled/,
    "unrelated replacement evidence rejected",
  );
});
