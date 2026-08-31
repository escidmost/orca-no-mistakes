import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { main } from "../scripts/orca-no-mistakes.ts";
import {
  DomainLedger,
  defaultLedgerPath,
  legacyLedgerPath,
  repositoryLedgerPath,
} from "../scripts/ledger.ts";

async function repository(temp: string): Promise<string> {
  await mkdir(path.join(temp, "repo"));
  const repo = await realpath(path.join(temp, "repo"));
  execFileSync("git", [
    "-c",
    "init.templateDir=",
    "init",
    "-b",
    "main",
    repo,
  ]);
  return repo;
}

test("migration commits its copy before legacy cleanup", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-migration-phase-"));
  const legacyPath = path.join(temp, "legacy.sqlite");
  try {
    const repo = await repository(temp);
    const legacy = new DomainLedger(legacyPath);
    legacy.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "preserve migration history",
      policySha256: "f".repeat(64),
      repoRoot: repo,
      runId: "legacy-run",
      submissionCommitOid: "a".repeat(40),
    });
    legacy.finishRun("legacy-run", "failed");
    legacy.close();

    const source = new DatabaseSync(legacyPath);
    source.exec(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON runs
      BEGIN SELECT RAISE(ABORT, 'simulated cleanup crash'); END;`);
    source.close();

    assert.doesNotThrow(() =>
      new DomainLedger({ legacyPath, repositoryPath: repo }).close(),
    );

    const destination = new DatabaseSync(repositoryLedgerPath(repo));
    assert.equal(
      (
        destination
          .prepare("SELECT status FROM runs WHERE run_id = 'legacy-run'")
          .get() as { status: string } | undefined
      )?.status,
      "failed",
    );
    assert.equal(
      (
        destination
          .prepare(
            "SELECT source_present FROM repository_migrations WHERE source_path = ? AND repo_root = ?",
          )
          .get(legacyPath, repo) as { source_present: number } | undefined
      )?.source_present,
      1,
    );
    destination.close();

    const retained = new DatabaseSync(legacyPath);
    assert.equal(
      (
        retained.prepare("SELECT COUNT(*) AS count FROM runs").get() as {
          count: number | bigint;
        }
      ).count,
      1,
    );
    retained.exec("DROP TRIGGER fail_cleanup");
    retained.close();

    new DomainLedger({ legacyPath, repositoryPath: repo }).close();
    const cleaned = new DatabaseSync(legacyPath);
    assert.equal(
      (
        cleaned.prepare("SELECT COUNT(*) AS count FROM runs").get() as {
          count: number | bigint;
        }
      ).count,
      0,
    );
    cleaned.close();
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test("repository resolution only falls back for absent repositories", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-ledger-location-"));
  const previousFailure = process.env.ONM_TEST_REPOSITORY_FAILURE;
  const previousGit = process.env.ONM_TEST_REAL_GIT;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousPath = process.env.PATH;
  try {
    const repo = await repository(temp);
    const bin = path.join(temp, "bin");
    await mkdir(bin);
    const realGit = (previousPath ?? "")
      .split(path.delimiter)
      .map((entry) => path.join(entry, "git"))
      .find((candidate) => existsSync(candidate));
    assert.ok(realGit, "git must be on PATH");
    const wrapper = path.join(bin, "git");
    await writeFile(
      wrapper,
      `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const failure = process.env.ONM_TEST_REPOSITORY_FAILURE;
if (failure && args.includes("--path-format=absolute")) {
  const errors = {
    missing: "fatal: cannot change to '/missing': No such file or directory",
    nonrepo: "fatal: not a git repository (or any parent directories): .git",
    permission: "fatal: cannot change to '/private': Permission denied",
    unsupported: "error: unknown option 'path-format=absolute'",
  };
  console.error(errors[failure]);
  process.exit(failure === "unsupported" ? 129 : 128);
}
const result = spawnSync(process.env.ONM_TEST_REAL_GIT, args, { encoding: "utf8" });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`,
    );
    await chmod(wrapper, 0o755);
    process.env.ONM_TEST_REAL_GIT = realGit;
    process.env.ORCA_NO_MISTAKES_HOME = path.join(temp, "home");
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;

    for (const failure of ["missing", "nonrepo"]) {
      process.env.ONM_TEST_REPOSITORY_FAILURE = failure;
      assert.equal(defaultLedgerPath(), legacyLedgerPath());
    }
    for (const [failure, message] of [
      ["unsupported", /unknown option/],
      ["permission", /Permission denied/],
    ] as const) {
      process.env.ONM_TEST_REPOSITORY_FAILURE = failure;
      assert.throws(() => defaultLedgerPath(), message);
    }

    process.env.ONM_TEST_REPOSITORY_FAILURE = "unsupported";
    await assert.rejects(
      main(["prune", "--before=2999-01-01", `--repo=${repo}`]),
      /unknown option/,
    );
  } finally {
    if (previousFailure === undefined)
      delete process.env.ONM_TEST_REPOSITORY_FAILURE;
    else process.env.ONM_TEST_REPOSITORY_FAILURE = previousFailure;
    if (previousGit === undefined) delete process.env.ONM_TEST_REAL_GIT;
    else process.env.ONM_TEST_REAL_GIT = previousGit;
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(temp, { force: true, recursive: true });
  }
});
