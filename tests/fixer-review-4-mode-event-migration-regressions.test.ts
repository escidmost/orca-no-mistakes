import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DomainLedger } from "../scripts/ledger.ts";

const commit = "a".repeat(40);
const policy = "b".repeat(64);

test("repository migration preserves duplicate auto-fix mode events", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-dup-mode-migration-"));
  const repo = path.join(temp, "repo");
  const legacyDir = path.join(temp, "legacy");
  const legacyPath = path.join(legacyDir, "ledger.db");
  try {
    execFileSync("git", ["-c", "init.templateDir=", "init", "-b", "main", repo]);
    const repoRoot = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();

    await mkdir(legacyDir, { recursive: true });
    const legacy = new DomainLedger(legacyPath);
    legacy.startRun({
      baseBranch: "main",
      branch: "legacy",
      intent: "Migrate duplicated mode history.",
      policySha256: policy,
      repoRoot,
      runId: "legacy-dup-mode-history",
      submissionCommitOid: commit,
    });
    legacy.recordAutoFixMode("legacy-dup-mode-history", true, "initial");

    const sameInstant = "2026-08-31T00:00:00.000Z";
    const raw = new DatabaseSync(legacyPath);
    try {
      const insert = raw.prepare(
        `INSERT INTO auto_fix_mode_events (run_id, enabled, source, changed_at)
         VALUES ('legacy-dup-mode-history', 0, 'operator', ?)`,
      );
      insert.run(sameInstant);
      insert.run(sameInstant);
    } finally {
      raw.close();
    }
    legacy.finishRun("legacy-dup-mode-history", "failed");
    legacy.close();

    const migrated = new DomainLedger({ legacyPath, repositoryPath: repo });
    assert.deepEqual(
      migrated
        .listAutoFixModeEvents("legacy-dup-mode-history")
        .map(({ enabled, source }) => ({ enabled, source })),
      [
        { enabled: true, source: "initial" },
        { enabled: false, source: "operator" },
        { enabled: false, source: "operator" },
      ],
    );
    assert.equal(migrated.latestAutoFixMode("legacy-dup-mode-history"), false);
    migrated.close();

    const remigrated = new DomainLedger({ legacyPath, repositoryPath: repo });
    assert.equal(
      remigrated.listAutoFixModeEvents("legacy-dup-mode-history").length,
      3,
    );
    remigrated.close();
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});
