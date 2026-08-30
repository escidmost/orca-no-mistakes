import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { buildAttestation, DomainLedger } from "../scripts/ledger.ts";
import {
  PresentationPublisher,
  type PresentationSnapshot,
  type PresentationTransition,
} from "../scripts/presentation.ts";

const commit = "a".repeat(40);
const policy = "b".repeat(64);

function startRun(ledger: DomainLedger, runId: string, branch: string): number {
  ledger.startRun({
    baseBranch: "main",
    branch,
    intent: `Run ${runId}.`,
    policySha256: policy,
    repoRoot: "/repo",
    runId,
    submissionCommitOid: commit,
  });
  return ledger.acquireLease({ branch, repoRoot: "/repo", runId });
}

function snapshot(
  runId: string,
  transition: PresentationTransition,
): PresentationSnapshot {
  return new PresentationPublisher(
    {
      listPresentationSnapshots: () => [],
      recordPresentationSnapshot: () => true,
    },
    runId,
  ).publish("event", transition);
}

test("domain milestones and presentation snapshots commit atomically", async () => {
  const ledger = new DomainLedger(":memory:");
  try {
    startRun(ledger, "checkpoint", "checkpoint-branch");
    const failedToken = startRun(ledger, "failed", "failed-branch");
    const passedToken = startRun(ledger, "passed", "passed-branch");
    const wrongSnapshot = snapshot("other", {
      kind: "run-completed",
      status: "failed",
    });

    assert.throws(
      () =>
        ledger.recordCheckpoint(
          {
            inputCommitOid: commit,
            outputCommitOid: commit,
            roundIndex: 1,
            runId: "checkpoint",
            stageId: "review",
          },
          { eventKey: "checkpoint", snapshot: wrongSnapshot },
        ),
      /run ID mismatch/,
    );
    assert.equal(ledger.listCheckpoints("checkpoint").length, 0);
    ledger.recordCheckpoint(
      {
        inputCommitOid: commit,
        outputCommitOid: commit,
        roundIndex: 1,
        runId: "checkpoint",
        stageId: "review",
      },
      {
        eventKey: "checkpoint",
        snapshot: snapshot("checkpoint", {
          kind: "stage-completed",
          round: 1,
          stage: "review",
        }),
      },
    );
    assert.equal(ledger.listCheckpoints("checkpoint").length, 1);
    assert.equal(ledger.listPresentationSnapshots("checkpoint").length, 1);

    assert.throws(
      () =>
        ledger.settleRun(
          "failed",
          "failed",
          {
            branch: "failed-branch",
            generationToken: failedToken,
            repoRoot: "/repo",
          },
          { eventKey: "failed", snapshot: wrongSnapshot },
        ),
      /run ID mismatch/,
    );
    assert.equal(ledger.runStatus("failed"), "in-progress");
    assert.equal(ledger.leaseFor("/repo", "failed-branch")?.run_id, "failed");
    assert.equal(
      ledger.settleRun(
        "failed",
        "failed",
        {
          branch: "failed-branch",
          generationToken: failedToken,
          repoRoot: "/repo",
        },
        {
          eventKey: "failed",
          snapshot: snapshot("failed", { kind: "error-recorded", resumable: true }),
        },
      ),
      true,
    );
    assert.equal(ledger.runStatus("failed"), "failed");
    assert.equal(ledger.listPresentationSnapshots("failed").length, 1);

    const manifest = buildAttestation([], {
      baseCommitOid: commit,
      candidateCommitOid: commit,
      guardrailMode: "strict",
      intent: "Run passed.",
      policySha256: policy,
      runId: "passed",
    });
    await assert.rejects(
      ledger.finalizePassedRunWithLeaseMutation(
        manifest,
        commit,
        {
          branch: "passed-branch",
          generationToken: passedToken,
          repoRoot: "/repo",
        },
        async () => "delivered",
        { eventKey: "passed", snapshot: wrongSnapshot },
      ),
      /run ID mismatch/,
    );
    assert.equal(ledger.runStatus("passed"), "in-progress");
    assert.equal(ledger.findAttestation("passed"), undefined);
    assert.equal(ledger.leaseFor("/repo", "passed-branch")?.run_id, "passed");
    assert.equal(
      await ledger.finalizePassedRunWithLeaseMutation(
        manifest,
        commit,
        {
          branch: "passed-branch",
          generationToken: passedToken,
          repoRoot: "/repo",
        },
        async () => "delivered",
        {
          eventKey: "passed",
          snapshot: snapshot("passed", { kind: "run-completed", status: "passed" }),
        },
      ),
      "delivered",
    );
    assert.equal(ledger.runStatus("passed"), "passed");
    assert.equal(ledger.listPresentationSnapshots("passed").length, 1);
  } finally {
    ledger.close();
  }
});

test("asynchronous plain-status stream errors do not escape", () => {
  const moduleUrl = new URL("../scripts/presentation.ts", import.meta.url).href;
  const script = `
    import { Writable } from "node:stream";
    const { PlainStatusRenderer, PresentationPublisher } = await import(${JSON.stringify(moduleUrl)});
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
      },
    });
    const publisher = new PresentationPublisher(
      {
        listPresentationSnapshots: () => [],
        recordPresentationSnapshot: () => true,
      },
      "epipe",
      new PlainStatusRenderer(output),
    );
    publisher.publish("started", { kind: "run-started" });
    setImmediate(() => {
      publisher.publish("attempt", { attempt: 1, kind: "attempt-started" });
      process.stdout.write("result\\n");
    });
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "result\n");
});
