import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PIPELINE_STEPS } from "../scripts/config.ts";
import { StageLog } from "../scripts/ledger.ts";
import type { PresentationSnapshot } from "../scripts/presentation.ts";
import { RailTuiRenderer } from "../scripts/tui.ts";

class FakeInput extends EventEmitter {
  isRaw = false;
  isTTY = true;
  paused = true;

  isPaused(): boolean {
    return this.paused;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

class FakeOutput extends EventEmitter {
  columns = 100;
  isTTY = true;
  rows = 24;
  readonly writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

function snapshot(): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: "review",
    mode: { autoFix: true },
    runId: "run-tui-logtail-batched",
    sequence: 1,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      id,
      round: 1,
      status: id === "review" ? "active" : "pending",
      totalFindings: 0,
    })),
    status: "in-progress",
    transition: { kind: "round-started", round: 1, stage: "review" },
    updatedAt: new Date(0).toISOString(),
    version: 1,
  };
}

test("log tail keeps redaction and printable mapping in the batched path", async () => {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-logtail-"));
  const logPath = path.join(artifactsDir, "review_r1.log");
  const log = new StageLog(logPath);
  const input = new FakeInput();
  const output = new FakeOutput();
  const secretName = "TUI_LOGTAIL_BATCH_REDACTION_TEST_TOKEN";
  const previous = process.env[secretName];
  process.env[secretName] = "tuiLt0SecretZZ";
  await log.append(
    "split tuiLt0\u001b[31mSecretZZ end\nplain a\tb c\x01d end\n",
  );
  const renderer = new RailTuiRenderer(
    input,
    output,
    artifactsDir,
    new Map([[path.resolve(logPath), log]]),
  );
  try {
    renderer.render(snapshot());
    input.emit("data", "\r");
    await new Promise((resolve) => setImmediate(resolve));
    const screen = (output.writes.at(-1) ?? "")
      .replace(new RegExp("^.*\\x1b\\[H\\x1b\\[2J", "u"), "")
      .replaceAll(new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "gu"), "");
    assert.doesNotMatch(screen, /tuiLt0|SecretZZ/u);
    assert.match(screen, /\[REDACTED\]/u);
    assert.match(screen, /a {2}b c\?d/u);
  } finally {
    renderer.close();
    await log.close();
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
    rmSync(artifactsDir, { force: true, recursive: true });
  }
});
