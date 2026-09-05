import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CliOrca } from "../scripts/orca-no-mistakes.ts";

test("failRun leaves terminal task history unchanged on retries", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-idempotent-fail-run-"));
  const calls = path.join(temp, "calls.jsonl");
  const command = path.join(temp, "orca");
  await writeFile(
    command,
    `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
if (args[0] === "orchestration" && args[1] === "task-list") {
  console.log(JSON.stringify({ result: { tasks: [
    { id: "task-completed", status: "completed" },
    { id: "task-failed", status: "failed" }
  ] } }))
} else {
  process.exitCode = 1
}
`,
  );
  await chmod(command, 0o755);
  try {
    const orca = new CliOrca({ command, cwd: temp, runId: "run-terminal" });
    await orca.failRun("first retry");
    await orca.failRun("second retry");

    const invocations = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(
      invocations.map((args) => args.slice(0, 2)),
      [
        ["orchestration", "task-list"],
        ["orchestration", "task-list"],
      ],
    );
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});
