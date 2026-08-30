import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { DomainLedger } from "../scripts/ledger.ts";
import {
  PlainStatusRenderer,
  PresentationPublisher,
  type PresentationSnapshot,
} from "../scripts/presentation.ts";

const commit = "a".repeat(40);
const policy = "b".repeat(64);

function startRun(ledger: DomainLedger, runId: string): void {
  ledger.startRun({
    baseBranch: "main",
    branch: "feature",
    intent: "Stream durable status.",
    policySha256: policy,
    repoRoot: "/repo",
    runId,
    submissionCommitOid: commit,
  });
}

test("presentation snapshots are durable, ordered, immutable, and resume without replay", () => {
  const ledger = new DomainLedger(":memory:");
  const runId = "presentation-run";
  const lines: string[] = [];
  let second = 0;
  try {
    startRun(ledger, runId);
    const publisher = new PresentationPublisher(
      ledger,
      runId,
      new PlainStatusRenderer({ write: (line) => lines.push(line) }),
      () => new Date(Date.UTC(2026, 0, 1, 0, 0, second++)),
    );
    publisher.publish("run:started", { kind: "run-started" });
    publisher.publish("attempt:1:started", {
      attempt: 1,
      kind: "attempt-started",
    });
    publisher.publish("attempt:1:mode:off", {
      enabled: false,
      kind: "mode-changed",
    });
    publisher.publish("attempt:1:stage:review:started", {
      kind: "stage-started",
      stage: "review",
    });
    publisher.publish("attempt:1:stage:review:round:1", {
      kind: "round-started",
      round: 1,
      stage: "review",
    });
    publisher.publish("findings:evidence", {
      actionable: 1,
      kind: "findings-recorded",
      round: 1,
      stage: "review",
      total: 2,
    });
    publisher.publish("gate:review:opened", {
      gateId: "gate-review",
      kind: "gate-opened",
      round: 1,
      stage: "review",
    });
    publisher.publish("gate:review:resolved", {
      decision: "approve\n\u001b[2J",
      gateId: "gate-review",
      kind: "gate-resolved",
      round: 1,
      stage: "review",
    });
    publisher.publish("stage:review:completed", {
      kind: "stage-completed",
      round: 1,
      stage: "review",
    });
    publisher.publish("attempt:1:error", {
      kind: "error-recorded",
      resumable: true,
    });
    publisher.publish("attempt:2:started", {
      attempt: 2,
      kind: "attempt-started",
    });
    publisher.publish("attempt:2:cancel", {
      action: "cancel",
      kind: "cancellation-recorded",
    });
    publisher.publish("run:completed:cancelled", {
      kind: "run-completed",
      status: "cancelled",
    });

    const snapshots = ledger.listPresentationSnapshots(runId);
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.transition.kind),
      [
        "run-started",
        "attempt-started",
        "mode-changed",
        "stage-started",
        "round-started",
        "findings-recorded",
        "gate-opened",
        "gate-resolved",
        "stage-completed",
        "error-recorded",
        "attempt-started",
        "cancellation-recorded",
        "run-completed",
      ],
    );
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.sequence),
      snapshots.map((_, index) => index + 1),
    );
    assert.equal(lines.length, snapshots.length);
    assert.ok(lines.every((line) => line.endsWith("\n")));
    assert.ok(lines.every((line) => line.split("\n").length === 2));
    assert.ok(lines.every((line) => line.length < 300));
    assert.doesNotMatch(lines.join(""), /\r|\[[0-9;]*[A-Za-z]/u);
    assert.equal(lines.join("").includes(String.fromCharCode(27)), false);
    assert.doesNotMatch(
      JSON.stringify(snapshots),
      /elapsed|cursor|activity|pane|rawOutput/u,
    );
    assert.equal(
      snapshots.at(-1)!.stages.find((stage) => stage.id === "review")!.status,
      "passed",
    );

    const duplicate = {
      ...snapshots[0],
      status: "failed" as const,
    } satisfies PresentationSnapshot;
    assert.equal(
      ledger.recordPresentationSnapshot(runId, "run:started", duplicate),
      false,
    );
    assert.equal(ledger.listPresentationSnapshots(runId)[0].status, "in-progress");

    const resumedLines: string[] = [];
    const resumed = new PresentationPublisher(
      ledger,
      runId,
      new PlainStatusRenderer({ write: (line) => resumedLines.push(line) }),
    );
    assert.equal(resumedLines.length, 0);
    assert.equal(resumed.nextAttempt(), 3);
    assert.equal(
      resumed.current.stages.find((stage) => stage.id === "review")!.status,
      "passed",
    );
    resumed.publish("attempt:3:started", {
      attempt: 3,
      kind: "attempt-started",
    });
    resumed.publish("attempt:3:started", {
      attempt: 3,
      kind: "attempt-started",
    });
    assert.equal(resumedLines.length, 1);
    assert.equal(ledger.listPresentationSnapshots(runId).length, snapshots.length + 1);
  } finally {
    ledger.close();
  }
});

test("renderer failure does not stop durable publication", () => {
  const snapshots: PresentationSnapshot[] = [];
  const failures: unknown[] = [];
  const publisher = new PresentationPublisher(
    {
      listPresentationSnapshots: () => snapshots,
      recordPresentationSnapshot: (_runId, _eventKey, snapshot) => {
        snapshots.push(snapshot);
        return true;
      },
    },
    "renderer-failure",
    {
      render: () => {
        throw new Error("closed stream");
      },
    },
    () => new Date("2026-01-01T00:00:00.000Z"),
    (error) => failures.push(error),
  );

  publisher.publish("run:started", { kind: "run-started" });
  publisher.publish("attempt:1:started", {
    attempt: 1,
    kind: "attempt-started",
  });
  assert.equal(snapshots.length, 2);
  assert.equal(failures.length, 1);
});

test("plain status uses stderr while structured result remains on stdout", () => {
  const moduleUrl = new URL("../scripts/presentation.ts", import.meta.url).href;
  const script = `
    const { PlainStatusRenderer, PresentationPublisher } = await import(${JSON.stringify(moduleUrl)});
    const snapshots = [];
    const store = {
      listPresentationSnapshots: () => snapshots,
      recordPresentationSnapshot: (_runId, _eventKey, snapshot) => (snapshots.push(snapshot), true),
    };
    const publisher = new PresentationPublisher(
      store,
      "output-run",
      new PlainStatusRenderer(process.stderr),
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    publisher.publish("run:started", { kind: "run-started" });
    process.stdout.write(JSON.stringify({ runId: "output-run" }) + "\\n");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{"runId":"output-run"}\n');
  assert.match(result.stderr, /output-run run started\n/u);
  assert.doesNotMatch(result.stderr, /\r/u);
  assert.equal(result.stderr.includes(String.fromCharCode(27)), false);
});
