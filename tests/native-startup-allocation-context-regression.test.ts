import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CliOrca,
  installAbortReaping,
  startWorkerWithFallback,
} from "../scripts/orca-no-mistakes.ts";

test("native startup observes dispatch outside allocation custody", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-native-allocation-"));
  const fakeOrca = path.join(temp, "orca");
  const callsPath = path.join(temp, "calls.jsonl");
  const origin = path.join(temp, "origin");
  const gate = {
    branch: "gate-native-allocation",
    id: `repo::${path.join(temp, "gate")}`,
    kind: "orca" as const,
    path: path.join(temp, "gate"),
  };
  const markerPath = path.join(
    origin,
    ".orca",
    "no-mistakes",
    `gate-${createHash("sha256").update(gate.id).digest("hex").slice(0, 32)}.json`,
  );
  try {
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
let marker
try { marker = JSON.parse(fs.readFileSync(${JSON.stringify(markerPath)}, "utf8")) } catch {}
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, marker, pid: process.pid }) + "\\n")
const out = (result) => console.log(JSON.stringify({ result }))
if (args[0] === "orchestration" && args[1] === "worker-start") {
  console.error("startup failed")
  process.exit(1)
}
if (args[0] === "orchestration" && args[1] === "dispatch-show") out({ dispatch: {} })
else out({ ok: true })
`,
    );
    await chmod(fakeOrca, 0o755);
    const orca = new CliOrca({ command: fakeOrca, cwd: temp });
    await installAbortReaping({
      gate,
      orca,
      orcaCommand: fakeOrca,
      originWorktree: origin,
      pid: process.pid,
    });

    await assert.rejects(
      startWorkerWithFallback(
        orca,
        async () => "task-native",
        [
          {
            agent: { harness: "cursor" },
            name: "native-review",
            prompt: "review",
            role: "reviewer",
            stage: "review",
            worktree: "current",
          },
        ],
      ),
    );

    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            marker?: { workerAllocationPids?: Record<string, number[]> };
            pid: number;
          },
      );
    const tracked = ({ marker, pid }: (typeof calls)[number]) =>
      Object.values(marker?.workerAllocationPids ?? {}).some((pids) =>
        pids.includes(pid),
      );
    const observerCalls = calls.filter(
      ({ args }) => args[0] === "orchestration" && args[1] === "dispatch-show",
    );
    assert.ok(observerCalls.length > 0);
    assert.ok(observerCalls.every((call) => !tracked(call)));
    assert.ok(tracked(calls.find(({ args }) => args[1] === "worker-start")!));
  } finally {
    await installAbortReaping({ pid: process.pid });
    await rm(temp, { recursive: true, force: true });
  }
});
