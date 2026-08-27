import assert from "node:assert/strict";
import test from "node:test";

import { findingDecisionHistoryPrompt } from "../scripts/orca-no-mistakes.ts";
import type { FindingDecisionRow } from "../scripts/ledger.ts";

const finding = (id: string, description = id) => ({
  action: "ask-user" as const,
  description,
  id,
  severity: "warning" as const,
});

const row = (
  runId: string,
  findings: unknown,
  selected: unknown,
  decision = "approve",
): FindingDecisionRow => ({
  decision,
  findings_json: JSON.stringify(findings),
  round_index: 0,
  run_id: runId,
  selected_finding_ids: JSON.stringify(selected),
  stage_id: "review",
});

test("later fixes supersede earlier declines", () => {
  const prompt = findingDecisionHistoryPrompt(
    [
      row("run-1", [finding("a", "old decline")], []),
      row("run-2", [finding("a", "changed finding")], ["a"], "fix"),
    ],
    false,
  );

  assert.equal(prompt, "");
});

test("malformed and unresolved history cannot become declines", () => {
  const malformed = [
    row("run-1", [finding("a")], [1]),
    row("run-2", [{ ...finding("b"), action: "unexpected" }], []),
    row("run-3", [finding("c")], ["missing"], "fix"),
    row("run-4", [finding("d")], [], "fix"),
  ];

  const prompt = findingDecisionHistoryPrompt(malformed, false);
  assert.doesNotMatch(prompt, /"declined":\[/);
  assert.match(prompt, /stored evidence was invalid/);
});

test("decision history retains newest valid entries within a byte budget", () => {
  const prompt = findingDecisionHistoryPrompt(
    [
      row("run-1", [finding("oversized", "x".repeat(100_000))], []),
      row("run-2", [finding("newest", "retain this decline")], []),
    ],
    false,
  );

  assert.match(prompt, /newest/);
  assert.doesNotMatch(prompt, /\"id\":\"oversized\"/);
  assert.match(prompt, /omitted to bound prompt size/);
  assert.ok(Buffer.byteLength(prompt) < 20_000);
});
