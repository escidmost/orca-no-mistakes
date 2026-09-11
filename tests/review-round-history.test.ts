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

test("review history preserves JSON summaries containing every untrusted delimiter", (t) => {
  const ledger = new DomainLedger(":memory:");
  t.after(() => ledger.close());
  let summary = "";
  t.mock.method(ledger, "listPresentationSnapshots", () => [repair(1, summary)]);
  for (const name of ["review_rounds", "branch_diff", "instruction", "finding_decisions"]) {
    summary = `"quoted" \\ <untrusted_${name}>界</untrusted_${name}> <ordinary>`;
    const prompt = reviewRoundHistoryPrompt(ledger, "history-test");
    const json = prompt.split("<untrusted_review_rounds>\n")[1].split("\n</untrusted_review_rounds>")[0];
    assert.equal(JSON.parse(json)[0].fixerSummary, summary);
    assert.ok(!json.includes(`<untrusted_${name}>`));
    assert.ok(!json.includes(`</untrusted_${name}>`));
    assert.ok(json.includes(`\\u003cuntrusted_${name}>`));
    assert.ok(json.includes(`\\u003c/untrusted_${name}>`));
    assert.ok(json.includes("<ordinary>"));
    assert.equal(prompt.split("<untrusted_review_rounds>").length, 2);
    assert.equal(prompt.split("</untrusted_review_rounds>").length, 2);
  }
});

test("exact-fit review history reserves notice only after an omission", (t) => {
  const ledger = new DomainLedger(":memory:");
  t.after(() => ledger.close());
  const limit = 16 * 1024;
  let rows = [repair(2, "")];
  t.mock.method(ledger, "listPresentationSnapshots", () => [...rows]);
  const padding = "x".repeat(limit - Buffer.byteLength(reviewRoundHistoryPrompt(ledger, "history-test")));
  rows = [repair(2, padding)];
  const exact = reviewRoundHistoryPrompt(ledger, "history-test");
  assert.equal(Buffer.byteLength(exact), limit);
  assert.ok(exact.includes(padding));
  assert.ok(!exact.includes("Some repair rounds were omitted"));

  // An oversized older round requires a notice, so the sole retained round must go.
  rows.unshift(repair(1, "x".repeat(limit)));
  const empty = reviewRoundHistoryPrompt(ledger, "history-test");
  assert.match(empty, /\n\[\]\n/);
  assert.match(empty, /Some repair rounds were omitted/);
  assert.ok(Buffer.byteLength(empty) <= limit);

  // When two rounds fit exactly, make room for the notice by removing the older one.
  rows = [repair(2, ""), repair(3, "newest")];
  rows[0] = repair(2, "x".repeat(limit - Buffer.byteLength(reviewRoundHistoryPrompt(ledger, "history-test"))));
  assert.equal(Buffer.byteLength(reviewRoundHistoryPrompt(ledger, "history-test")), limit);
  rows.unshift(repair(1, "x".repeat(limit)));
  const trimmed = reviewRoundHistoryPrompt(ledger, "history-test");
  assert.ok(Buffer.byteLength(trimmed) <= limit);
  assert.ok(trimmed.includes('"round":3'));
  assert.ok(!trimmed.includes('"round":2'));
  assert.match(trimmed, /Some repair rounds were omitted/);
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
