import assert from 'node:assert/strict';
import { withLivePass } from './live-validation-fixture.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DomainLedger,
  buildPipelineCompletionAttestation,
  evidenceSha256,
  sha256,
  type RepositoryPublicationRouteInput,
  type StageEvidenceManifestEntry,
} from '../scripts/ledger.ts';
import {
  type Finding,
  type FixerChangesVerdict,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
  type WorkerLaunch,
  type WorkerResult,
  runPipeline,
} from '../scripts/orca-no-mistakes.ts';
import { type GithubAuthority } from '../scripts/github.ts';

const AUTO_FIX_CONFIG = `
auto_fix:
  enabled: true
  max_rounds: 1
  allow_review_autofix: true
`;

function oid(n: number): string {
  return n.toString(16).padStart(40, '0');
}

function pass(summary: string): StageReport {
  return { findings: [], summary };
}

function makeRoute(repoRoot: string): RepositoryPublicationRouteInput {
  return {
    actorId: 'U_1',
    actorLogin: 'owner',
    actorNodeId: 'U_node_1',
    backend: 'gh',
    backendVersion: '2.97.0',
    baseBranch: 'main',
    baseRepositoryId: '1',
    baseRepositoryName: 'owner/project',
    baseRepositoryNodeId: 'R_base',
    credentialSource: 'stored-account',
    forgeHost: 'github.com',
    headBranch: 'feature',
    headOwner: 'owner',
    headRepositoryId: '1',
    headRepositoryName: 'owner/project',
    headRepositoryNodeId: 'R_base',
    networkRootRepositoryId: '1',
    observedAt: '2026-08-30T12:00:00.000Z',
    repoRoot,
  };
}

test('verifyRetainedCompletionAttestation binds base commit validation to rebase disposition', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-attestation-base-'));
  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'));
  const runId = 'attestation-rebase-base-test';
  const intent = 'Verify rebased base commit validation in retained completion.';
  const policy = 'c'.repeat(64);
  const oldBase = oid(1);
  const rebasedBase = oid(2);
  const candidate = oid(3);

  try {
    const routeInput = makeRoute(temp);
    ledger.setRepositoryPublicationRoute(routeInput);
    const stages = ['intent', 'rebase', 'review', 'test', 'document', 'lint', 'push', 'pr'] as const;

    ledger.startRun({
      baseBranch: 'main',
      branch: 'feature',
      intent,
      policySha256: policy,
      repoRoot: temp,
      runId,
      stagePlan: stages.map((stageId) => ({ requirement: 'required', stageId })),
      submissionCommitOid: candidate,
    });
    const fingerprint = ledger.publicationRoute(runId)!.route_fingerprint;

    const generationToken = ledger.acquireLease({ branch: 'feature', repoRoot: temp, runId });

    const stageEntries: (StageEvidenceManifestEntry & { artifactPath: string })[] = [];

    for (const [round, stage] of stages.entries()) {
      const artifactPath = path.join(temp, `${stage}.json`);
      const artifactContent = JSON.stringify({ stage, status: 'ok' });
      await writeFile(artifactPath, artifactContent);
      const entryBase = stage === 'intent' ? oldBase : rebasedBase;
      const entry: StageEvidenceManifestEntry & { artifactPath: string } = {
        artifactPath,
        artifactSha256: sha256(artifactContent),
        baseCommitOid: entryBase,
        candidateCommitOid: candidate,
        evidenceSha256: '',
        exitCode: 0,
        round,
        stage,
        summary: `${stage} passed`,
        workerIdentity: 'reviewer:test',
      };
      entry.evidenceSha256 = evidenceSha256({ ...entry, runId });
      stageEntries.push(entry);

      if (stage !== 'push' && stage !== 'pr') {
        ledger.recordEvidence({
          artifactPath,
          artifactSha256: entry.artifactSha256,
          baseCommitOid: entryBase,
          candidateCommitOid: candidate,
          evidenceSha256: entry.evidenceSha256,
          exitCode: 0,
          roundIndex: round,
          runId,
          stageId: stage,
          summary: entry.summary,
          workerIdentity: entry.workerIdentity,
        });
        ledger.settleLocalStage({
          checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: round },
          evidenceSha256: entry.evidenceSha256,
          runId,
          stageId: stage,
        });
      }
    }

    const attemptId = 'attempt-1';
    ledger.startAttempt({
      actorIdentity: 'operator',
      attemptId,
      coordinatorIdentity: 'coordinator',
      generationToken,
      runId,
      startedAt: '2026-09-02T12:00:00.000Z',
    });

    ledger.recordPublicationBaseline({
      headCommitOid: null,
      observedAt: '2026-09-02T12:00:00.000Z',
      routeFingerprint: fingerprint,
      runId,
      transportUrl: 'github.com/owner/project',
    });

    const preRead = ledger.recordRemoteObservation({
      attemptId,
      kind: 'publication-head',
      observedAt: '2026-09-02T12:00:01.000Z',
      payload: {
        forgeHost: 'github.com',
        headBranch: 'feature',
        headOwner: 'owner',
        repositoryId: '1',
        state: 'absent',
      },
      runId,
      subject: 'github.com/1:refs/heads/feature',
    });

    const pushIntent = ledger.recordMutationIntent({
      attemptId,
      createdAt: '2026-09-02T12:00:02.000Z',
      kind: 'candidate-publication',
      payload: { expected: 'absent', update: candidate },
      runId,
      targetFingerprint: fingerprint,
    });

    const postRead = ledger.recordRemoteObservation({
      attemptId,
      kind: 'publication-head',
      observedAt: '2026-09-02T12:00:03.000Z',
      payload: {
        forgeHost: 'github.com',
        headBranch: 'feature',
        headOwner: 'owner',
        oid: candidate,
        repositoryId: '1',
      },
      runId,
      subject: 'github.com/1:refs/heads/feature',
    });

    const pushEntry = stageEntries.find((e) => e.stage === 'push')!;
    const pushReceipt = ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 6 },
      evidence: {
        artifactPath: pushEntry.artifactPath,
        artifactSha256: pushEntry.artifactSha256,
        baseCommitOid: rebasedBase,
        candidateCommitOid: candidate,
        evidenceSha256: pushEntry.evidenceSha256,
        exitCode: 0,
        roundIndex: 6,
        runId,
        stageId: 'push',
        summary: pushEntry.summary,
        workerIdentity: pushEntry.workerIdentity,
      },
      ownership: { branch: 'feature', generationToken, repoRoot: temp },
      receipt: {
        authoritativePostObservationSha256: postRead,
        candidateCommitOid: candidate,
        kind: 'candidate-publication',
        payload: {
          mutationIntent: pushIntent,
          outcome: 'created',
          postRead,
          preRead,
          routeFingerprint: fingerprint,
        },
      },
      runId,
      stageId: 'push',
    }).receiptSha256;

    const prIntent = ledger.recordMutationIntent({
      attemptId,
      createdAt: '2026-09-02T12:00:04.000Z',
      kind: 'pull-request',
      payload: {
        action: 'ensure-open',
        baseBranch: 'main',
        baseRepositoryId: '1',
        candidateCommitOid: candidate,
        forgeHost: 'github.com',
        headBranch: 'feature',
        headOwner: 'owner',
        headRepositoryId: '1',
      },
      runId,
      targetFingerprint: fingerprint,
    });
    const prObservation = ledger.recordRemoteObservation({
      attemptId,
      kind: 'pull-request',
      observedAt: '2026-09-02T12:00:05.000Z',
      payload: {
        baseBranch: 'main',
        baseRepositoryId: '1',
        candidateCommitOid: candidate,
        forgeHost: 'github.com',
        headBranch: 'feature',
        headOwner: 'owner',
        headRepositoryId: '1',
        number: 42,
        state: 'open',
      },
      runId,
      subject: 'github.com/1#42',
    });
    const prEntry = stageEntries.find((e) => e.stage === 'pr')!;
    const prReceipt = ledger.settleRemoteStage({
      checkpoint: { inputCommitOid: candidate, outputCommitOid: candidate, roundIndex: 7 },
      evidence: {
        artifactPath: prEntry.artifactPath,
        artifactSha256: prEntry.artifactSha256,
        baseCommitOid: rebasedBase,
        candidateCommitOid: candidate,
        evidenceSha256: prEntry.evidenceSha256,
        exitCode: 0,
        roundIndex: 7,
        runId,
        stageId: 'pr',
        summary: prEntry.summary,
        workerIdentity: prEntry.workerIdentity,
      },
      ownership: { branch: 'feature', generationToken, repoRoot: temp },
      receipt: {
        authoritativePostObservationSha256: prObservation,
        candidateCommitOid: candidate,
        kind: 'pull-request-binding',
        payload: {
          mutationIntent: prIntent,
          number: 42,
          outcome: 'created',
          postRead: prObservation,
          routeFingerprint: fingerprint,
        },
      },
      runId,
      stageId: 'pr',
    }).receiptSha256;

    ledger.recordStageDisposition({
      disposition: 'satisfied',
      evidenceSha256: prEntry.evidenceSha256,
      runId,
      stageId: 'pr',
    });

    const outcome = ledger.recordAttemptOutcome({
      actorIdentity: 'operator',
      attemptId,
      candidateCommitOid: candidate,
      completedAt: '2026-09-02T12:00:06.000Z',
      coordinatorIdentity: 'coordinator',
      custody: { recoveryRef: `refs/no-mistakes/recover/${runId}` },
      reason: 'pipeline completed',
      receiptDigests: [pushReceipt, prReceipt],
      resumeEligible: false,
      runId,
      stoppingFact: 'pull-request-bound',
      verdict: 'passed',
    });
    ledger.finishRun(runId, 'passed', candidate);

    const stageEvidence = stageEntries.map(({ artifactPath: _p, ...entry }) => entry);
    const manifest = buildPipelineCompletionAttestation(stageEvidence, {
      attemptOutcomeDigests: [outcome],
      baseCommitOid: rebasedBase,
      candidateCommitOid: candidate,
      candidatePublicationReceiptSha256: pushReceipt,
      custody: { recoveryRef: `refs/no-mistakes/recover/${runId}` },
      intent,
      policySha256: policy,
      publicationRoute: {
        baseBranch: routeInput.baseBranch,
        baseRepositoryId: routeInput.baseRepositoryId,
        forgeHost: routeInput.forgeHost,
        headBranch: routeInput.headBranch,
        headOwner: routeInput.headOwner,
        headRepositoryId: routeInput.headRepositoryId,
        routeFingerprint: fingerprint,
      },
      pullRequestBindingReceiptSha256: prReceipt,
      runId,
      stageDispositions: stageEvidence.map((entry) => ({
        disposition: 'satisfied',
        evidenceSha256: entry.evidenceSha256,
        stage: entry.stage,
      })),
      stagePlan: stages.map((stage) => ({ requirement: 'required', stage })),
    });

    assert.doesNotThrow(() => ledger.recordAttestation(manifest));
    assert.doesNotThrow(() => ledger.verifyRetainedCompletionAttestation(manifest));

    const tamperedManifest = buildPipelineCompletionAttestation(stageEvidence, {
      attemptOutcomeDigests: [outcome],
      baseCommitOid: oid(999),
      candidateCommitOid: candidate,
      candidatePublicationReceiptSha256: pushReceipt,
      custody: { recoveryRef: `refs/no-mistakes/recover/${runId}` },
      intent,
      policySha256: policy,
      publicationRoute: {
        baseBranch: routeInput.baseBranch,
        baseRepositoryId: routeInput.baseRepositoryId,
        forgeHost: routeInput.forgeHost,
        headBranch: routeInput.headBranch,
        headOwner: routeInput.headOwner,
        headRepositoryId: routeInput.headRepositoryId,
        routeFingerprint: fingerprint,
      },
      pullRequestBindingReceiptSha256: prReceipt,
      runId,
      stageDispositions: stageEvidence.map((entry) => ({
        disposition: 'satisfied',
        evidenceSha256: entry.evidenceSha256,
        stage: entry.stage,
      })),
      stagePlan: stages.map((stage) => ({ requirement: 'required', stage })),
    });
    assert.throws(
      () => ledger.verifyRetainedCompletionAttestation(tamperedManifest),
      /base commit evidence/,
    );
  } finally {
    ledger.close();
    await rm(temp, { force: true, recursive: true });
  }
});

class ChainGit implements GitOperations {
  readonly baseOid = oid(100);
  headOid: string;
  readonly root: string;
  readonly trustedConfig: string;
  readonly fixerHead?: string;

  constructor(
    root: string,
    headOid: string,
    trustedConfig = '',
    fixerHead?: string,
  ) {
    this.root = root;
    this.headOid = headOid;
    this.trustedConfig = trustedConfig;
    this.fixerHead = fixerHead;
  }

  async assertReady() {
    return {
      base: 'main',
      baseOid: this.baseOid,
      branch: 'feature',
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
    return '';
  }

  async rebase(): Promise<StageReport> {
    return { ...pass('rebased'), rebaseUpstreamHead: this.baseOid };
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
    return 'f'.repeat(64);
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

class ChainOrca implements OrcaOperations {
  readonly runId: string;
  readonly launches: WorkerLaunch[] = [];
  reviewReports: StageReport[] = [];
  gateDecision = 'approve';
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
      launch.role === 'reviewer' ? this.reviewReports.shift() : undefined;
    const dispatchId = `dispatch-${++this.#dispatch}`;
    return {
      dispatchId,
      report: withLivePass(launch, queued ?? pass(`${launch.stage} ${launch.role} passed`)),
      taskId,
      terminalHandle: `term-${dispatchId}`,
      worktreeId: launch.worktree === 'new-child' ? dispatchId : undefined,
      worktreePath:
        launch.worktree === 'new-child'
          ? path.join(this.runId, dispatchId)
          : undefined,
    };
  }

  async finishWorker(worker: WorkerResult): Promise<void> {
    worker.shutdownConfirmed = true;
  }

  async removeWorktree(): Promise<void> {}

  async completeTask(): Promise<void> {}

  async createGate(): Promise<string> {
    return 'gate-1';
  }

  async waitForGate(): Promise<string> {
    return this.gateDecision;
  }

  async setWorktreeStatus(): Promise<void> {}
}

test('settleLocalStage settles checkpoint round from authoritative evidence when diagnostic approved', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'onm-diagnostic-round-'));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  });
  process.env.ORCA_NO_MISTAKES_HOME = root;
  const runId = 'diagnostic-round-settlement-test';
  const intent = 'Verify diagnostic round approval settles authoritative round.';
  const submission = oid(1);
  const ledger = new DomainLedger(':memory:');
  const authority = {} as GithubAuthority;

  const finding: Finding = {
    action: 'auto-fix',
    description: 'Review issue to fix.',
    id: 'review-finding-1',
    severity: 'error',
  };

  try {
    const git = new ChainGit(root, submission, AUTO_FIX_CONFIG);
    const orca = new ChainOrca(runId);
    orca.reviewReports = [
      { findings: [finding], summary: 'review found findings' },
    ];

    await assert.rejects(
      runPipeline(
        {
          githubAuthority: authority,
          intent,
          publicationDestination: 'https://github.com/owner/repo.git',
        },
        orca,
        git,
        ledger,
      ),
      /no publication route/,
    );

    const checkpoints = ledger.listCheckpoints(runId);
    const reviewCheckpoint = checkpoints.find((cp) => cp.stage_id === 'review');
    assert.ok(reviewCheckpoint, 'review checkpoint must exist');
    assert.equal(
      reviewCheckpoint.round_index,
      0,
      'final review checkpoint round must match authoritative reviewer round 0, not incremented fixer round 1',
    );

    const disposition = ledger.stageDispositions(runId).find((d) => d.stage_id === 'review');
    assert.ok(disposition, 'review disposition must exist');
    const evidence = ledger.listEvidence(runId).find((e) => e.evidence_sha256 === disposition.evidence_sha256);
    assert.ok(evidence, 'evidence must exist');
    assert.equal(
      evidence.round_index,
      reviewCheckpoint.round_index,
      'evidence round_index and final checkpoint round_index must match',
    );
  } finally {
    ledger.close();
  }
});
