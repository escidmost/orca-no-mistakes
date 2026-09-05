import assert from "node:assert/strict";
import test from "node:test";

import {
  findingDecisionHistoryPrompt,
  selectedFindingIdsForGate,
} from "../scripts/orca-no-mistakes.ts";
import type { Finding } from "../scripts/orca-no-mistakes.ts";
import type { FindingDecisionRow } from "../scripts/ledger.ts";

const finding = (id: string, description: string): Finding => ({
  action: "ask-user",
  description,
  id,
  severity: "warning",
});

const row = (
  runId: string,
  stage: FindingDecisionRow["stage_id"],
  findings: Finding[],
  selected: string[],
  decision = "approve",
): FindingDecisionRow => ({
  decision,
  findings_json: JSON.stringify(findings),
  round_index: 0,
  run_id: runId,
  selected_finding_ids: JSON.stringify(selected),
  stage_id: stage,
});

test("unoffered decisions have no selected finding provenance", () => {
  const decision = {
    action: "approve" as const,
    guidance: "",
    selectedFindings: [],
  };

  assert.equal(selectedFindingIdsForGate(decision, ["fix", "stop"]), undefined);
  assert.deepEqual(
    selectedFindingIdsForGate(decision, ["approve", "fix", "skip", "stop"]),
    [],
  );
});

test("duplicate IDs remain grouped and supersession is stage-scoped", () => {
  const prompt = findingDecisionHistoryPrompt(
    [
      row(
        "run-1",
        "review",
        [finding("shared", "review first"), finding("shared", "review second")],
        [],
      ),
      row("run-1", "test", [finding("shared", "test decline")], []),
      row(
        "run-2",
        "test",
        [finding("shared", "test first"), finding("shared", "test second")],
        ["shared", "shared"],
        "fix",
      ),
    ],
    false,
  );

  assert.match(prompt, /review first/);
  assert.match(prompt, /review second/);
  assert.doesNotMatch(prompt, /test decline/);
  assert.doesNotMatch(prompt, /stored evidence was invalid/);
});
