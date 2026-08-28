import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
  installAbortReaping,
  main,
  reapAbortedRun,
  releaseWorker,
  startWorkerWithFallback,
  type OrcaOperations,
  type WorkerResult,
} from "../scripts/orca-no-mistakes.ts";

const OID = "a".repeat(40);

function orcaStub(overrides: Partial<OrcaOperations> = {}): OrcaOperations {
  return {
    async completeTask() {},
    async createGate() {
      return "gate";
    },
    async createRun() {
      return "run";
    },
    async createTask() {
      return "task";
    },
    async finishWorker() {},
    async removeWorktree() {},
    async setWorktreeStatus() {},
    async startWorker(taskId) {
      return {
        dispatchId: "dispatch",
        report: { findings: [], summary: "clean", tested: [] },
        taskId,
      };
    },
    async waitForGate() {
      return "approve";
    },
    ...overrides,
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("abort takes cleanup ownership before worker worktree removal", async () => {
  let finishStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    finishStarted = resolve;
  });
  let releaseFinish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseFinish = resolve;
  });
  let finishes = 0;
  const removals: string[] = [];
  const worker: WorkerResult = {
    dispatchId: "dispatch",
    report: { findings: [], summary: "clean", tested: [] },
    taskId: "task",
    worktreeId: "worker",
    worktreePath: "/worker",
  };
  const orca = orcaStub({
    async finishWorker() {
      finishes += 1;
      if (finishes === 1) {
        finishStarted();
        await blocked;
      }
    },
    async removeWorktree(id) {
      removals.push(id);
    },
    async startWorker() {
      return worker;
    },
  });
  await installAbortReaping({ orca, orcaCommand: "orca", pid: process.pid });
  await startWorkerWithFallback(orca, async () => "task", [
    {
      commitOid: OID,
      name: "reviewer",
      prompt: "review",
      role: "reviewer",
      stage: "review",
      worktree: "new-child",
    },
  ]);

  const release = releaseWorker(worker, orca);
  await started;
  const reap = reapAbortedRun("signal during release");
  releaseFinish();
  await Promise.all([release, reap]);

  assert.equal(finishes, 2);
  assert.deepEqual(removals, []);
});

test("launcher marker hands ownership from its pid to the terminal", async () => {
  const source = await readFile(
    new URL("../scripts/orca-no-mistakes.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function writeLauncherGateMarker(");
  const end = source.indexOf(
    "export async function registerAbortRunContext",
    start,
  );
  const markerWriter = source.slice(start, end);

  assert.match(markerWriter, /abortReap\.pid = process\.pid;/u);
  assert.match(
    markerWriter,
    /delete abortReap\.pid;\s+abortReap\.terminalHandle = terminalHandle;/u,
  );
});

test("stranded prune retains a gate with a live attached terminal", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "onm-gate-terminal-")),
  );
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousOrca = process.env.ORCA_CLI_COMMAND;
  try {
    execFileSync("git", ["-c", "init.templateDir=", "init", "-b", "main"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], {
      cwd: root,
    });
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const gateName = "no-mistakes-gate-live";
    const gatePath = path.join(root, ".orca", "workspaces", gateName);
    const gateId = `repo::${gatePath}`;
    const originId = `repo::${root}`;
    execFileSync("git", ["branch", gateName, head], { cwd: root });
    await mkdir(gatePath, { recursive: true });
    const marker = path.join(
      root,
      ".orca",
      "no-mistakes",
      `gate-${encodeURIComponent(gateId)}.json`,
    );
    await mkdir(path.dirname(marker), { recursive: true });
    const dead = spawnSync(process.execPath, ["-e", ""]);
    assert.ok(dead.pid !== undefined);
    await writeFile(
      marker,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        gate: { branch: gateName, id: gateId, kind: "orca", path: gatePath },
        originWorktree: root,
        pid: dead.pid,
      }),
    );
    const calls = path.join(root, "orca-calls.log");
    const fakeOrca = path.join(root, "orca");
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
if (args[0] === "worktree" && args[1] === "list") {
  console.log(JSON.stringify({ok:true,result:{worktrees:[
    {id:${JSON.stringify(originId)},path:${JSON.stringify(root)},branch:"refs/heads/main",head:${JSON.stringify(head)}},
    {id:${JSON.stringify(gateId)},path:${JSON.stringify(gatePath)},branch:${JSON.stringify(`refs/heads/${gateName}`)},head:${JSON.stringify(head)},parentWorktreeId:${JSON.stringify(originId)}}
  ]}}))
} else if (args[0] === "terminal" && args[1] === "list") {
  console.log(JSON.stringify({ok:true,result:{terminals:[{handle:"term-live",connected:true}]}}))
} else {
  console.error(JSON.stringify({ok:false,error:{code:"unexpected"}}))
  process.exit(1)
}
`,
    );
    await chmod(fakeOrca, 0o755);
    process.env.ORCA_CLI_COMMAND = fakeOrca;
    process.env.ORCA_NO_MISTAKES_HOME = path.join(root, "home");

    await main(["prune", "--stranded", "--repo", root]);

    assert.ok(existsSync(marker));
    assert.notEqual(
      execFileSync("git", ["branch", "--list", gateName], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      "",
    );
    const invoked = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      invoked.some((args) => args[0] === "worktree" && args[1] === "rm"),
      false,
    );
  } finally {
    restoreEnv("ORCA_NO_MISTAKES_HOME", previousHome);
    restoreEnv("ORCA_CLI_COMMAND", previousOrca);
    await rm(root, { force: true, recursive: true });
  }
});
