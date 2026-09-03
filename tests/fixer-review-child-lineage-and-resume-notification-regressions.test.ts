import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CliOrca } from "../scripts/orca-no-mistakes.ts";

async function fakeOrca(): Promise<{
  calls: string;
  command: string;
  root: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "onm-child-lineage-"));
  const calls = path.join(root, "calls.jsonl");
  const command = path.join(root, "orca");
  await writeFile(
    command,
    `#!/usr/bin/env node
import fs from "node:fs"
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n")
console.log(JSON.stringify({ result: {} }))
`,
  );
  await chmod(command, 0o755);
  return { calls, command, root };
}

async function invocations(calls: string): Promise<string[][]> {
  return (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

test("managed gate children retain their parent workspace lane", async () => {
  const fake = await fakeOrca();
  const priorGateId = process.env.NO_MISTAKES_GATE_WORKTREE_ID;
  process.env.NO_MISTAKES_GATE_WORKTREE_ID = "gate-child";
  try {
    const orca = new CliOrca({ command: fake.command, cwd: fake.root });
    await orca.setWorktreeStatus("no-mistakes waiting for resume", "in-review");

    const [args] = await invocations(fake.calls);
    assert.ok(args.includes("--comment"));
    assert.equal(args.includes("--workspace-status"), false);
  } finally {
    if (priorGateId === undefined) delete process.env.NO_MISTAKES_GATE_WORKTREE_ID;
    else process.env.NO_MISTAKES_GATE_WORKTREE_ID = priorGateId;
    await rm(fake.root, { force: true, recursive: true });
  }
});

test("a detached resumable wait notifies and wakes its spawning terminal", async () => {
  const fake = await fakeOrca();
  const priorHandle = process.env.ORCA_TERMINAL_HANDLE;
  process.env.ORCA_TERMINAL_HANDLE = "coordinator-terminal";
  try {
    const orca = new CliOrca({
      command: fake.command,
      cwd: fake.root,
      notifyHandle: "origin-terminal",
      runId: "run-resumable",
    });
    await (orca as CliOrca & { notifyResumeRequired(message: string): Promise<void> })
      .notifyResumeRequired("review worker returned an invalid report");

    const calls = await invocations(fake.calls);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]?.slice(0, 2), ["orchestration", "send"]);
    assert.ok(calls[0]?.includes("no-mistakes resume decision required"));
    assert.ok(calls[0]?.includes("question"));
    const body = calls[0]?.[calls[0].indexOf("--body") + 1] ?? "";
    assert.match(body, /coordinator-terminal/);
    assert.match(body, /send R to resume/i);
    assert.match(body, /send C to leave/i);
    assert.deepEqual(calls[1]?.slice(0, 2), ["terminal", "send"]);
    const prompt = calls[1]?.[calls[1].indexOf("--text") + 1] ?? "";
    assert.match(prompt, /review worker returned an invalid report/);
    assert.match(prompt, /coordinator-terminal/);
    assert.match(prompt, /send R to resume/i);
    assert.match(prompt, /send C to leave/i);
  } finally {
    if (priorHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = priorHandle;
    await rm(fake.root, { force: true, recursive: true });
  }
});
