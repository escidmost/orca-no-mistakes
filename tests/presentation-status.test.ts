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
      options: ["approve", "stop"],
      question: "Choose a review action.",
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

test("a failed renderer is replaced by the fallback and later status keeps rendering", () => {
  const snapshots: PresentationSnapshot[] = [];
  const failures: unknown[] = [];
  const lines: string[] = [];
  let fallbackBuilds = 0;
  const publisher = new PresentationPublisher(
    {
      listPresentationSnapshots: () => snapshots,
      recordPresentationSnapshot: (_runId, _eventKey, snapshot) => {
        snapshots.push(snapshot);
        return true;
      },
    },
    "renderer-fallback",
    {
      render: () => {
        throw new Error("closed stream");
      },
    },
    () => new Date("2026-01-01T00:00:00.000Z"),
    (error) => failures.push(error),
    () => {
      fallbackBuilds += 1;
      return new PlainStatusRenderer({ write: (line) => lines.push(line) });
    },
  );

  publisher.publish("run:started", { kind: "run-started" });
  publisher.publish("attempt:1:started", {
    attempt: 1,
    kind: "attempt-started",
  });
  publisher.publish("attempt:1:stage:review:started", {
    kind: "stage-started",
    stage: "review",
  });
  assert.equal(snapshots.length, 3);
  assert.equal(failures.length, 1);
  assert.equal(fallbackBuilds, 1);
  assert.deepEqual(lines, [
    "no-mistakes renderer-fallback attempt 1 started\n",
    "no-mistakes renderer-fallback stage 3/8 review started\n",
  ]);
});

test("plain status degrades hostile identifiers to one bounded ASCII line", () => {
  const previousSecret = process.env.ONM_TEST_SECRET;
  const previousPassword = process.env.ONM_TEST_PASSWORD;
  process.env.ONM_TEST_SECRET = "secret-value";
  process.env.ONM_TEST_PASSWORD = "open sesame";
  const lines: string[] = [];
  const renderer = new PlainStatusRenderer({ write: (line) => lines.push(line) });
  try {
    renderer.render({
      attempt: 1,
      currentStage: "review",
      mode: { autoFix: false },
      runId: `run\nsec\u001b[31mret-value\u001b[0m-open\nsesame-wide-\u4e2d-combining-e\u0301-${"x".repeat(500)}`,
      sequence: 1,
      stages: [],
      status: "in-progress",
      transition: {
        decision: `approve\r\n\u001b[2J\u4e2d${"y".repeat(500)}`,
        gateId: "gate-review",
        kind: "gate-resolved",
        round: 1,
        stage: "review",
      },
      updatedAt: new Date(0).toISOString(),
      version: 1,
    });
  } finally {
    if (previousSecret === undefined) delete process.env.ONM_TEST_SECRET;
    else process.env.ONM_TEST_SECRET = previousSecret;
    if (previousPassword === undefined) delete process.env.ONM_TEST_PASSWORD;
    else process.env.ONM_TEST_PASSWORD = previousPassword;
  }

  assert.equal(lines.length, 1);
  assert.equal(lines[0].split("\n").length, 2);
  assert.equal(lines[0].includes("\u001b"), false);
  assert.equal(lines[0].includes("\u4e2d"), false);
  assert.equal(lines[0].includes("\u0301"), false);
  assert.equal(lines[0].includes("secret-value"), false);
  assert.equal(lines[0].includes("open sesame"), false);
  assert.match(lines[0], /\[REDACTED\]/u);
  assert.match(lines[0], /^[\x20-\x7e]+\n$/u);
  assert.ok(lines[0].length < 300);
  assert.doesNotMatch(lines[0], new RegExp("x{120}|y{120}", "u"));
});

test("a new attempt preserves durable finding progress", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    const runId = "attempt-reset";
    startRun(ledger, runId);
    const publisher = new PresentationPublisher(ledger, runId);
    publisher.publish("test-findings", {
      actionable: 2,
      kind: "findings-recorded",
      round: 3,
      stage: "test",
      total: 4,
    });
    publisher.publish("attempt-2", { attempt: 2, kind: "attempt-started" });

    const stage = publisher.current.stages.find((item) => item.id === "test")!;
    assert.equal(stage.actionableFindings, 2);
    assert.equal(stage.round, 0);
    assert.equal(stage.status, "pending");
    assert.equal(stage.totalFindings, 4);
  } finally {
    ledger.close();
  }
});

test("ONM-88 tracks fixed, approved, open, and retained findings separately", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    const runId = "finding-dispositions";
    startRun(ledger, runId);
    const publisher = new PresentationPublisher(ledger, runId);
    const first = {
      description: "First defect",
      id: "first",
      severity: "error" as const,
    };
    const second = {
      description: "Second defect",
      id: "second",
      severity: "warning" as const,
    };
    publisher.publish("findings:first", {
      actionable: 2,
      findings: [first, second],
      kind: "findings-recorded",
      round: 0,
      stage: "review",
      total: 2,
    });
    publisher.publish("findings:second", {
      actionable: 1,
      findings: [second],
      kind: "findings-recorded",
      retainedFixer: true,
      round: 1,
      stage: "review",
      total: 2,
    });

    let stage = publisher.current.stages.find((item) => item.id === "review")!;
    assert.deepEqual(
      [stage.fixedFindings, stage.approvedFindings, stage.openFindings],
      [1, 0, 1],
    );
    assert.equal(stage.retainedFixer, true);
    assert.deepEqual(
      stage.findings?.map((finding) => [finding.id, finding.disposition]),
      [
        ["first", "fixed"],
        ["second", "open"],
      ],
    );

    publisher.publish("gate:approved", {
      decision: "approve",
      gateId: "gate-review",
      kind: "gate-resolved",
      round: 1,
      stage: "review",
    });
    stage = publisher.current.stages.find((item) => item.id === "review")!;
    assert.deepEqual(
      [stage.fixedFindings, stage.approvedFindings, stage.openFindings],
      [1, 1, 0],
    );
  } finally {
    ledger.close();
  }
});

test("targeted fixes preserve unselected findings as approved", () => {
  const ledger = new DomainLedger(":memory:");
  try {
    const runId = "targeted-finding-dispositions";
    startRun(ledger, runId);
    const publisher = new PresentationPublisher(ledger, runId);
    publisher.publish("findings", {
      actionable: 2,
      findings: [
        { description: "Fix this", id: "fix-this", severity: "error" },
        { description: "Accept this", id: "accept-this", severity: "warning" },
      ],
      kind: "findings-recorded",
      round: 0,
      stage: "review",
      total: 2,
    });
    publisher.publish("gate:targeted-fix", {
      decision: "fix",
      gateId: "gate-review",
      kind: "gate-resolved",
      round: 0,
      stage: "review",
      targetFindingIds: ["fix-this"],
    });

    const stage = publisher.current.stages.find((item) => item.id === "review")!;
    assert.deepEqual(
      stage.findings?.map((finding) => [finding.id, finding.disposition]),
      [
        ["fix-this", "open"],
        ["accept-this", "approved"],
      ],
    );
    assert.deepEqual(
      [stage.fixedFindings, stage.approvedFindings, stage.openFindings],
      [0, 1, 1],
    );
    publisher.publish("fix:completed", {
      approvedFindings: 1,
      findingIds: ["fix-this"],
      kind: "fix-completed",
      round: 1,
      stage: "review",
    });
    const completed = publisher.current.stages.find((item) => item.id === "review")!;
    assert.deepEqual(
      [completed.fixedFindings, completed.approvedFindings, completed.openFindings],
      [1, 1, 0],
    );
  } finally {
    ledger.close();
  }
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
