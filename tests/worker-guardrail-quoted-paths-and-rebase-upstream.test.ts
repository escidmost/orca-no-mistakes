import assert from "node:assert/strict";
import { withLivePass } from './live-validation-fixture.ts';
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GitShell,
  runPipeline,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("quote-split workspace validation paths remain protected", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-quoted-workspace-"));
  const repo = path.join(temp, "repo");
  const worker = path.join(temp, "worker");
  try {
    await mkdir(path.join(repo, ".github/workflows"), { recursive: true });
    await mkdir(path.join(repo, "scripts"));
    git(repo, "-c", "init.templateDir=", "init", "-b", "feature");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "core.hooksPath", "/dev/null");
    git(repo, "config", "commit.gpgsign", "false");
    await writeFile(
      path.join(repo, ".github/workflows/ci.yml"),
      `steps:
  - run: '"\${{ github.workspace }}"/scripts/direct.sh'
  - run: 'cd "$GITHUB_WORKSPACE"/scripts && ./indirect.sh'
`,
    );
    await writeFile(path.join(repo, "scripts/direct.sh"), "exit 1\n");
    await writeFile(path.join(repo, "scripts/indirect.sh"), "exit 1\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "validation commands");
    const expectedHead = git(repo, "rev-parse", "HEAD");

    git(repo, "worktree", "add", "--detach", worker, expectedHead);
    await writeFile(path.join(worker, "scripts/direct.sh"), "exit 0\n");
    await writeFile(path.join(worker, "scripts/indirect.sh"), "exit 0\n");
    git(worker, "add", "scripts");
    git(worker, "commit", "-m", "weaken validation");

    await assert.rejects(
      new GitShell({ repo }).assertFixerChangesAllowed(
        worker,
        expectedHead,
        git(worker, "rev-parse", "HEAD"),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /scripts\/direct\.sh/);
        assert.match(error.message, /scripts\/indirect\.sh/);
        return true;
      },
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("each rebase attempt records its reported upstream", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-rebase-evidence-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = temp;
  const originalBase = "c".repeat(40);
  const firstUpstream = "a".repeat(40);
  const secondUpstream = "b".repeat(40);
  let head = "1".repeat(40);
  const upstreams = [firstUpstream, secondUpstream];
  const pass = (summary: string): StageReport => ({ findings: [], summary });
  const gitOperations: GitOperations = {
    async assertReady() {
      return {
        base: "main",
        baseOid: originalBase,
        branch: "feature",
        head,
        root: temp,
      };
    },
    async assertClean() {},
    async assertFixerChangesAllowed() {
      return { changed: true, guardrailViolations: [] };
    },
    async head() {
      return head;
    },
    async diffBase() {
      return "";
    },
    async rebase() {
      const upstream = upstreams.shift();
      assert.ok(upstream);
      if (upstream === firstUpstream) {
        return {
          findings: [
            {
              action: "ask-user",
              description: "conflict",
              id: "rebase-conflict",
              severity: "error",
            },
          ],
          rebaseUpstreamHead: upstream,
          summary: "rebase conflict",
        };
      }
      head = "2".repeat(40);
      return { ...pass("rebased"), rebaseUpstreamHead: upstream };
    },
    async resolveRefSha() {
      return undefined;
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
      return originalBase;
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
  };
  let task = 0;
  let dispatch = 0;
  const runId = "rebase-attempt-provenance";
  const orca: OrcaOperations = {
    async createRun() {
      return runId;
    },
    async createTask() {
      return `task-${++task}`;
    },
    async startWorker(taskId, launch) {
      const id = `dispatch-${++dispatch}`;
      return {
        dispatchId: id,
        report: withLivePass(launch, pass(launch.stage)),
        taskId,
        worktreeId: launch.worktree === "new-child" ? id : undefined,
        worktreePath:
          launch.worktree === "new-child" ? path.join(temp, id) : undefined,
      };
    },
    async finishWorker() {},
    async removeWorktree() {},
    async completeTask() {},
    async createGate(_taskId, _question, options) {
      assert.deepEqual(options, ["fix", "stop"]);
      return "gate-1";
    },
    async waitForGate() {
      return "fix";
    },
    async setWorktreeStatus() {},
  };

  try {
    const result = await runPipeline(
      { allowLocalConfig: true, intent: "Record each rebase attempt." },
      orca,
      gitOperations,
    );
    const failedAttempt = result.attestation?.stageEvidence.find(
      (entry) => entry.summary === "rebase conflict",
    );
    const successfulAttempt = result.attestation?.stageEvidence.find(
      (entry) => entry.summary === "rebased",
    );
    assert.equal(failedAttempt?.baseCommitOid, firstUpstream);
    assert.equal(successfulAttempt?.baseCommitOid, secondUpstream);
    assert.equal(result.attestation?.baseCommitOid, secondUpstream);

    const logs = await Promise.all(
      (await readdir(path.join(temp, "artifacts", runId, "logs"))).map(
        async (file) =>
          JSON.parse(
            await readFile(
              path.join(temp, "artifacts", runId, "logs", file),
              "utf8",
            ),
          ) as Record<string, unknown>,
      ),
    );
    assert.equal(
      logs.find((entry) => entry.summary === "rebase conflict")
        ?.rebaseUpstreamHead,
      firstUpstream,
    );
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});
