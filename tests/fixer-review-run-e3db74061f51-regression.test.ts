import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DomainLedger } from "../scripts/ledger.ts";
import {
  runPipeline,
  type GitOperations,
  type OrcaOperations,
  type StageReport,
} from "../scripts/orca-no-mistakes.ts";

test("advisory fixer violations create a resolved guardrail audit", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-advisory-audit-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = temp;
  const ledger = new DomainLedger(":memory:");
  const runId = "advisory-audit-run";
  const base = "b".repeat(40);
  const workerHead = "c".repeat(40);
  let head = "a".repeat(40);
  let task = 0;
  let dispatch = 0;
  let gates = 0;
  const pass = (summary: string): StageReport => ({ findings: [], summary });
  const reviewReports: StageReport[] = [
    {
      findings: [
        {
          action: "auto-fix",
          description: "Repair implementation.",
          id: "review-finding",
          severity: "error",
        },
      ],
      summary: "review finding",
    },
    pass("fix committed"),
    pass("clean review"),
  ];
  const violation =
    "fixer modified pre-existing test files: tests/existing.test.ts";
  const orca: OrcaOperations = {
    async createRun() {
      return runId;
    },
    async createTask() {
      return `task-${++task}`;
    },
    async startWorker(taskId, launch) {
      const id = `dispatch-${++dispatch}`;
      const report =
        launch.stage === "review"
          ? (reviewReports.shift() ?? pass("review"))
          : pass(launch.stage);
      return {
        dispatchId: id,
        report,
        taskId,
        worktreePath:
          launch.worktree === "new-child" ? path.join(temp, id) : undefined,
      };
    },
    async finishWorker() {},
    async removeWorktree() {},
    async completeTask() {},
    async createGate() {
      gates += 1;
      return `gate-${gates}`;
    },
    async waitForGate() {
      return "approve";
    },
    async setWorktreeStatus() {},
  };
  const git: GitOperations = {
    async assertReady() {
      return { base: "main", baseOid: base, branch: "feature", head, root: temp };
    },
    async assertClean() {},
    async assertFixerChangesAllowed() {
      return { changed: true, guardrailViolations: [violation] };
    },
    async head() {
      return head;
    },
    async diffBase() {
      return "";
    },
    async rebase() {
      return { ...pass("rebased"), rebaseUpstreamHead: base };
    },
    async resolveRefSha() {
      return base;
    },
    async showFile() {
      return "auto_fix:\n  allow_review_autofix: true\n  guardrails: advisory\n";
    },
    async pathExists() {
      return true;
    },
    async policySha256() {
      return "d".repeat(64);
    },
    async resolveBaseOid() {
      return base;
    },
    async applyWorktreeCommits() {
      head = workerHead;
      return true;
    },
    async headOf() {
      return workerHead;
    },
    async worktreeIsReusable() {
      return false;
    },
    async anchorRecoveryRef() {},
  };

  try {
    await runPipeline({ intent: "Record advisory guardrail changes." }, orca, git, ledger);

    assert.equal(gates, 0);
    const audits = ledger.listGateAudit(runId);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].gate_kind, "guardrail");
    assert.equal(audits[0].decision, "advisory");
    assert.match(audits[0].question, /^\[guardrails: advisory\]/);
    assert.ok(audits[0].resolved_at);
    assert.deepEqual(JSON.parse(audits[0].resolution), [violation]);
  } finally {
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});
