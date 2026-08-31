import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { spawn } from "node-pty";

import { PIPELINE_STEPS } from "../scripts/config.ts";
import type { PresentationSnapshot } from "../scripts/presentation.ts";
import { RailTuiRenderer } from "../scripts/tui.ts";

function snapshot(sequence: number): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: "review",
    mode: { autoFix: true },
    runId: "run-tui-regression",
    sequence,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      id,
      round: 1,
      status: id === "review" ? "active" : "pending",
      totalFindings: 0,
    })),
    status: "in-progress",
    transition: { kind: "round-started", round: sequence, stage: "review" },
    updatedAt: new Date(0).toISOString(),
    version: 1,
  };
}

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

function screen(output: FakeOutput): string {
  return (output.writes.at(-1) ?? "")
    .replace(/^.*\u001b\[H\u001b\[2J/u, "")
    .replaceAll(new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "gu"), "");
}

function ensurePtyHelperExecutable(): void {
  if (process.platform !== "darwin") return;
  const nodePtyDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.resolve("node-pty"))),
    "..",
  );
  chmodSync(
    path.join(
      nodePtyDir,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    ),
    0o755,
  );
}

async function runCtrlCFixture(): Promise<void> {
  process.once("SIGINT", () => {
    process.stdout.write(
      `SIGINT raw=${process.stdin.isRaw === true}\n`,
      () => process.exit(0),
    );
  });
  const renderer = new RailTuiRenderer(
    process.stdin,
    process.stderr,
    process.env.TUI_ARTIFACTS!,
  );
  renderer.render(snapshot(1));
  await new Promise<void>(() => undefined);
}

if (process.env.TUI_CTRL_C_FIXTURE === "1") {
  await runCtrlCFixture();
} else {
  test("full rows and local viewports stay within bounds", () => {
    const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-regression-"));
    const input = new FakeInput();
    const output = new FakeOutput();
    writeFileSync(
      path.join(artifactsDir, "review_r1.log"),
      "first line\nsecond line\nthird line\n",
    );
    const renderer = new RailTuiRenderer(input, output, artifactsDir);
    try {
      for (let sequence = 1; sequence <= 30; sequence += 1) {
        renderer.render(snapshot(sequence));
      }
      for (const columns of [100, 137]) {
        output.columns = columns;
        output.emit("resize");
        assert.ok(
          screen(output)
            .split("\n")
            .every((line) => line.length <= columns),
        );
      }

      input.emit("data", `\t${"\u001b[A".repeat(21)}`);
      assert.match(screen(output), /> Review round 9/u);

      input.emit("data", `\t${"\u001b[A".repeat(100)}`);
      assert.match(screen(output), /third line/u);
    } finally {
      renderer.close();
      rmSync(artifactsDir, { force: true, recursive: true });
    }
  });

  test("raw Ctrl-C restores the terminal before SIGINT", { timeout: 10_000 }, async () => {
    const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-sigint-"));
    ensurePtyHelperExecutable();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const terminal = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cols: 100,
      cwd: process.cwd(),
      env: {
        ...env,
        TERM: "xterm-256color",
        TUI_ARTIFACTS: artifactsDir,
        TUI_CTRL_C_FIXTURE: "1",
      },
      name: "xterm-256color",
      rows: 24,
    });
    let output = "";
    let hasExited = false;
    terminal.onData((data) => {
      output += data;
    });
    const exited = new Promise<number>((resolve) =>
      terminal.onExit(({ exitCode }) => {
        hasExited = true;
        resolve(exitCode);
      }),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("TUI did not start")), 3_000);
        const disposable = terminal.onData(() => {
          if (!output.includes("RECENT ACTIVITY")) return;
          clearTimeout(timeout);
          disposable.dispose();
          resolve();
        });
      });
      terminal.write("\u0003");
      assert.equal(await exited, 0);
      assert.match(output, /SIGINT raw=false/u);
      assert.ok(output.includes("\u001b[?25h\u001b[?1049l"));
    } finally {
      if (!hasExited) terminal.kill("SIGKILL");
      rmSync(artifactsDir, { force: true, recursive: true });
    }
  });
}
