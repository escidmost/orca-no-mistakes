import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CliOrca } from "../scripts/orca-no-mistakes.ts";

async function fakeOrca(
  temp: string,
  deliveries: { messages: unknown[] }[],
): Promise<{ calls: string; command: string }> {
  const calls = path.join(temp, "calls.jsonl");
  const command = path.join(temp, "orca");
  await writeFile(
    command,
    `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
const deliveries = ${JSON.stringify(deliveries)}
const checks = fs.readFileSync(${JSON.stringify(calls)}, "utf8")
  .trim().split("\\n").map((line) => JSON.parse(line))
  .filter((call) => call[1] === "check" && call.includes("--unread")).length
if (args[0] === "orchestration" && args[1] === "gate-list") {
  out({ gates: [{ id: "gate-1", status: checks > deliveries.length ? "resolved" : "pending", resolution: "reply: go" }] })
} else if (args[0] === "orchestration" && args[1] === "check" && args.includes("--unread")) {
  const delivery = deliveries[checks - 1]
  out(delivery ? { deliveryId: "delivery-" + checks, messages: delivery.messages } : { messages: [] })
} else if (args[0] === "orchestration" && args[1] === "gate-resolve") {
  out({ gate: { id: "gate-1", status: "resolved" } })
} else {
  out({ accepted: true })
}
`,
  );
  await chmod(command, 0o755);
  return { calls, command };
}

async function readCalls(calls: string): Promise<string[][]> {
  return (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

test("a human gate wait leaves worker lifecycle messages for the worker inbox", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-gate-inbox-"));
  try {
    const fake = await fakeOrca(temp, [
      {
        messages: [
          {
            body: "done",
            from_handle: "worker-term",
            subject: "review fix applied",
            type: "worker_done",
          },
        ],
      },
      {
        messages: [
          {
            body: JSON.stringify({ gateId: "gate-1", resolution: "reply: go" }),
            from_handle: "origin-term",
            subject: "no-mistakes gate response",
            type: "question",
          },
        ],
      },
    ]);
    const orca = new CliOrca({
      command: fake.command,
      cwd: temp,
      notifyHandle: "origin-term",
      runId: "run-gate-inbox",
    });
    assert.equal(await orca.waitForGate("gate-1"), "reply: go");
    const acked = (await readCalls(fake.calls))
      .filter((call) => call.includes("--ack"))
      .map((call) => call[call.indexOf("--ack") + 1]);
    assert.ok(
      !acked.includes("delivery-1"),
      "the worker_done delivery must stay unacknowledged for the worker inbox",
    );
    assert.deepEqual(acked, ["delivery-2"]);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});
