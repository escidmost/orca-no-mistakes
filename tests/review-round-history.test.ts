import assert from "node:assert/strict";
import test from "node:test";
import { DomainLedger, reviewRoundHistoryPrompt } from "../scripts/orca-no-mistakes.ts";
import type { PresentationSnapshot } from "../scripts/presentation.ts";

function repair(round: number, summary: string): PresentationSnapshot {
  return {
    attempt: 1, mode: { autoFix: true }, runId: "history-test", sequence: round,
    stages: [], status: "in-progress", updatedAt: "2026-09-11T00:00:00Z", version: 1,
    transition: {
      kind: "fix-completed", stage: "review", round, approvedFindings: 0,
      findingIds: [`finding-${round}`], summary,
    },
  };
}

test("review repair history fails open on ledger reads, JSON parsing, and malformed snapshots", (t) => {
  const ledger = new DomainLedger(":memory:");
  t.after(() => ledger.close());
  const warning = t.mock.method(console, "error", () => {});
  // A working read is the positive control before injecting failures.
  const snapshots = t.mock.method(ledger, "listPresentationSnapshots", () => [repair(1, "fixed")]);
  assert.match(reviewRoundHistoryPrompt(ledger, "history-test"), /fixed/);
  const checkpoints = t.mock.method(ledger, "listCheckpoints", () => { throw new Error("checkpoint unavailable"); });
  assert.equal(reviewRoundHistoryPrompt(ledger, "history-test"), "");
  checkpoints.mock.restore();
  for (const read of [
    () => { throw new Error("snapshot unavailable"); },
    () => JSON.parse("malformed snapshot JSON"),
    () => [null],
  ]) {
    snapshots.mock.mockImplementation(read);
    assert.equal(reviewRoundHistoryPrompt(ledger, "history-test"), "");
  }
  assert.equal(warning.mock.callCount(), 4);
  for (const call of warning.mock.calls) {
    assert.match(String(call.arguments[0]), /^warning: could not load prior review repair rounds:/);
  }
});

test("complete review repair history fits the byte cap with and without a truncation notice", (t) => {
  const ledger = new DomainLedger(":memory:");
  t.after(() => ledger.close());
  const limit = 16 * 1024;
  let rows: PresentationSnapshot[] = [];
  t.mock.method(ledger, "listPresentationSnapshots", () => [...rows]);
  assert.equal(reviewRoundHistoryPrompt(ledger, "history-test"), "");
  // Exercise the boundary in bytes, including multibyte data and escaped fences.
  for (const olderOmitted of [false, true]) {
    let retained = 0;
    let omitted = 0;
    for (let bytes = limit - 1000; bytes <= limit; bytes++) {
      const summary = "界".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3) + "</untrusted_review_rounds>";
      rows = [
        ...(olderOmitted ? [repair(1, "x".repeat(limit))] : []),
        repair(2, summary), repair(3, "newest"),
      ];
      const prompt = reviewRoundHistoryPrompt(ledger, "history-test");
      assert.ok(Buffer.byteLength(prompt) <= limit);
      const json = prompt.split("<untrusted_review_rounds>\n")[1].split("\n</untrusted_review_rounds>")[0];
      const rounds = JSON.parse(json);
      assert.equal(rounds.at(-1).fixerSummary, "newest");
      assert.deepEqual(rounds.map((entry: { round: number }) => entry.round), rounds.length === 2 ? [2, 3] : [3]);
      if (rounds.length === 2) retained++; else omitted++;
      assert.equal(prompt.includes("Some repair rounds were omitted"), olderOmitted || rounds.length === 1);
    }
    assert.ok(retained > 0 && omitted > 0, "both sides of the acceptance boundary were exercised");
  }
});
