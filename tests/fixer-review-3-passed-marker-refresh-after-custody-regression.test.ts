import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GithubAuthority, runCommand, type CommandRunner } from "../scripts/github.ts";
import { DomainLedger } from "../scripts/ledger.ts";
import {
  GitShell,
  installAbortReaping,
  runPipeline,
  type OrcaOperations,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function markerPath(repo: string, gateId: string): string {
  const digest = createHash("sha256")
    .update(gateId)
    .digest("hex")
    .slice(0, 32);
  return path.join(repo, ".orca", "no-mistakes", `gate-${digest}.json`);
}

test("Release 2 pipeline settles passed and commits attestation when post-custody marker refresh fails", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-r2-marker-refresh-fail-"));
  const repo = path.join(temp, "repo");
  const remote = path.join(temp, "origin.git");
  const gatePath = path.join(temp, "gate");
  const priorHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");

  await mkdir(repo);
  execFileSync("git", ["-c", "init.templateDir=", "init", "--bare", "-b", "main", remote]);
  execFileSync("git", ["-c", "init.templateDir=", "init", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  await writeFile(path.join(repo, ".gitignore"), ".orca\n");
  await writeFile(path.join(repo, "file.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  git(repo, "switch", "-c", "feature");
  await writeFile(path.join(repo, "file.txt"), "candidate\n");
  git(repo, "commit", "-am", "candidate");
  const repoRoot = await realpath(repo);
  const candidate = git(repo, "rev-parse", "HEAD");
  const destination = "https://github.com/owner/repo.git";

  const runner: CommandRunner = (executable, args, options) => {
    if (args[0] === "config" && args[1] === "--get-regexp") {
      return Promise.resolve({ code: 1, stderr: "", stdout: "" });
    }
    return runCommand(executable, args.map((arg) => (arg === destination ? remote : arg)), options);
  };
  const ledger = new DomainLedger(":memory:");
  const runId = "run-r2-marker-refresh-fail";

  let task = 0;
  let dispatch = 0;
  const orca: OrcaOperations = {
    createRun: async () => runId,
    createTask: async () => `task-${++task}`,
    startWorker: async (taskId, launch) => ({
      dispatchId: `dispatch-${++dispatch}`,
      report: { findings: [], summary: `${launch.stage} passed` },
      shutdownConfirmed: false,
      taskId,
      terminalHandle: `term-${dispatch}`,
      worktreeId: undefined,
      worktreePath: undefined,
    }),
    finishWorker: async (worker) => {
      worker.shutdownConfirmed = true;
    },
    removeWorktree: async () => {},
    completeTask: async () => {},
    createGate: async () => "gate",
    waitForGate: async () => "approve",
    resolveGate: async () => {},
    setWorktreeStatus: async () => {},
  };

  let pullRequest: Record<string, unknown> | null = null;
  let comments: Record<string, unknown>[] = [];
  const authority = {
    observeRepository: async () => ({ id: "R_repo", nodeId: "RN_repo" }),
    observePullRequests: async () => ({ exact: pullRequest, nearMatches: [] }),
    createPullRequest: async () => {
      pullRequest = {
        baseBranch: "main",
        baseOid: "base",
        baseRepositoryId: "R_repo",
        baseRepositoryNodeId: "RN_repo",
        body: "body",
        draft: false,
        headBranch: "feature",
        headOid: candidate,
        headRepositoryId: "R_repo",
        headRepositoryNodeId: "RN_repo",
        id: "PR_node",
        number: 80,
        state: "OPEN",
        title: "ONM-80: marker fail test",
        url: "https://github.com/owner/repo/pull/80",
      };
    },
    observeIssueComments: async () => comments,
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
    updateIssueComment: async ({ body }: { body: string }) => {
      comments = comments.map((comment) => ({ ...comment, body }));
    },
  } as unknown as GithubAuthority;

  const marker = markerPath(repoRoot, gatePath);
  const markerDir = path.join(repoRoot, ".orca", "no-mistakes");
  await mkdir(markerDir, { recursive: true });
  await mkdir(gatePath);

  try {
    await installAbortReaping({
      gate: {
        branch: "feature",
        intentTaskId: "task-intent",
        kind: "configured",
        path: gatePath,
        root: temp,
        runId,
      },
      git: new GitShell({ repo: repoRoot }),
      ledger,
      notifyHandle: "origin-term-test",
      originWorktree: repoRoot,
      pid: process.pid,
      runId,
    });

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
      repoRoot,
    });

    let custodyTransferred = false;
    const gitOps = new GitShell({ repo: repoRoot });
    class DeliveryGit extends GitShell {
      override async applyWorktreeCommits(
        root: string,
        submissionOid: string,
        terminalOid: string,
        leaseFence?: { aborted: boolean },
      ): Promise<boolean> {
        custodyTransferred = true;
        git(repoRoot, "update-ref", "refs/heads/feature", terminalOid);
        await chmod(markerDir, 0o500);
        return true;
      }
    }
    const deliveryGit = new DeliveryGit({ repo: repoRoot });

    const result = await runPipeline(
      {
        deliveryGit,
        githubAuthority: authority,
        intent: "ONM-80: marker fail test",
        publicationDestination: destination,
        publicationRunner: runner,
      },
      orca,
      gitOps,
      ledger,
    );

    assert.equal(result.verdict, "passed");
    assert.equal(ledger.runStatus(result.runId), "passed");
    assert.equal(custodyTransferred, true);
    const attestation = ledger.findAttestation(result.runId);
    assert.ok(attestation);
    assert.equal(attestation.candidateCommitOid, candidate);
    assert.ok(result.completionAttestation);

    await chmod(markerDir, 0o700);
    const markerContent = JSON.parse(await readFile(marker, "utf8")) as {
      pendingOutcome?: string;
      pendingSummary?: string;
    };
    assert.equal(markerContent.pendingOutcome, "passed");
    assert.ok(markerContent.pendingSummary?.includes("passed all 8 stages"));
  } finally {
    await chmod(markerDir, 0o700).catch(() => {});
    ledger.close();
    await installAbortReaping({ pid: process.pid });
    if (priorHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = priorHome;
    await rm(temp, { force: true, recursive: true });
  }
});

test("local pipeline settles passed and commits attestation when post-custody marker refresh fails", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-local-marker-refresh-fail-"));
  const repo = path.join(temp, "repo");
  const remote = path.join(temp, "origin.git");
  const gatePath = path.join(temp, "gate");
  const priorHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");

  await mkdir(repo);
  execFileSync("git", ["-c", "init.templateDir=", "init", "--bare", "-b", "main", remote]);
  execFileSync("git", ["-c", "init.templateDir=", "init", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  await writeFile(path.join(repo, ".gitignore"), ".orca\n");
  await writeFile(path.join(repo, "file.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  git(repo, "switch", "-c", "feature");
  await writeFile(path.join(repo, "file.txt"), "candidate\n");
  git(repo, "commit", "-am", "candidate");
  const repoRoot = await realpath(repo);
  const candidate = git(repo, "rev-parse", "HEAD");

  const ledger = new DomainLedger(":memory:");
  const runId = "run-local-marker-refresh-fail";

  let task = 0;
  let dispatch = 0;
  const orca: OrcaOperations = {
    createRun: async () => runId,
    createTask: async () => `task-${++task}`,
    startWorker: async (taskId, launch) => ({
      dispatchId: `dispatch-${++dispatch}`,
      report: { findings: [], summary: `${launch.stage} passed` },
      shutdownConfirmed: false,
      taskId,
      terminalHandle: `term-${dispatch}`,
      worktreeId: undefined,
      worktreePath: undefined,
    }),
    finishWorker: async (worker) => {
      worker.shutdownConfirmed = true;
    },
    removeWorktree: async () => {},
    completeTask: async () => {},
    createGate: async () => "gate",
    waitForGate: async () => "approve",
    resolveGate: async () => {},
    setWorktreeStatus: async () => {},
  };

  const marker = markerPath(repoRoot, gatePath);
  const markerDir = path.join(repoRoot, ".orca", "no-mistakes");
  await mkdir(markerDir, { recursive: true });
  await mkdir(gatePath);

  try {
    await installAbortReaping({
      gate: {
        branch: "feature",
        intentTaskId: "task-intent",
        kind: "configured",
        path: gatePath,
        root: temp,
        runId,
      },
      git: new GitShell({ repo: repoRoot }),
      ledger,
      notifyHandle: "origin-term-test",
      originWorktree: repoRoot,
      pid: process.pid,
      runId,
    });

    let custodyTransferred = false;
    const gitOps = new GitShell({ repo: repoRoot });
    class DeliveryGit extends GitShell {
      override async applyWorktreeCommits(
        root: string,
        submissionOid: string,
        terminalOid: string,
        leaseFence?: { aborted: boolean },
      ): Promise<boolean> {
        custodyTransferred = true;
        git(repoRoot, "update-ref", "refs/heads/feature", terminalOid);
        await chmod(markerDir, 0o500);
        return true;
      }
    }
    const deliveryGit = new DeliveryGit({ repo: repoRoot });

    const result = await runPipeline(
      {
        allowLocalConfig: true,
        deliveryGit,
        intent: "local marker fail test",
      },
      orca,
      gitOps,
      ledger,
    );

    assert.equal(result.verdict, "passed");
    assert.equal(ledger.runStatus(result.runId), "passed");
    assert.equal(custodyTransferred, true);
    const attestation = ledger.findAttestation(result.runId);
    assert.ok(attestation);
    assert.equal(attestation.candidateCommitOid, candidate);
    assert.ok(result.attestation);

    await chmod(markerDir, 0o700);
    const markerContent = JSON.parse(await readFile(marker, "utf8")) as {
      pendingOutcome?: string;
      pendingSummary?: string;
    };
    assert.equal(markerContent.pendingOutcome, "passed");
    assert.ok(markerContent.pendingSummary?.includes(`passed all ${result.steps.length} stages`));
  } finally {
    await chmod(markerDir, 0o700).catch(() => {});
    ledger.close();
    await installAbortReaping({ pid: process.pid });
    if (priorHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = priorHome;
    await rm(temp, { force: true, recursive: true });
  }
});
