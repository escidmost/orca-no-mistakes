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
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const result = args[0] === "orchestration" && args[1] === "gate-create"
  ? { gate: { id: "gate-resume" } }
  : {}
console.log(JSON.stringify({ result }))
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

test("a detached resume gate requires a durable orchestration response", async () => {
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
    await orca.createGate(
      "task-resume",
      "Review failed resumably. Resume from the durable checkpoint?",
      ["resume", "stop"],
    );

    const calls = await invocations(fake.calls);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0]?.slice(0, 2), ["orchestration", "gate-create"]);
    assert.ok(calls[0]?.includes('["resume","stop"]'));
    assert.deepEqual(calls[1]?.slice(0, 2), ["orchestration", "send"]);
    const body = calls[1]?.[calls[1].indexOf("--body") + 1] ?? "";
    assert.match(body, /Gate: gate-resume/);
    assert.match(body, /orchestration send/);
    assert.match(body, /no-mistakes gate response/);
    assert.match(body, /Do not inject terminal input/);
    assert.deepEqual(calls[2]?.slice(0, 2), ["terminal", "send"]);
    const prompt = calls[2]?.[calls[2].indexOf("--text") + 1] ?? "";
    assert.match(prompt, /Review failed resumably/);
    assert.match(prompt, /orchestration send/);
    assert.doesNotMatch(prompt, /send R to resume/i);
  } finally {
    if (priorHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = priorHandle;
    await rm(fake.root, { force: true, recursive: true });
  }
});
