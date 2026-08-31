import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { spawn } from "node-pty";

import { PIPELINE_STEPS, type StageName } from "../scripts/config.ts";
import type { PresentationSnapshot } from "../scripts/presentation.ts";
import {
  createRailTuiRenderer,
  RailTuiRenderer,
  supportsRailTui,
} from "../scripts/tui.ts";

function snapshot(stage: StageName, sequence: number): PresentationSnapshot {
  return {
    attempt: 1,
    currentStage: stage,
    mode: { autoFix: true },
    runId: "run-tui-test",
    sequence,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      id,
      round: 1,
      status:
        id === stage || (stage === "review" && id === "rebase")
          ? "active"
          : "pending",
      totalFindings: 0,
    })),
    status: "in-progress",
    transition: { kind: "stage-started", stage },
    updatedAt: new Date(0).toISOString(),
    version: 1,
  };
}

async function runFixture(): Promise<void> {
  const artifactsDir = process.env.TUI_ARTIFACTS!;
  const before = `${process.stdin.isRaw === true}:${process.stdin.isPaused()}`;
  const renderer = new RailTuiRenderer(
    process.stdin,
    process.stderr,
    artifactsDir,
  );
  renderer.render(snapshot("review", 1));
  process.stdin.on("data", (chunk) => {
    const input = chunk.toString();
    if (input.includes("n")) renderer.render(snapshot("lint", 2));
    if (input.includes("q")) {
      renderer.close();
      const after = `${process.stdin.isRaw === true}:${process.stdin.isPaused()}`;
      process.stdout.write(`\nTUI CLOSED restored=${before === after}\n`, () =>
        process.exit(0),
      );
    }
  });
  await new Promise<void>(() => undefined);
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

function cleanScreen(output: string): string {
  const screen = output.split("\u001b[H\u001b[2J").at(-1) ?? output;
  return screen
    .replaceAll(new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "gu"), "")
    .replaceAll("\r", "");
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

if (process.env.TUI_FIXTURE === "1") {
  await runFixture();
} else {
  test("unsupported terminals fall back without terminal setup", () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    input.isTTY = false;
    assert.equal(supportsRailTui(input, output, "xterm-256color"), false);
    assert.equal(supportsRailTui(new FakeInput(), output, "dumb"), false);
    assert.equal(createRailTuiRenderer(input, output, "/unused"), undefined);
    assert.deepEqual(output.writes, []);
  });

  test("renderer errors restore raw mode, cursor, and alternate screen", () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const renderer = new RailTuiRenderer(input, output, "/unused");
    assert.throws(() => renderer.render({ ...snapshot("review", 1), stages: [] }));
    assert.equal(input.isRaw, false);
    assert.equal(input.isPaused(), true);
    assert.equal(output.writes[0], "\u001b[?1049h\u001b[?25l");
    assert.equal(output.writes.at(-1), "\u001b[?25h\u001b[?1049l");
  });

  test(
    "PTY Rail follows, pins, navigates, resizes, and restores the terminal",
    { timeout: 10_000 },
    async () => {
      const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-"));
      ensurePtyHelperExecutable();
      writeFileSync(
        path.join(artifactsDir, "review_r1.log"),
        "review token=[REDACTED]\n",
      );
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const terminal = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url)],
        {
          cols: 100,
          cwd: process.cwd(),
          env: {
            ...env,
            TERM: "xterm-256color",
            TUI_ARTIFACTS: artifactsDir,
            TUI_FIXTURE: "1",
          },
          name: "xterm-256color",
          rows: 24,
        },
      );
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
      const waitFor = async (predicate: () => boolean): Promise<void> => {
        const deadline = Date.now() + 3_000;
        while (!predicate()) {
          if (Date.now() >= deadline) {
            assert.fail(`Timed out waiting for TUI output:\n${cleanScreen(output)}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      const screen = (): string => cleanScreen(output);

      try {
        await waitFor(() => screen().includes("RECENT ACTIVITY"));
        const initial = screen();
        const labels = [
          "1. Intent",
          "2. Rebase",
          "3. Review",
          "4. Test",
          "5. Document",
          "6. Lint",
        ];
        assert.ok(
          labels.every(
            (label, index) =>
              index === 0 ||
              initial.indexOf(labels[index - 1]) < initial.indexOf(label),
          ),
        );
        assert.equal(initial.match(/\[>\]/gu)?.length, 1);

        terminal.write("\r");
        await waitFor(
          () =>
            screen().includes("pinned Review") &&
            screen().includes("review token=[REDACTED]"),
        );
        terminal.write("n");
        await waitFor(
          () =>
            screen().includes("Lint started") &&
            screen().includes("pinned Review"),
        );
        assert.equal(screen().match(/\[>\]/gu)?.length, 1);

        terminal.resize(60, 15);
        await waitFor(() => screen().includes("Terminal too small"));
        terminal.resize(100, 24);
        await waitFor(
          () =>
            screen().includes("pinned Review") &&
            screen().includes("review token=[REDACTED]"),
        );

        terminal.write("\u001b");
        await waitFor(
          () =>
            !screen().includes("pinned Review") &&
            screen().includes("> [>] 6. Lint"),
        );
        terminal.write("\u001b[Z");
        await waitFor(() => screen().includes("Up/Down scroll"));
        assert.ok(!screen().includes("Enter open"));
        terminal.write("\t\t");
        await waitFor(() => screen().includes("Enter open"));
        terminal.write("\u001b[A\r");
        await waitFor(() => screen().includes("pinned Review"));

        terminal.resize(72, 18);
        await waitFor(
          () =>
            screen().includes("RAIL") && !screen().includes("RECENT ACTIVITY"),
        );
        terminal.write("q");
        assert.equal(await exited, 0);
        assert.match(output, /TUI CLOSED restored=true/u);
        assert.ok(output.includes("\u001b[?25h\u001b[?1049l"));
      } finally {
        if (!hasExited) terminal.kill("SIGKILL");
        rmSync(artifactsDir, { force: true, recursive: true });
      }
    },
  );

  test.after(() => console.log("TUI INTEGRATION PASSED"));
}
