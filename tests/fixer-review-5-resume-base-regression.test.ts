import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DomainLedger, main } from "../scripts/orca-no-mistakes.ts";
import { legacyLedgerPath } from "../scripts/ledger.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("detached resume restores its stored non-default base", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-resume-base-"));
  const origin = path.join(temp, "origin.git");
  const repo = path.join(temp, "repo");
  const gate = path.join(temp, "gate");
  const fakeOrca = path.join(temp, "orca");
  const callsPath = path.join(temp, "calls.jsonl");
  const home = path.join(temp, "home");
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHandle = process.env.ORCA_TERMINAL_HANDLE;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;

  try {
    git(temp, "-c", "init.templateDir=", "init", "--bare", origin);
    git(temp, "-c", "init.templateDir=", "clone", origin, repo);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "checkout", "-b", "main");
    await writeFile(path.join(repo, "README.md"), "main\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "main");
    git(repo, "push", "-u", "origin", "main");
    git(temp, `--git-dir=${origin}`, "symbolic-ref", "HEAD", "refs/heads/main");
    git(repo, "checkout", "-b", "release");
    await writeFile(path.join(repo, "README.md"), "release\n");
    git(repo, "commit", "-am", "release");
    git(repo, "push", "-u", "origin", "release");
    git(repo, "checkout", "-b", "feature");
    await writeFile(path.join(repo, "feature.txt"), "feature\n");
    git(repo, "add", "feature.txt");
    git(repo, "commit", "-m", "feature");
    await mkdir(gate);
    await mkdir(home);

    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
if (args[0] === 'terminal' && args[1] === 'send') {
  const markerDirectory = ${JSON.stringify(path.join(repo, ".orca", "no-mistakes"))}
  const markerFile = fs.readdirSync(markerDirectory)
    .map((name) => markerDirectory + '/' + name)
    .find((file) => file.endsWith('.json') && JSON.parse(fs.readFileSync(file, 'utf8')).startupReceipt)
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  delete marker.launcherPid
  marker.pid = process.ppid
  fs.writeFileSync(markerFile, JSON.stringify(marker))
}
const gateName = args[args.indexOf('--name') + 1]
const result = args[0] === 'worktree' && args[1] === 'create'
  ? { worktree: { id: 'gate-id', path: ${JSON.stringify(gate)}, branch: 'refs/heads/evs/' + gateName } }
  : args[0] === 'terminal' && args[1] === 'list'
    ? { terminals: [{ handle: 'gate-shell', connected: true, writable: true }] }
    : args[0] === 'terminal' && args[1] === 'show'
      ? { terminal: { connected: true, preview: 'ready shell prompt' } }
      : { accepted: true }
console.log(JSON.stringify({ result }))
`,
    );
    await chmod(fakeOrca, 0o755);
    process.env.ORCA_CLI_COMMAND = fakeOrca;
    process.env.ORCA_TERMINAL_HANDLE = "origin-terminal";
    process.env.ORCA_NO_MISTAKES_HOME = home;

    const canonicalRepo = await realpath(repo);
    const featureHead = git(repo, "rev-parse", "HEAD");
    const ledger = new DomainLedger(legacyLedgerPath());
    try {
      ledger.startRun({
        baseBranch: "release",
        branch: "feature",
        intent: "Resume from the stored release base.",
        policySha256: "f".repeat(64),
        repoRoot: canonicalRepo,
        runId: "resume-release-base",
        submissionCommitOid: featureHead,
      });
      ledger.recordCheckpoint({
        inputCommitOid: featureHead,
        outputCommitOid: featureHead,
        roundIndex: 0,
        runId: "resume-release-base",
        stageId: "intent",
      });
      assert.equal(ledger.finishRun("resume-release-base", "failed", featureHead), true);
    } finally {
      ledger.close();
    }

    await main([
      "run",
      `--repo=${repo}`,
      "--resume=resume-release-base",
    ]);

    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const terminalSend = calls.find(
      (args) => args[0] === "terminal" && args[1] === "send",
    );
    const commandText = terminalSend?.[terminalSend.indexOf("--text") + 1] ?? "";
    assert.ok(commandText.includes("'--base' 'release'"));
    assert.ok(commandText.includes("'--resume' 'resume-release-base'"));
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousCommand;
    if (previousHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = previousHandle;
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(temp, { force: true, recursive: true });
  }
});
