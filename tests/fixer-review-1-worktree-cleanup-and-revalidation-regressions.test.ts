import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  pullRequestArtifacts,
  runPipeline,
  type Finding,
  type FixerChangesVerdict,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";
import {
  terminalCandidate,
  CandidatePublicationError,
} from "../scripts/publication.ts";
import type { GithubAuthority } from "../scripts/github.ts";

const oid = (value: number): string => value.toString(16).padStart(40, "0");
const pass = (summary: string): StageReport => ({ findings: [], summary });
const AUTO_FIX_CONFIG =
  "auto_fix:\n  allow_review_autofix: true\n  guardrails: strict\n";
const finding: Finding = {
  action: "auto-fix",
  description: "Repair the implementation.",
  id: "review-finding",
  severity: "error",
};

class RegGit implements GitOperations {
  readonly baseOid = oid(100);
  headOid: string;
  readonly root: string;
  readonly trustedConfig: string;
  readonly fixerHead?: string;

  constructor(
    root: string,
    headOid: string,
    trustedConfig = "",
    fixerHead?: string,
  ) {
    this.root = root;
    this.headOid = headOid;
    this.trustedConfig = trustedConfig;
    this.fixerHead = fixerHead;
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
    return true;
  }

  async headOf(): Promise<string> {
    return this.fixerHead ?? this.headOid;
  }

  async worktreeIsReusable(): Promise<boolean> {
    return false;
  }

  async anchorRecoveryRef(): Promise<void> {}
}

class RegOrca implements OrcaOperations {
  readonly runId: string;
  readonly launches: WorkerLaunch[] = [];
  readonly calls: string[] = [];
  readonly removedWorktrees: string[] = [];
  reviewReports: StageReport[] = [];
  gateDecision = "approve";
  #task = 0;
  #dispatch = 0;

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
    const queued =
      launch.role === "reviewer" ? this.reviewReports.shift() : undefined;
    const dispatchId = `dispatch-${++this.#dispatch}`;
    return {
      dispatchId,
      report: queued ?? pass(`${launch.stage} ${launch.role} passed`),
      taskId,
      terminalHandle: `term-${dispatchId}`,
      worktreeId:
        launch.worktree === "new-child" ? `repo::/${dispatchId}` : undefined,
      worktreePath:
        launch.worktree === "new-child"
          ? path.join(this.runId, dispatchId)
          : undefined,
    };
  }

  async finishWorker(worker: WorkerResult, disposition?: "release" | "retain"): Promise<void> {
    this.calls.push(`${disposition ?? "release"}:${worker.dispatchId}`);
    worker.shutdownConfirmed = true;
  }

  async removeWorktree(worktreeId: string): Promise<void> {
    this.removedWorktrees.push(worktreeId);
  }

  async completeTask(): Promise<void> {}

  async createGate(): Promise<string> {
    return `${this.runId}-gate`;
  }

  async waitForGate(): Promise<string> {
    return this.gateDecision;
  }

  async setWorktreeStatus(): Promise<void> {}
}

test("reviewer worker worktrees are removed on unsafe-artifact and missing-artifact contract repairs", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-cleanup-reg-"));
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const git = new RegGit(root, oid(1), AUTO_FIX_CONFIG);
  const unsafeOrca = new RegOrca("unsafe-artifact-cleanup");
  unsafeOrca.reviewReports = [
    {
      findings: [],
      summary: "unsafe evidence",
      artifacts: ["/tmp/outside-evidence.log"],
    },
    pass("repaired review"),
  ];

  await runPipeline({ intent: "Confine reviewer evidence." }, unsafeOrca, git);
  const unsafeLaunches = unsafeOrca.launches.filter((launch) => launch.stage === "review");
  assert.equal(unsafeLaunches.length, 2);
  assert.match(unsafeLaunches[1].prompt, /REPORT REPAIR/);
  // Specifically verify that the rejected attempt's worker worktree was removed
  assert.ok(
    unsafeOrca.removedWorktrees.includes("repo::/dispatch-1"),
    "rejected unsafe-artifact worker worktree must be removed",
  );
  assert.ok(unsafeOrca.removedWorktrees.length >= 2);

  const missingOrca = new RegOrca("missing-artifact-cleanup");
  missingOrca.reviewReports = [
    {
      findings: [],
      summary: "missing evidence",
      artifacts: ["nonexistent.log"],
    },
    pass("repaired review"),
  ];

  await runPipeline({ intent: "Require reviewer evidence." }, missingOrca, git);
  const missingLaunches = missingOrca.launches.filter((launch) => launch.stage === "review");
  assert.equal(missingLaunches.length, 2);
  assert.match(missingLaunches[1].prompt, /REPORT REPAIR/);
  // Specifically verify that the rejected attempt's worker worktree was removed
  assert.ok(
    missingOrca.removedWorktrees.includes("repo::/dispatch-1"),
    "rejected missing-artifact worker worktree must be removed",
  );
  assert.ok(missingOrca.removedWorktrees.length >= 2);
});

test("FIFO artifact in report validation rejects without hanging and triggers contract repair", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-fifo-reg-"));
  const evidenceDir = path.join(root, "evidence");
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const fifoPath = path.join(evidenceDir, "fifo.pipe");
  try {
    execSync(`mkdir -p "${evidenceDir}" && mkfifo "${fifoPath}"`);
  } catch {
    // skip if mkfifo is not supported
    return;
  }

  const git = new RegGit(root, oid(1), AUTO_FIX_CONFIG);
  const orca = new RegOrca("fifo-artifact-repair");
  orca.reviewReports = [
    {
      findings: [],
      summary: "fifo evidence",
      artifacts: [fifoPath],
    },
    pass("repaired review"),
  ];

  await runPipeline({ intent: "Reject non-regular artifacts." }, orca, git);
  const launches = orca.launches.filter((launch) => launch.stage === "review");
  assert.equal(launches.length, 2);
  assert.match(launches[1].prompt, /REPORT REPAIR/);
  assert.ok(orca.removedWorktrees.includes("repo::/dispatch-1"));
});

test("pullRequestArtifacts reads digest and preview from the same checked descriptor", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "onm-pr-desc-"));
  t.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  const filePath = path.join(directory, "log.txt");
  await writeFile(filePath, "artifact log content for pr preview");

  const artifacts = await pullRequestArtifacts(directory, {
    artifacts: ["log.txt"],
    findings: [],
    summary: "pr artifacts test",
  });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].name, "Log");
  assert.equal(artifacts[0].content, "artifact log content for pr preview");
});

test("uninterrupted run revalidates candidate-bound approval when subsequent stage modifies candidate", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-uninterrupted-reval-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const ledger = new DomainLedger(":memory:");
  t.after(async () => {
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  });

  const runId = "uninterrupted-revalidation";
  const git = new RegGit(root, oid(1), AUTO_FIX_CONFIG);
  let workerHead = oid(1);
  git.headOf = async () => workerHead;

  class DriftOrca extends RegOrca {
    gates = 0;
    override async createGate(): Promise<string> {
      return `${this.runId}-gate-${++this.gates}`;
    }
    override async startWorker(taskId: string, launch: WorkerLaunch) {
      if (launch.stage === "document" && launch.role === "fixer") workerHead = oid(2);
      return super.startWorker(taskId, launch);
    }
  }

  const orca = new DriftOrca(runId);
  orca.gateDecision = "approve";
  orca.reviewReports = [
    // 1. Initial review on A -> finding -> user approves via gate
    { findings: [finding], summary: "finding on commit A" },
    // 2. Document test passes
    pass("tests passed"),
    // 3. Document reviewer finds doc issue -> fixer runs -> workerHead becomes oid(2)
    { findings: [{ ...finding, id: "doc-fix" }], summary: "doc finding" },
    // 4. Document re-check passes on B
    pass("doc recheck passed"),
    // 5. Revalidated review on B -> passed on B!
    pass("review passed cleanly on commit B"),
  ];

  const options = {
    githubAuthority: {} as GithubAuthority,
    intent: "Revalidate approved findings in same attempt.",
    publicationDestination: "https://github.com/owner/repo.git",
  };

  // Run pipeline in a single uninterrupted attempt. It should detect candidate drift before push,
  // reopen review, revalidate on B, and then reach publication with candidate B.
  await assert.rejects(runPipeline(options, orca, git, ledger), /no publication route/);

  // Review was visited twice: initially on A, then revalidated on B
  const reviewLaunches = orca.launches.filter((l) => l.stage === "review" && l.role === "reviewer");
  assert.ok(reviewLaunches.length >= 2, "review must be revalidated after candidate changed");
  assert.equal(git.headOid, oid(2));

  // The latest review disposition binds candidate B
  const reviewDisp = ledger.stageDispositions(runId).find((row) => row.stage_id === "review")!;
  const reviewEv = ledger.listEvidence(runId).find((row) => row.evidence_sha256 === reviewDisp.evidence_sha256)!;
  assert.equal(reviewEv.candidate_commit_oid, oid(2));
});

test("terminalCandidate rejects when approved stage candidate commit does not match terminal candidate", () => {
  const ledger = new DomainLedger(":memory:");
  const runId = "test-verified-candidate-drift";
  const base = oid(1);
  const candidateA = oid(2);
  const candidateB = oid(3);
  try {
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Verify candidate approval binding.",
      policySha256: "f".repeat(64),
      repoRoot: "/tmp/repo",
      runId,
      stagePlan: [
        { requirement: "required", stageId: "review" },
        { requirement: "required", stageId: "document" },
        { requirement: "required", stageId: "push" },
      ],
      submissionCommitOid: base,
    });
    // Review settled on candidateA with gate approval
    const evReviewSha = "a".repeat(64);
    ledger.recordEvidence({
      artifactPath: "/tmp/review.json",
      artifactSha256: "b".repeat(64),
      baseCommitOid: base,
      candidateCommitOid: candidateA,
      evidenceSha256: evReviewSha,
      exitCode: 1,
      roundIndex: 0,
      runId,
      stageId: "review",
      summary: "approved review findings",
      workerIdentity: "reviewer:test",
    });
    ledger.recordGateAudit({
      decision: "approve",
      evidenceSha256: evReviewSha,
      gateId: "gate-1",
      optionsJson: '["approve"]',
      question: "Approve?",
      resolution: "approve",
      roundIndex: 0,
      runId,
      stageId: "review",
    });
    ledger.recordCheckpoint({
      inputCommitOid: base,
      outputCommitOid: candidateA,
      roundIndex: 0,
      runId,
      stageId: "review",
    });
    ledger.recordStageDisposition({
      disposition: "satisfied",
      evidenceSha256: evReviewSha,
      runId,
      stageId: "review",
    });

    // Document stage advances candidate to candidateB
    const evDocSha = "c".repeat(64);
    ledger.recordEvidence({
      artifactPath: "/tmp/doc.json",
      artifactSha256: "d".repeat(64),
      baseCommitOid: candidateA,
      candidateCommitOid: candidateB,
      evidenceSha256: evDocSha,
      exitCode: 0,
      roundIndex: 0,
      runId,
      stageId: "document",
      summary: "doc fix committed",
      workerIdentity: "orca:test",
    });
    ledger.recordCheckpoint({
      inputCommitOid: candidateA,
      outputCommitOid: candidateB,
      roundIndex: 0,
      runId,
      stageId: "document",
    });
    ledger.recordStageDisposition({
      disposition: "satisfied",
      evidenceSha256: evDocSha,
      runId,
      stageId: "document",
    });

    assert.throws(
      () => terminalCandidate(ledger, runId, false),
      CandidatePublicationError,
    );
  } finally {
    ledger.close();
  }
});

test("trusted coordinator executable is absolute and used for normal and repair report submission", async () => {
  const git = new RegGit("/tmp/repo", oid(1), AUTO_FIX_CONFIG);
  const orca = new RegOrca("trusted-exec-test");
  orca.reviewReports = [
    { findings: [], summary: "missing evidence", artifacts: ["missing.log"] },
    pass("repaired"),
  ];

  await runPipeline({ intent: "Check trusted executable path." }, orca, git);
  assert.ok(orca.launches.length >= 2);
  for (const launch of orca.launches) {
    assert.match(
      launch.prompt,
      /'\/.*bin\/orca-no-mistakes'\s+report\s+--stage/,
      "report command must use absolute trusted coordinator executable",
    );
    assert.doesNotMatch(
      launch.prompt,
      /\.\/bin\/orca-no-mistakes report/,
      "report command must not use relative path to subject repo",
    );
  }
});
