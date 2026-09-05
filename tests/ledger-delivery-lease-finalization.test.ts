import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildAttestation, DomainLedger } from "../scripts/ledger.ts";

const commit = "a".repeat(40);
const policySha256 = "b".repeat(64);

test("delivery mutation and passed finalization hold one lease generation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "onm-delivery-lease-"));
  const dbPath = path.join(directory, "ledger.db");
  const owner = new DomainLedger(dbPath);
  const taker = new DomainLedger(dbPath);
  try {
    for (const [ledger, runId] of [
      [owner, "owner"],
      [taker, "taker"],
    ] as const) {
      ledger.startRun({
        baseBranch: "main",
        branch: "feature",
        intent: `Run ${runId}.`,
        policySha256,
        repoRoot: "/repo",
        runId,
        submissionCommitOid: commit,
      });
    }
    const generationToken = owner.acquireLease({
      branch: "feature",
      repoRoot: "/repo",
      runId: "owner",
    });
    const manifest = buildAttestation([], {
      baseCommitOid: commit,
      candidateCommitOid: commit,
      guardrailMode: "strict",
      intent: "Run owner.",
      policySha256,
      runId: "owner",
    });

    const result = await owner.finalizePassedRunWithLeaseMutation(
      manifest,
      commit,
      { branch: "feature", generationToken, repoRoot: "/repo" },
      async () => {
        assert.throws(
          () =>
            taker.acquireLease({
              branch: "feature",
              force: true,
              repoRoot: "/repo",
              runId: "taker",
            }),
          /database is (?:busy|locked)/,
        );
        return "delivered";
      },
    );

    assert.equal(result, "delivered");
    assert.equal(owner.runStatus("owner"), "passed");
    assert.equal(owner.leaseFor("/repo", "feature"), undefined);
    assert.equal(
      taker.acquireLease({
        branch: "feature",
        force: true,
        repoRoot: "/repo",
        runId: "taker",
      }),
      generationToken + 1,
    );
  } finally {
    owner.close();
    taker.close();
    await rm(directory, { force: true, recursive: true });
  }
});
