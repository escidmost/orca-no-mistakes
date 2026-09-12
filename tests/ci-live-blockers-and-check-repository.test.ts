import assert from "node:assert/strict";
import test from "node:test";

import { DomainLedger } from "../scripts/ledger.ts";
import { PlainStatusRenderer, PresentationPublisher } from "../scripts/presentation.ts";
import { GithubAuthority, type CommandRunner } from "../scripts/github.ts";
import { reconcileReportWithPreservedDispositions, type StageName } from "../scripts/orca-no-mistakes.ts";

const commit = "a".repeat(40);
const policy = "b".repeat(64);
const blocker = { id: "ci-check", description: "build failed", severity: "error" as const };
const other = { id: "ci-repair-failed", description: "repair failed", severity: "error" as const };

function selectiveFixGate(stage: StageName) {
  const ledger = new DomainLedger(":memory:");
  let second = 0;
  ledger.startRun({ baseBranch: "main", branch: "feature", intent: "Gate live blockers.",
    policySha256: policy, repoRoot: "/repo", runId: "run", submissionCommitOid: commit });
  const publisher = new PresentationPublisher(ledger, "run",
    new PlainStatusRenderer({ write: () => {} }),
    () => new Date(Date.UTC(2026, 0, 1, 0, 0, second++)));
  publisher.publish(`stage:${stage}:started`, { kind: "stage-started", stage });
  publisher.publish(`findings:${stage}`, { actionable: 2, findings: [blocker, other],
    kind: "findings-recorded", round: 1, stage, total: 2 });
  publisher.publish(`gate:${stage}:resolved`, { decision: "fix", gateId: `gate-${stage}`,
    kind: "gate-resolved", round: 1, stage, targetFindingIds: [other.id] });
  const report = reconcileReportWithPreservedDispositions(
    { findings: [{ ...blocker, action: "ask-user" as const }], summary: "still failing" },
    stage, publisher);
  ledger.close?.();
  return report.findings[0].action;
}

test("a selective fix cannot implicitly approve a live CI blocker", () => {
  assert.equal(selectiveFixGate("ci"), "ask-user");
  assert.equal(selectiveFixGate("review"), "no-op");
});

test("check observations carry the repository that owns the check", async () => {
  const checkRun = (repository: unknown) => ({ __typename: "CheckRun", id: "CR_1", databaseId: "1",
    checkSuite: { app: { id: "APP", databaseId: "15368", slug: "github-actions" }, ...(repository === undefined ? {} : { repository }) },
    conclusion: "FAILURE", detailsUrl: null, name: "build", status: "COMPLETED" });
  const observe = async (repository: unknown) => {
    const runner: CommandRunner = async (exe, args, options) => {
      if (exe === "gh" && args[0] === "--version") return { code: 0, stdout: "gh test", stderr: "" };
      if (exe === "gh-axi") return { code: 127, stdout: "", stderr: "" };
      assert.match(String(options.input), /repository \{ nameWithOwner \}/);
      return { code: 0, stderr: "", stdout: JSON.stringify({ data: { node: {
        baseRef: { target: { oid: "b".repeat(40) } }, headRefOid: commit, isDraft: false,
        mergeable: "MERGEABLE", number: 1, state: "OPEN",
        commits: { nodes: [{ commit: { oid: commit, statusCheckRollup: { contexts: {
          nodes: [checkRun(repository)], pageInfo: { endCursor: null, hasNextPage: false } } } } }] } } } }) };
    };
    const api = await GithubAuthority.connect({ runner, maxReadAttempts: 1 });
    return (await api.observePullRequestChecks("PR_1")).checks[0];
  };
  assert.equal((await observe({ nameWithOwner: "base-owner/repo" })).repository, "base-owner/repo");
  assert.equal((await observe(undefined)).repository, undefined);
});
