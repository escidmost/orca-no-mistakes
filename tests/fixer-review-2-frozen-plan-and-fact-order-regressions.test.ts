import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DomainLedger, evidenceSha256 } from "../scripts/ledger.ts";
import { main } from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("remoteReceipt orders by append order (rowid DESC) rather than wall-clock created_at", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-receipt-order-"));
  const dbPath = path.join(temp, "ledger.sqlite");
  const ledger = new DomainLedger(dbPath);
  try {
    const runId = "run-receipt-order";
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Receipt ordering test.",
      policySha256: "0".repeat(64),
      repoRoot: "/repo",
      runId,
      submissionCommitOid: "1".repeat(40),
    });

    const genToken = ledger.acquireLease({ branch: "feature", repoRoot: "/repo", runId });
    ledger.startAttempt({
      actorIdentity: "operator",
      attemptId: "att-1",
      coordinatorIdentity: "coordinator",
      generationToken: genToken,
      runId,
      startedAt: "2026-09-02T10:00:00.000Z",
    });

    const candidateOid = "2".repeat(40);
    const observationSha1 = ledger.recordRemoteObservation({
      attemptId: "att-1",
      kind: "publication-head",
      observedAt: "2026-09-02T12:00:00.000Z",
      payload: { oid: candidateOid },
      runId,
      subject: "test/repo:refs/heads/feature",
    });
    const observationSha2 = ledger.recordRemoteObservation({
      attemptId: "att-1",
      kind: "publication-head",
      observedAt: "2026-09-02T11:00:00.000Z",
      payload: { oid: candidateOid },
      runId,
      subject: "test/repo:refs/heads/feature",
    });

    const db = new DatabaseSync(dbPath);
    try {
      const insert = db.prepare(
        `INSERT INTO remote_receipts (
           receipt_id, run_id, kind, candidate_commit_oid,
           authoritative_post_observation_sha256, receipt_json, receipt_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      // First inserted receipt with later wall-clock time
      insert.run(
        randomUUID(),
        runId,
        "candidate-publication",
        candidateOid,
        observationSha1,
        JSON.stringify({ version: 1 }),
        "sha-receipt-1",
        "2026-09-02T12:00:00.000Z",
      );
      // Second inserted receipt with earlier wall-clock time (clock rollback)
      insert.run(
        randomUUID(),
        runId,
        "candidate-publication",
        candidateOid,
        observationSha2,
        JSON.stringify({ version: 2 }),
        "sha-receipt-2",
        "2026-09-02T11:00:00.000Z",
      );
    } finally {
      db.close();
    }

    const latest = ledger.remoteReceipt(runId, "candidate-publication");
    assert.ok(latest);
    assert.equal(latest.receipt_sha256, "sha-receipt-2");
    assert.equal(JSON.parse(latest.receipt_json).version, 2);
  } finally {
    ledger.close();
    await rm(temp, { force: true, recursive: true });
  }
});

test("listAttemptOutcomes orders by attempt generation_token and rowid despite clock rollback", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-attempt-order-"));
  const dbPath = path.join(temp, "ledger.sqlite");
  const ledger = new DomainLedger(dbPath);
  try {
    const runId = "run-attempt-order";
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Attempt ordering test.",
      policySha256: "0".repeat(64),
      repoRoot: "/repo",
      runId,
      submissionCommitOid: "1".repeat(40),
    });

    const genToken1 = ledger.acquireLease({ branch: "feature", repoRoot: "/repo", runId });
    ledger.startAttempt({
      actorIdentity: "operator",
      attemptId: "att-generation-1",
      coordinatorIdentity: "coordinator",
      generationToken: genToken1,
      runId,
      startedAt: "2026-09-02T10:00:00.000Z",
    });

    const outcome1Sha = ledger.recordAttemptOutcome({
      actorIdentity: "operator",
      attemptId: "att-generation-1",
      candidateCommitOid: "1".repeat(40),
      completedAt: "2026-09-02T12:00:00.000Z",
      coordinatorIdentity: "coordinator",
      custody: {},
      reason: "failed stage",
      receiptDigests: [],
      resumeEligible: true,
      runId,
      stoppingFact: "failure",
      verdict: "failed",
    });

    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        `UPDATE branch_leases SET generation_token = 2 WHERE run_id = ?`
      ).run(runId);
      db.prepare(
        `INSERT INTO run_attempts (
           attempt_id, run_id, generation_token, coordinator_identity, actor_identity, started_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run("att-generation-2", runId, 2, "coordinator", "operator", "2026-09-02T11:00:00.000Z");
    } finally {
      db.close();
    }

    const outcome2Sha = ledger.recordAttemptOutcome({
      actorIdentity: "operator",
      attemptId: "att-generation-2",
      candidateCommitOid: "2".repeat(40),
      completedAt: "2026-09-02T11:00:00.000Z",
      coordinatorIdentity: "coordinator",
      custody: {},
      reason: "passed stage",
      receiptDigests: [],
      resumeEligible: false,
      runId,
      stoppingFact: "success",
      verdict: "passed",
    });

    const outcomes = ledger.listAttemptOutcomes(runId);
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0].outcome_sha256, outcome1Sha);
    assert.equal(outcomes[1].outcome_sha256, outcome2Sha);
  } finally {
    ledger.close();
    await rm(temp, { force: true, recursive: true });
  }
});

test("pull-request settlement rejects when managed-comment mutation postdates observation", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-comment-order-"));
  const dbPath = path.join(temp, "ledger.sqlite");
  const ledger = new DomainLedger(dbPath);
  try {
    const runId = "run-comment-order";
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Comment ordering test.",
      policySha256: "0".repeat(64),
      repoRoot: "/repo",
      runId,
      submissionCommitOid: "1".repeat(40),
    });

    const genToken = ledger.acquireLease({ branch: "feature", repoRoot: "/repo", runId });
    ledger.startAttempt({
      actorIdentity: "operator",
      attemptId: "att-1",
      coordinatorIdentity: "coordinator",
      generationToken: genToken,
      runId,
      startedAt: "2026-09-02T10:00:00.000Z",
    });

    const route = {
      actorId: "U_1",
      actorLogin: "operator",
      actorNodeId: "U_node_1",
      backend: "gh" as const,
      backendVersion: "2.97.0",
      baseBranch: "main",
      baseRepositoryId: "1",
      baseRepositoryName: "upstream/project",
      baseRepositoryNodeId: "R_base",
      credentialSource: "stored-account" as const,
      forgeHost: "github.com" as const,
      headBranch: "feature",
      headOwner: "upstream",
      headRepositoryId: "1",
      headRepositoryName: "upstream/project",
      headRepositoryNodeId: "R_base",
      networkRootRepositoryId: "1",
      observedAt: "2026-09-02T10:00:00.000Z",
      repoRoot: "/repo",
    };
    ledger.setRepositoryPublicationRoute(route);
    ledger.recordStoredPublicationRoute(runId, "/repo");
    const storedRoute = ledger.publicationRoute(runId);
    assert.ok(storedRoute);

    ledger.recordPublicationBaseline({
      headCommitOid: "1".repeat(40),
      observedAt: "2026-09-02T10:00:00.000Z",
      routeFingerprint: storedRoute.route_fingerprint,
      runId,
      transportUrl: "github.com/upstream/project",
    });

    const candidateOid = "2".repeat(40);
    const pubPostRead = ledger.recordRemoteObservation({
      attemptId: "att-1",
      kind: "publication-head",
      observedAt: "2026-09-02T10:03:00.000Z",
      payload: {
        forgeHost: "github.com",
        headBranch: "feature",
        headOwner: "upstream",
        oid: candidateOid,
        repositoryId: "1",
      },
      runId,
      subject: "github.com/1:refs/heads/feature",
    });

    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        `INSERT INTO remote_receipts (
           receipt_id, run_id, kind, candidate_commit_oid,
           authoritative_post_observation_sha256, receipt_json, receipt_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(),
        runId,
        "candidate-publication",
        candidateOid,
        pubPostRead,
        JSON.stringify({ outcome: "updated" }),
        "pub-receipt-sha",
        "2026-09-02T10:03:00.000Z",
      );
    } finally {
      db.close();
    }

    const prMutation = ledger.recordMutationIntent({
      attemptId: "att-1",
      createdAt: "2026-09-02T10:04:00.000Z",
      kind: "pull-request",
      payload: {
        action: "create",
        baseBranch: "main",
        headBranch: "feature",
      },
      runId,
      targetFingerprint: storedRoute.route_fingerprint,
    });

    // Managed comment mutation created at 10:06 (AFTER post-read observation at 10:05)
    const commentMutation = ledger.recordMutationIntent({
      attemptId: "att-1",
      createdAt: "2026-09-02T10:06:00.000Z",
      kind: "managed-comment",
      payload: {
        action: "ensure-managed-summary",
        bodySha256: "b".repeat(64),
        managedCommentNodeId: "comment-1",
        number: 123,
      },
      runId,
      targetFingerprint: storedRoute.route_fingerprint,
    });

    // Post-read observation at 10:05 (PREDATES comment mutation at 10:06)
    const prPostRead = ledger.recordRemoteObservation({
      attemptId: "att-1",
      kind: "pull-request",
      observedAt: "2026-09-02T10:05:00.000Z",
      payload: {
        baseBranch: "main",
        baseRepositoryId: "1",
        forgeHost: "github.com",
        headBranch: "feature",
        headOwner: "upstream",
        headRepositoryId: "1",
        managedCommentBodySha256: "b".repeat(64),
        managedCommentNodeId: "comment-1",
        number: 123,
        pullRequestNodeId: "pr-1",
        state: "open",
      },
      runId,
      subject: "github.com/1#123",
    });

    const prEvidenceSha = evidenceSha256({
      artifactSha256: "f".repeat(64),
      baseCommitOid: "0".repeat(40),
      candidateCommitOid: candidateOid,
      exitCode: 0,
      round: 0,
      runId,
      stage: "pr",
      summary: "PR bound",
      workerIdentity: "worker",
    });

    assert.throws(
      () =>
        ledger.settleRemoteStage({
          checkpoint: {
            inputCommitOid: candidateOid,
            outputCommitOid: candidateOid,
            roundIndex: 0,
          },
          evidence: {
            artifactPath: "/tmp/pr-evidence.json",
            artifactSha256: "f".repeat(64),
            baseCommitOid: "0".repeat(40),
            candidateCommitOid: candidateOid,
            evidenceSha256: prEvidenceSha,
            exitCode: 0,
            roundIndex: 0,
            runId,
            stageId: "pr",
            summary: "PR bound",
            workerIdentity: "worker",
          },
          ownership: {
            branch: "feature",
            generationToken: genToken,
            repoRoot: "/repo",
          },
          receipt: {
            authoritativePostObservationSha256: prPostRead,
            candidateCommitOid: candidateOid,
            kind: "pull-request-binding",
            payload: {
              managedCommentIntent: commentMutation,
              mutationIntent: prMutation,
              number: 123,
              outcome: "created",
              pipelineEvidenceRoot: "d".repeat(64),
              postRead: prPostRead,
              routeFingerprint: storedRoute.route_fingerprint,
            },
          },
          runId,
          stageId: "pr",
        }),
      /pr receipt does not match its authoritative post-read observation/,
    );
  } finally {
    ledger.close();
    await rm(temp, { force: true, recursive: true });
  }
});

test("launchDetachedRun permits legacy resume on unsupported forge with frozen stage plan", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-legacy-resume-"));
  const origin = path.join(temp, "origin.git");
  const repo = path.join(temp, "repo");
  try {
    git(temp, "-c", "init.templateDir=", "init", "--bare", origin);
    git(temp, "-c", "init.templateDir=", "init", "-b", "main", repo);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "commit", "--allow-empty", "-m", "initial commit");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-u", "origin", "main");
    git(temp, `--git-dir=${origin}`, "symbolic-ref", "HEAD", "refs/heads/main");
    git(repo, "checkout", "-b", "feature");

    const ledger = new DomainLedger(path.join(repo, ".orca", "no-mistakes", "ledger.sqlite"));
    const runId = "migrated-run-123";
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Legacy migrated run.",
      policySha256: "0".repeat(64),
      repoRoot: repo,
      runId,
      stagePlan: [
        { requirement: "required", stageId: "intent" },
        { requirement: "required", stageId: "spec" },
        { requirement: "required", stageId: "plan" },
        { requirement: "required", stageId: "code" },
        { requirement: "required", stageId: "lint" },
        { requirement: "required", stageId: "test" },
      ],
      submissionCommitOid: "1".repeat(40),
    });
    ledger.close();

    await assert.rejects(
      () => main(["run", "--repo", repo, "--resume", runId]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.doesNotMatch(err.message, /unsupported forge/);
        return true;
      },
    );
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});
