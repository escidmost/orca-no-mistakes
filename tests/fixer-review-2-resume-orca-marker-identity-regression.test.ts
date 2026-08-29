import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DomainLedger,
  installAbortReaping,
  main,
  registerAbortRunContext,
  type GitOperations,
} from "../scripts/orca-no-mistakes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("default resume cleanup keeps orchestration and domain identities", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-resume-orca-identity-"));
  const repo = path.join(temp, "repo");
  const home = path.join(temp, "home");
  const command = path.join(temp, "orca");
  const callsFile = path.join(temp, "calls.jsonl");
  const gatePath = path.join(temp, "run", "no-mistakes-gate-resume");
  const gate = {
    branch: path.basename(gatePath),
    id: `repo-id::${gatePath}`,
    kind: "orca" as const,
    path: gatePath,
  };
  const marker = path.join(
    repo,
    ".orca",
    "no-mistakes",
    `gate-${createHash("sha256").update(gate.id).digest("hex").slice(0, 32)}.json`,
  );
  const orchestrationRunId = "run-resume-orchestration";
  const domainRunId = "run-resume-domain";
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  let ledger: DomainLedger | undefined;
  try {
    await mkdir(path.join(repo, ".orca", "no-mistakes"), { recursive: true });
    git(repo, "-c", "init.templateDir=", "init", "-b", "feature");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "commit", "--allow-empty", "-m", "seed");
    const repoRoot = await realpath(repo);
    const head = git(repoRoot, "rev-parse", "HEAD");
    git(
      repoRoot,
      "update-ref",
      `refs/no-mistakes/recover/${domainRunId}`,
      head,
    );
    ledger = new DomainLedger(path.join(home, "ledger.db"));
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "resume with separate Orca identity",
      policySha256: "policy",
      repoRoot,
      runId: domainRunId,
      submissionCommitOid: head,
    });
    ledger.acquireLease({ branch: "feature", repoRoot, runId: domainRunId });
    const generationToken = ledger.leaseFor(repoRoot, "feature")!.generation_token;
    const unusedGit = {} as GitOperations;
    const dead = spawnSync(process.execPath, ["-e", ""]);
    assert.ok(dead.pid !== undefined);
    await installAbortReaping({ gate, originWorktree: repoRoot, pid: dead.pid });
    await registerAbortRunContext({
      deliveryGit: unusedGit,
      generationToken,
      git: unusedGit,
      ledger,
      orchestrationRunId,
      runId: domainRunId,
    });
    const writtenMarker = JSON.parse(await readFile(marker, "utf8"));
    assert.equal(writtenMarker.domainRunId, domainRunId);
    assert.equal(writtenMarker.generationToken, generationToken);
    assert.equal(writtenMarker.runId, orchestrationRunId);
    assert.equal(
      ledger.settleRun(domainRunId, "failed", {
        branch: "feature",
        generationToken,
        repoRoot,
      }),
      true,
    );
    ledger.close();
    ledger = undefined;

    await writeFile(
      command,
      `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "worktree" && args[1] === "list") out({ worktrees: [{ id: "repo-id::origin", path: ${JSON.stringify(repoRoot)}, branch: "feature" }] })
else if (args[0] === "orchestration" && args[1] === "task-list") out({ tasks: [{ id: "task-intent", status: "in_progress" }] })
else if (args[0] === "orchestration" && args[1] === "task-update") out({ task: { id: "task-intent", status: "failed" } })
else { console.error(JSON.stringify({ error: { code: "unexpected", args } })); process.exit(1) }
`,
    );
    await chmod(command, 0o755);
    process.env.ORCA_CLI_COMMAND = command;
    process.env.ORCA_NO_MISTAKES_HOME = home;

    await main(["prune", "--stranded", "--repo", repoRoot]);

    assert.equal(existsSync(marker), false);
    const calls = (await readFile(callsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const orchestrationCalls = calls.filter((args) => args[0] === "orchestration");
    assert.ok(orchestrationCalls.some((args) => args.includes(orchestrationRunId)));
    assert.equal(orchestrationCalls.some((args) => args.includes(domainRunId)), false);
  } finally {
    ledger?.close();
    await installAbortReaping({});
    restoreEnv("ORCA_CLI_COMMAND", previousCommand);
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    await rm(temp, { force: true, recursive: true });
  }
});
