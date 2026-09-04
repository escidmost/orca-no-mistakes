import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  evidenceSha256,
  sha256,
} from "../scripts/ledger.ts";
import {
  runPipeline,
  type GitOperations,
  type OrcaOperations,
  type WorkerLaunch,
} from "../scripts/orca-no-mistakes.ts";
import { capTitle, pullRequestContent } from "../scripts/pull-request.ts";

test("capTitle normalizes multiline titles to single line and truncates without markdown", () => {
  const multiline = "feat: add feature\n\nwith additional details\nand more text";
  assert.equal(
    capTitle(multiline, 256),
    "feat: add feature with additional details and more text",
  );

  const longTitle = "feat: " + "a".repeat(300);
  const capped = capTitle(longTitle, 256);
  assert.equal(Buffer.byteLength(capped), 256);
  assert.doesNotMatch(capped, /truncated/);
  assert.doesNotMatch(capped, /[\r\n]/);

  const content = pullRequestContent("test intent", {
    candidateCommitOid: "a".repeat(40),
    pipelineSteps: [],
    risk: { level: "low", rationale: "ok" },
    testing: { artifacts: [], summary: "tested", tested: [] },
    title: "feat: multiline\n\ntitle\n" + "x".repeat(300),
    whatChanged: "changed",
  });
  assert.ok(Buffer.byteLength(content.title) <= 256);
  assert.doesNotMatch(content.title, /[\r\n]/);
  assert.doesNotMatch(content.title, /truncated/);
});

test("historical open PR receipt does not bypass PR stage on resume", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-open-pr-resume-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = temp;
  const ledger = new DomainLedger(path.join(temp, "ledger.sqlite"));
  const runId = "open-pr-run";
  const base = "0".repeat(40);
  const candidate = "1".repeat(40);
  const policy = "2".repeat(64);

  try {
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Resume with open PR",
      policySha256: policy,
      repoRoot: temp,
      runId,
      stagePlan: [
        { requirement: "required", stageId: "push" },
        { requirement: "required", stageId: "pr" },
      ],
      submissionCommitOid: candidate,
    });
    const route = {
      baseBranch: "main",
      baseRepositoryId: "R_base",
      forgeHost: "github.com",
      headBranch: "feature",
      headOwner: "owner",
      headRepositoryId: "R_head",
    };
    const routeFingerprint = ledger.recordPublicationRoute({ ...route, runId });
    ledger.setRepositoryPublicationRoute({
      actorId: "A_actor",
      actorLogin: "owner",
      actorNodeId: "AN_actor",
      backend: "gh",
      backendVersion: "test",
      baseBranch: "main",
      baseRepositoryId: "R_base",
      baseRepositoryName: "owner/base",
      baseRepositoryNodeId: "RN_base",
      credentialSource: "GH_TOKEN",
      forgeHost: "github.com",
      headBranch: "feature",
      headOwner: "owner",
      headRepositoryId: "R_head",
      headRepositoryName: "owner/repo",
      headRepositoryNodeId: "RN_head",
      networkRootRepositoryId: "R_head",
      observedAt: new Date().toISOString(),
      repoRoot: temp,
    });
    ledger.recordPublicationBaseline({
      headCommitOid: null,
      observedAt: new Date().toISOString(),
      routeFingerprint,
      runId,
      transportUrl: "github.com/owner/repo",
    });
    const token = ledger.acquireLease({ branch: "feature", repoRoot: temp, runId });
    ledger.startAttempt({
      actorIdentity: "operator",
      attemptId: "att-1",
      coordinatorIdentity: "coordinator",
      generationToken: token,
      runId,
      startedAt: new Date().toISOString(),
    });

    const entries: {
      artifactPath: string;
      artifactSha256: string;
      baseCommitOid: string;
      candidateCommitOid: string;
      evidenceSha256: string;
      exitCode: number;
      round: number;
      stage: "push" | "pr";
      summary: string;
      workerIdentity: string;
    }[] = [];
    for (const [round, stage] of (["push", "pr"] as const).entries()) {
      const artifact = Buffer.from(stage);
      const artifactPath = path.join(temp, `${stage}.txt`);
      await writeFile(artifactPath, artifact);
      const entry = {
        artifactPath,
        artifactSha256: sha256(artifact),
        baseCommitOid: base,
        candidateCommitOid: candidate,
        evidenceSha256: "",
        exitCode: 0,
        round,
        stage,
        summary: `${stage} passed`,
        workerIdentity: "coordinator",
      };
      entry.evidenceSha256 = evidenceSha256({ ...entry, runId });
      entries.push(entry);
    }
    const evidenceFor = (stage: "pr" | "push") => {
      const entry = entries.find((e) => e.stage === stage)!;
      return {
        artifactPath: entry.artifactPath,
        artifactSha256: entry.artifactSha256,
        baseCommitOid: base,
        candidateCommitOid: candidate,
        evidenceSha256: entry.evidenceSha256,
        exitCode: 0,
        roundIndex: entry.round,
        runId,
        stageId: stage,
        summary: entry.summary,
        workerIdentity: entry.workerIdentity,
      };
    };

    const pubPre = ledger.recordRemoteObservation({
      attemptId: "att-1",
      kind: "publication-head",
      observedAt: new Date().toISOString(),
      payload: {
        forgeHost: "github.com",
        headBranch: "feature",
        headOwner: "owner",
        repositoryId: "R_head",
        state: "absent",
      },
      runId,
      subject: "github.com/R_head:refs/heads/feature",
    });
    const pubIntent = ledger.recordMutationIntent({
      attemptId: "att-1",
      createdAt: new Date().toISOString(),
      kind: "candidate-publication",
      payload: { expected: "absent", update: candidate },
      runId,
      targetFingerprint: routeFingerprint,
    });
    const pubPost = ledger.recordRemoteObservation({
      attemptId: "att-1",
      kind: "publication-head",
      observedAt: new Date().toISOString(),
      payload: {
        forgeHost: "github.com",
        headBranch: "feature",
        headOwner: "owner",
        oid: candidate,
        repositoryId: "R_head",
      },
      runId,
      subject: "github.com/R_head:refs/heads/feature",
    });
    const pubReceipt = ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 0 },
      evidence: evidenceFor("push"),
      ownership: { branch: "feature", generationToken: token, repoRoot: temp },
      receipt: {
        authoritativePostObservationSha256: pubPost,
        candidateCommitOid: candidate,
        kind: "candidate-publication",
        payload: {
          mutationIntent: pubIntent,
          outcome: "created",
          postRead: pubPost,
          preRead: pubPre,
          routeFingerprint,
        },
      },
      runId,
      stageId: "push",
    }).receiptSha256;

    const prFacts = {
      baseBranch: "main",
      baseRepositoryId: "R_base",
      candidateCommitOid: candidate,
      forgeHost: "github.com",
      headBranch: "feature",
      headOwner: "owner",
      headRepositoryId: "R_head",
    };
    const prIntent = ledger.recordMutationIntent({
      attemptId: "att-1",
      createdAt: new Date().toISOString(),
      kind: "pull-request",
      payload: { action: "ensure-open", ...prFacts },
      runId,
      targetFingerprint: routeFingerprint,
    });
    const prObs = ledger.recordRemoteObservation({
      attemptId: "att-1",
      kind: "pull-request",
      observedAt: new Date().toISOString(),
      payload: { ...prFacts, number: 42, state: "open" },
      runId,
      subject: "github.com/R_base#42",
    });
    const prReceipt = ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 1 },
      evidence: evidenceFor("pr"),
      ownership: { branch: "feature", generationToken: token, repoRoot: temp },
      receipt: {
        authoritativePostObservationSha256: prObs,
        candidateCommitOid: candidate,
        kind: "pull-request-binding",
        payload: {
          mutationIntent: prIntent,
          number: 42,
          outcome: "created",
          postRead: prObs,
          routeFingerprint,
        },
      },
      runId,
      stageId: "pr",
    }).receiptSha256;

    ledger.recordAttemptOutcome({
      actorIdentity: "operator",
      attemptId: "att-1",
      candidateCommitOid: candidate,
      completedAt: new Date().toISOString(),
      coordinatorIdentity: "coordinator",
      custody: { recoveryRef: `refs/no-mistakes/recover/${runId}` },
      reason: "interrupted after remote settlement",
      receiptDigests: [pubReceipt, prReceipt],
      resumeEligible: true,
      runId,
      stoppingFact: "retry-required",
      verdict: "failed",
    });
    ledger.finishRun(runId, "failed");
    ledger.releaseLease(runId);

    let prDraftCount = 0;
    let prState = {
      baseBranch: "main",
      baseOid: base,
      baseRepositoryId: "R_base",
      baseRepositoryNodeId: "RN_base",
      body: "body",
      draft: false,
      headBranch: "feature",
      headOid: candidate,
      headRepositoryId: "R_head",
      headRepositoryNodeId: "RN_head",
      id: "PR_node",
      number: 42,
      state: "OPEN",
      title: "title",
      url: "https://github.com/owner/repo/pull/42",
    };
    const authority = {
      observeRepository: async () => ({ id: "R_head", nodeId: "RN_head" }),
      observePullRequests: async () => ({
        exact: prState,
        nearMatches: [],
      }),
      createPullRequest: async () => {},
      updatePullRequest: async ({ body, title }: { body: string; title: string }) => {
        prState = { ...prState, body, title };
      },
    };

    const operations: OrcaOperations = {
      async createRun() { return "resumed-run"; },
      async createTask() { return "task-1"; },
      async startWorker(taskId, launch: WorkerLaunch) {
        if (launch.stage === "pr") {
          prDraftCount += 1;
        }
        return {
          dispatchId: "dispatch-1",
          report: { findings: [], summary: "passed", title: "PR title" },
          taskId,
          terminalHandle: "term-1",
        };
      },
      async finishWorker(worker) { worker.shutdownConfirmed = true; },
      async removeWorktree() {},
      async completeTask() {},
      async createGate() { return "gate-1"; },
      async waitForGate() { return "approve"; },
      async setWorktreeStatus() {},
      async notifyPullRequestReady() {
        throw new Error("stop at pr notify");
      },
    };
    const git: GitOperations = {
      async assertReady() { return { base: "main", baseOid: base, branch: "feature", head: candidate, root: temp }; },
      async assertClean() {},
      async assertFixerChangesAllowed() { return { changed: false, guardrailViolations: [] }; },
      async head() { return candidate; },
      async diffBase() { return ""; },
      async rebase() { return { findings: [], rebaseUpstreamHead: base, summary: "rebased" }; },
      async resolveRefSha() { return base; },
      async showFile() { return undefined; },
      async pathExists() { return false; },
      async policySha256() { return policy; },
      async resolveBaseOid() { return base; },
      async applyWorktreeCommits() { return false; },
      async headOf() { return candidate; },
      async worktreeIsReusable() { return false; },
      async anchorRecoveryRef() {},
    };

    await assert.rejects(
      runPipeline(
        {
          githubAuthority: authority as any,
          intent: "Resume with open PR",
          publicationDestination: "owner/repo",
          publicationRunner: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
          resumeRunId: runId,
        },
        operations,
        git,
        ledger,
      ),
      /stop at pr notify/,
    );
    assert.equal(prDraftCount, 1, "PR stage must run rather than being bypassed");
  } finally {
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});

test("ledger recordCheckpoint atomically commits checkpoint and presentation snapshot", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-atomic-checkpoint-"));
  const ledger = new DomainLedger(path.join(temp, "ledger.sqlite"));
  const runId = "atomic-check-run";
  const candidate = "1".repeat(40);
  const candidate2 = "2".repeat(40);

  try {
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Atomic checkpoint test",
      policySha256: "0".repeat(64),
      repoRoot: "/repo",
      runId,
      stagePlan: [{ requirement: "required", stageId: "review" }],
      submissionCommitOid: candidate,
    });

    const eventKey = "attempt:1:stage:review:round:0:fixer:completed:out";
    const snapshot = {
      attempt: 1,
      mode: { autoFix: true },
      runId,
      sequence: 1,
      stages: [],
      status: "in-progress" as const,
      transition: {
        approvedFindings: 1,
        findingIds: ["f1"],
        kind: "fix-completed" as const,
        round: 0,
        stage: "review" as const,
      },
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    ledger.recordCheckpoint(
      {
        inputCommitOid: candidate,
        outputCommitOid: candidate2,
        roundIndex: 0,
        runId,
        stageId: "review",
      },
      { eventKey, snapshot },
    );

    const snapshots = ledger.listPresentationSnapshots(runId);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].transition.kind, "fix-completed");
    const checkpoints = ledger.listCheckpoints(runId);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].output_commit_oid, candidate2);
  } finally {
    ledger.close();
    await rm(temp, { force: true, recursive: true });
  }
});
