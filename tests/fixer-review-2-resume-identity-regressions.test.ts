import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  evidenceSha256,
  gateAuditMatchesEvidence,
  type StageEvidenceManifestEntry,
} from "../scripts/ledger.ts";
import { main, sha256, type Finding } from "../scripts/orca-no-mistakes.ts";

const oid = (value: number): string => value.toString(16).padStart(40, "0");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function recordEvidence(
  ledger: DomainLedger,
  directory: string,
  input: {
    baseCommitOid: string;
    baseRefSha: string;
    candidateCommitOid: string;
    effectivePolicyHash: string;
    findings: Finding[];
    round: number;
    runId: string;
    stage: string;
    summary: string;
  },
): Promise<StageEvidenceManifestEntry> {
  const artifactPath = path.join(directory, `${input.summary}.json`);
  const artifact = JSON.stringify({
    base_ref_sha: input.baseRefSha,
    effective_policy_hash: input.effectivePolicyHash,
    findings: input.findings,
  });
  await writeFile(artifactPath, artifact);
  const artifactSha256 = sha256(artifact);
  const workerIdentity = `worker:${input.summary}`;
  const digest = evidenceSha256({
    artifactSha256,
    baseCommitOid: input.baseCommitOid,
    candidateCommitOid: input.candidateCommitOid,
    exitCode: 1,
    round: input.round,
    runId: input.runId,
    stage: input.stage,
    summary: input.summary,
    workerIdentity,
  });
  ledger.recordEvidence({
    artifactPath,
    artifactSha256,
    baseCommitOid: input.baseCommitOid,
    baseRefSha: input.baseRefSha,
    candidateCommitOid: input.candidateCommitOid,
    effectivePolicyHash: input.effectivePolicyHash,
    evidenceSha256: digest,
    exitCode: 1,
    findingsJson: JSON.stringify(input.findings),
    roundIndex: input.round,
    runId: input.runId,
    stageId: input.stage,
    summary: input.summary,
    workerIdentity,
  });
  return {
    artifactSha256,
    baseCommitOid: input.baseCommitOid,
    candidateCommitOid: input.candidateCommitOid,
    evidenceSha256: digest,
    exitCode: 1,
    round: input.round,
    stage: input.stage,
    summary: input.summary,
    workerIdentity,
  };
}

test("gate decisions remain bound to their exact evidence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "onm-gate-evidence-"));
  const ledger = new DomainLedger(":memory:");
  const runId = "gate-evidence-run";
  const repoRoot = "/repo";
  const branch = "feature";
  const baseCommitOid = oid(10);
  const effectivePolicyHash = "a".repeat(64);
  const oldFindings: Finding[] = [
    {
      action: "ask-user",
      description: "Old finding.",
      id: "old-finding",
      severity: "error",
    },
  ];
  const newFindings: Finding[] = [
    {
      action: "ask-user",
      description: "New finding.",
      id: "new-finding",
      severity: "error",
    },
  ];
  ledger.startRun({
    baseBranch: "main",
    branch,
    intent: "Keep decisions evidence-specific.",
    policySha256: "b".repeat(64),
    repoRoot,
    runId,
    submissionCommitOid: oid(1),
  });

  try {
    const oldEvidence = await recordEvidence(ledger, directory, {
      baseCommitOid,
      baseRefSha: baseCommitOid,
      candidateCommitOid: oid(2),
      effectivePolicyHash,
      findings: oldFindings,
      round: 0,
      runId,
      stage: "review",
      summary: "old",
    });
    ledger.recordGateAudit({
      decision: "approve",
      evidenceSha256: oldEvidence.evidenceSha256,
      gateId: "gate-old",
      optionsJson: '["approve"]',
      question: "Approve old evidence?",
      resolution: "approve",
      roundIndex: 0,
      runId,
      selectedFindingIds: ["old-finding"],
      stageId: "review",
    });
    const newEvidence = await recordEvidence(ledger, directory, {
      baseCommitOid,
      baseRefSha: baseCommitOid,
      candidateCommitOid: oid(2),
      effectivePolicyHash,
      findings: newFindings,
      round: 0,
      runId,
      stage: "review",
      summary: "new",
    });
    const [audit] = ledger.listGateAudit(runId);

    assert.equal(
      gateAuditMatchesEvidence(
        audit,
        "review",
        newEvidence.round,
        newEvidence.evidenceSha256,
      ),
      false,
    );
    const history = ledger.listFindingDecisions({ branch, repoRoot, runId });
    assert.deepEqual(JSON.parse(history.decisions[0].findings_json), oldFindings);
    assert.deepEqual(
      ledger.attestationBlockers(runId, [
        oldEvidence,
        {
          ...newEvidence,
          waiverOrApproval: {
            decision: "approve",
            gateId: audit.gate_id,
            resolvedAt: audit.resolved_at!,
          },
        },
      ]),
      [
        "review round 0: 1 unaddressed finding(s) and no recorded waiver or approval",
      ],
    );
  } finally {
    ledger.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("resume rejects evidence from a changed base ref", async () => {
  const ledger = new DomainLedger(":memory:");
  const runId = "changed-base-run";
  const repoRoot = "/repo";
  const branch = "feature";
  const oldBase = oid(10);
  const head = oid(2);
  const effectivePolicyHash = "c".repeat(64);
  const policySha256 = "d".repeat(64);
  ledger.startRun({
    baseBranch: "main",
    branch,
    intent: "Reject mixed-base evidence.",
    policySha256,
    repoRoot,
    runId,
    submissionCommitOid: head,
  });
  ledger.acquireLease({ branch, repoRoot, runId });
  ledger.recordEvidence({
    artifactPath: "/tmp/evidence.json",
    artifactSha256: "e".repeat(64),
    baseCommitOid: oldBase,
    baseRefSha: oldBase,
    candidateCommitOid: head,
    effectivePolicyHash,
    evidenceSha256: "f".repeat(64),
    exitCode: 0,
    findingsJson: "[]",
    roundIndex: 0,
    runId,
    stageId: "intent",
    summary: "intent passed",
    workerIdentity: "coordinator:intent",
  });
  ledger.recordCheckpoint({
    inputCommitOid: head,
    outputCommitOid: head,
    roundIndex: 0,
    runId,
    stageId: "intent",
  });
  ledger.settleRun(runId, "failed", { branch, repoRoot });

  try {
    assert.throws(
      () =>
        ledger.prepareResume({
          baseBranch: "main",
          baseRefSha: oid(11),
          branch,
          effectivePolicyHash,
          head,
          intent: "Reject mixed-base evidence.",
          policySha256,
          repoRoot,
          runId,
        }),
      /base ref changed since it failed/,
    );
    assert.equal(ledger.runStatus(runId), "failed");
    assert.equal(ledger.leaseFor(repoRoot, branch), undefined);
  } finally {
    ledger.close();
  }
});

test("resumed Orca worktree setup starts at the checkpoint", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "onm-resume-setup-"));
  const origin = path.join(directory, "origin.git");
  const repo = path.join(directory, "repo");
  const gate = path.join(directory, "gate");
  const home = path.join(directory, "home");
  const fakeOrca = path.join(directory, "orca");
  const callsPath = path.join(directory, "calls.jsonl");
  const previousCommand = process.env.ORCA_CLI_COMMAND;
  const previousHandle = process.env.ORCA_TERMINAL_HANDLE;
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;

  try {
    git(directory, "-c", "init.templateDir=", "init", "--bare", origin);
    git(directory, "-c", "init.templateDir=", "init", "-b", "main", repo);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "commit.gpgsign", "false");
    await writeFile(path.join(repo, "README.md"), "main\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "main");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-u", "origin", "main");
    git(directory, `--git-dir=${origin}`, "symbolic-ref", "HEAD", "refs/heads/main");
    git(repo, "checkout", "-b", "feature");
    await writeFile(path.join(repo, "feature.txt"), "checkpoint\n");
    git(repo, "add", "feature.txt");
    git(repo, "commit", "-m", "checkpoint");
    const checkpoint = git(repo, "rev-parse", "HEAD");
    await writeFile(path.join(repo, "feature.txt"), "tip\n");
    git(repo, "commit", "-am", "tip");
    const tip = git(repo, "rev-parse", "HEAD");
    await mkdir(gate);
    await mkdir(home);

    process.env.ORCA_CLI_COMMAND = fakeOrca;
    process.env.ORCA_TERMINAL_HANDLE = "origin-terminal";
    process.env.ORCA_NO_MISTAKES_HOME = home;
    const ledger = new DomainLedger();
    ledger.startRun({
      baseBranch: "main",
      branch: "feature",
      intent: "Resume from the durable checkpoint.",
      policySha256: "a".repeat(64),
      repoRoot: await realpath(repo),
      runId: "resume-setup-run",
      submissionCommitOid: tip,
    });
    ledger.recordCheckpoint({
      inputCommitOid: checkpoint,
      outputCommitOid: checkpoint,
      roundIndex: 0,
      runId: "resume-setup-run",
      stageId: "review",
    });
    ledger.finishRun("resume-setup-run", "failed", checkpoint);
    ledger.close();

    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n")
if (args[0] === "terminal" && args[1] === "send") {
  const markerDirectory = ${JSON.stringify(path.join(repo, ".orca", "no-mistakes"))}
  const markerFile = fs.readdirSync(markerDirectory)
    .map((name) => markerDirectory + "/" + name)
    .find((file) => file.endsWith(".json") && JSON.parse(fs.readFileSync(file, "utf8")).startupReceipt)
  const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"))
  delete marker.launcherPid
  marker.pid = process.ppid
  fs.writeFileSync(markerFile, JSON.stringify(marker))
}
const gateName = args[args.indexOf("--name") + 1]
const result = args[0] === "worktree" && args[1] === "create"
  ? { worktree: { id: "gate-id", path: ${JSON.stringify(gate)}, branch: "refs/heads/evs/" + gateName } }
  : args[0] === "terminal" && args[1] === "list"
    ? { terminals: [{ handle: "gate-shell", connected: true, writable: true }] }
    : args[0] === "terminal" && args[1] === "show"
      ? { terminal: { connected: true, preview: "ready shell prompt" } }
      : { accepted: true }
console.log(JSON.stringify({ result }))
`,
    );
    await chmod(fakeOrca, 0o755);

    await main([
      "run",
      `--repo=${repo}`,
      "--resume=resume-setup-run",
    ]);

    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const create = calls.find(
      (args) => args[0] === "worktree" && args[1] === "create",
    )!;
    assert.equal(create[create.indexOf("--base-branch") + 1], checkpoint);
    assert.equal(create[create.indexOf("--setup") + 1], "run");
  } finally {
    if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousCommand;
    if (previousHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = previousHandle;
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(directory, { force: true, recursive: true });
  }
});
