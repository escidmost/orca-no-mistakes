import assert from "node:assert/strict";
import { withLivePass } from './live-validation-fixture.ts';
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  LEGACY_STAGE_PLAN,
  type StageEvidenceManifestEntry,
} from "../scripts/ledger.ts";
import {
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
import { pullRequestContent } from "../scripts/pull-request.ts";

const oid = (value: number): string => value.toString(16).padStart(40, "0");
const pass = (summary: string): StageReport => ({ findings: [], summary });
const AUTO_FIX_CONFIG =
  "auto_fix:\n  allow_review_autofix: true\n  guardrails: strict\n";

const finding: Finding = {
  action: "auto-fix",
  description: "Repair candidate-bound issue.",
  id: "candidate-finding",
  severity: "error",
};

class RegGit implements GitOperations {
  readonly baseOid = oid(100);
  headOid: string;
  readonly root: string;
  readonly trustedConfig: string;
  fixerHead?: string;

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

class TestOrca implements OrcaOperations {
  readonly runId: string;
  readonly launches: WorkerLaunch[] = [];
  readonly calls: string[] = [];
  readonly removedWorktrees: string[] = [];
  reports: StageReport[] = [];
  gateDecisions: string[] = [];
  gates = 0;
  #task = 0;
  #dispatch = 0;
  onWorkerStart?: (launch: WorkerLaunch) => void;

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
    this.onWorkerStart?.(launch);
    const queued =
      launch.role === "reviewer" ? this.reports.shift() : undefined;
    const dispatchId = `dispatch-${++this.#dispatch}`;
    return {
      dispatchId,
      report: withLivePass(launch, queued ?? pass(`${launch.stage} ${launch.role} passed`)),
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

  async finishWorker(
    worker: WorkerResult,
    disposition?: "release" | "retain",
  ): Promise<void> {
    this.calls.push(`${disposition ?? "release"}:${worker.dispatchId}`);
    worker.shutdownConfirmed = true;
  }

  async removeWorktree(worktreeId: string): Promise<void> {
    this.removedWorktrees.push(worktreeId);
  }

  async completeTask(): Promise<void> {}

  async createGate(): Promise<string> {
    return `${this.runId}-gate-${++this.gates}`;
  }

  async waitForGate(): Promise<string> {
    return this.gateDecisions.shift() ?? "approve";
  }

  async setWorktreeStatus(): Promise<void> {}
}

test("uninterrupted six-stage local pipeline revalidates review approval on candidate change and requires fresh gate", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-local-reval-six-stage-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const ledger = new DomainLedger(":memory:");
  t.after(async () => {
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  });

  const runId = "test-uninterrupted-six-stage";
  const git = new RegGit(root, oid(1), AUTO_FIX_CONFIG);
  let workerHead = oid(1);
  git.headOf = async () => workerHead;

  const orca = new TestOrca(runId);
  orca.gateDecisions = ["approve", "approve"];

  orca.onWorkerStart = (launch) => {
    if (launch.stage === "document" && launch.role === "fixer") {
      workerHead = oid(2);
    }
  };

  orca.reports = [
    { findings: [finding], summary: "review finding on commit A" },
    pass("test passed on commit A"),
    { findings: [{ ...finding, id: "doc-fix" }], summary: "doc finding" },
    pass("doc recheck passed on commit B"),
    pass("lint passed on commit B"),
    { findings: [finding], summary: "review finding on commit B (identical)" },
    pass("revalidated test passed"),
    pass("revalidated doc passed"),
    pass("revalidated lint passed"),
  ];

  await runPipeline(
    {
      intent: "Verify six-stage local revalidation requires fresh gate without infinite loop.",
    },
    orca,
    git,
    ledger,
  );

  assert.equal(orca.gates, 2);

  const reviewLaunches = orca.launches.filter(
    (l) => l.stage === "review" && l.role === "reviewer",
  );
  assert.equal(reviewLaunches.length, 2);

  const evidenceRows = ledger.listEvidence(runId);
  const reviewEvidence = evidenceRows.filter((e) => e.stage_id === "review");
  assert.equal(reviewEvidence.length, 4);
  assert.ok(reviewEvidence.slice(0, 2).every((e) => e.candidate_commit_oid === oid(1)));
  assert.ok(reviewEvidence.slice(2, 4).every((e) => e.candidate_commit_oid === oid(2)));

  const gateAudits = ledger.listGateAudit(runId);
  const reviewAudits = gateAudits.filter((a) => a.stage_id === "review" && a.resolved_at !== null);
  const waiverAudits = reviewAudits.filter((a) => a.gate_id.endsWith(":authoritative-waiver"));
  assert.equal(waiverAudits.length, 2);
  assert.equal(waiverAudits[0].decision, "approve");
  assert.equal(waiverAudits[1].decision, "approve");
  assert.equal(waiverAudits[0].evidence_sha256, reviewEvidence[0].evidence_sha256);
  assert.equal(waiverAudits[1].evidence_sha256, reviewEvidence[2].evidence_sha256);

  const latestReviewEv = reviewEvidence.at(-1)!;
  assert.equal(latestReviewEv.candidate_commit_oid, oid(2));
});

test("pullRequestArtifacts withholds worker-controlled artifact content by default and publishes safe metadata and recorded digest", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "onm-pr-artifacts-exfil-"));
  t.after(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const privateKeyBytes = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
    "QyNTUxOQAAACDH7YfJ3vQ9vQ3vQ9vQ3vQ9vQ3vQ9vQ3vQ9vQ3vQ9vQ3wAAAJC9vQ3vQ9",
    "-----END OPENSSH PRIVATE KEY-----",
    "",
  ].join("\n");

  const artifactName = "id_ed25519";
  const artifactPath = path.join(dir, artifactName);
  await writeFile(artifactPath, privateKeyBytes);

  const digest = createHash("sha256").update(privateKeyBytes).digest("hex");
  const report: StageReport = {
    artifactDigests: { [artifactName]: digest },
    artifacts: [artifactName],
    findings: [],
    summary: "worker reported synthetic private key",
  };

  const artifacts = await pullRequestArtifacts(dir, report);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].name, "Id ed25519");

  assert.ok(!artifacts[0].content.includes("BEGIN OPENSSH PRIVATE KEY"));
  assert.ok(!artifacts[0].content.includes("b3BlbnNzaC"));
  assert.ok(artifacts[0].content.includes(digest));
  assert.ok(artifacts[0].content.includes("id_ed25519"));
  assert.ok(artifacts[0].content.includes("[Artifact content withheld:"));

  const prReport = pullRequestContent("Intent: test artifact safety", {
    candidateCommitOid: oid(1),
    pipelineSteps: [],
    risk: { level: "low", rationale: "none" },
    testing: {
      artifacts,
      summary: "all checks passed",
      tested: ["npm test"],
    },
    whatChanged: "Add secret withholding boundary",
  });

  assert.ok(!prReport.body.includes("BEGIN OPENSSH PRIVATE KEY"));
  assert.ok(!prReport.body.includes("b3BlbnNzaC"));
  assert.ok(prReport.body.includes(digest));
  assert.ok(prReport.body.includes("[Artifact content withheld:"));
  assert.ok(prReport.body.includes("id_ed25519"));

  const approvedArtifacts = await pullRequestArtifacts(
    dir,
    report,
    new Set([digest]),
  );
  assert.equal(approvedArtifacts.length, 1);
  assert.ok(approvedArtifacts[0].content.includes("BEGIN OPENSSH PRIVATE KEY"));

  const mismatchedReport: StageReport = {
    artifactDigests: { [artifactName]: "0".repeat(64) },
    artifacts: [artifactName],
    findings: [],
    summary: "tampered digest",
  };
  const skipped = await pullRequestArtifacts(dir, mismatchedReport);
  assert.equal(skipped.length, 0);
});
