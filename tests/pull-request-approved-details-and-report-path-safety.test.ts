import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pullRequestContent } from "../scripts/pull-request.ts";

const BINARY_PATH = path.resolve(import.meta.dirname, "../bin/orca-no-mistakes");
const OID = "b".repeat(40);

test("pullRequestContent renders approved finding details in the approved-as-is subsection", () => {
  const result = pullRequestContent("feat: test approved finding details", {
    candidateCommitOid: OID,
    pipelineSteps: [
      {
        approvedFindingDetails: [
          {
            description: "The PR narrative deletes every finding whose final disposition is only approved.",
            file: "scripts/orca-no-mistakes.ts",
            line: 5521,
            severity: "error",
          },
        ],
        approvedFindings: 1,
        name: "review",
        rounds: [
          {
            findings: [],
            summary: "Review completed.",
          },
        ],
        status: "approved",
      },
    ],
    risk: { level: "low", rationale: "The single finding was accepted." },
    testing: { artifacts: [], summary: "Tested approved findings.", tested: [] },
    whatChanged: "Updated pull request reporting.",
  });

  assert.match(result.body, /<summary>⚠️ \*\*Review\*\* - 1 issue approved<\/summary>/);
  assert.match(result.body, /⚠️ 1 issue approved as-is\./);
  assert.match(
    result.body,
    /- 🚨 `scripts\/orca-no-mistakes\.ts:5521` - The PR narrative deletes every finding whose final disposition is only approved\./,
  );
});

test("report command rejects symlinks across artifact-root-to-parent chain and escapes into repository", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "onm-symlink-test-"));
  try {
    const fakeHome = path.join(temp, "home");
    const artifactsDir = path.join(fakeHome, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    const repoDir = path.join(temp, "repo");
    mkdirSync(repoDir, { recursive: true });

    const symlinkRunDir = path.join(artifactsDir, "run_symlink");
    symlinkSync(repoDir, symlinkRunDir, "dir");

    const outPath = path.join(symlinkRunDir, "fixer-review-2.json");
    const payload = JSON.stringify({
      findings: [],
      summary: "fix applied",
      tested: ["node --test"],
    });

    let failed = false;
    let failureError = "";
    try {
      execFileSync(process.execPath, [BINARY_PATH, "report", "--stage", "review", "--role", "fixer", "--out", outPath], {
        env: { ...process.env, ORCA_NO_MISTAKES_HOME: fakeHome },
        input: payload,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error: any) {
      failed = true;
      failureError = String(error.stderr || error.message);
    }

    assert.equal(failed, true, "report command must fail when parent is a symlink");
    assert.match(failureError, /symlink/i);

    const targetInRepo = path.join(repoDir, "fixer-review-2.json");
    assert.equal(existsSync(targetInRepo), false, "report must not be written to repo");
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
});

test("report command succeeds and writes report for valid canonical artifact path", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "onm-valid-test-"));
  try {
    const fakeHome = path.join(temp, "home");
    const artifactsDir = path.join(fakeHome, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    const runDir = path.join(artifactsDir, "run_valid");
    const outPath = path.join(runDir, "fixer-review-2.json");
    const payload = JSON.stringify({
      findings: [],
      summary: "valid fix applied",
      tested: ["node --test"],
    });

    const stdout = execFileSync(
      process.execPath,
      [BINARY_PATH, "report", "--stage", "review", "--role", "fixer", "--out", outPath],
      {
        encoding: "utf8",
        env: { ...process.env, ORCA_NO_MISTAKES_HOME: fakeHome },
        input: payload,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.reportPath, outPath);

    const content = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(content.summary, "valid fix applied");
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
});
