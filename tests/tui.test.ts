import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { spawn } from "node-pty";

import { PIPELINE_STEPS, type StageName } from "../scripts/config.ts";
import { StageLog } from "../scripts/ledger.ts";
import type { PresentationSnapshot } from "../scripts/presentation.ts";
import {
  createRailTuiRenderer,
  createRunRenderer,
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

function gateSnapshot(
  state: "open" | "resolved",
  sequence: number,
  decision?: string,
): PresentationSnapshot {
  const base = snapshot("review", sequence);
  const options = ["approve", "fix", "skip", "stop"];
  return {
    ...base,
    gate: {
      decision,
      id: "gate-review",
      options,
      question: "Choose how to handle the unresolved review findings.",
      round: 1,
      stage: "review",
      state,
    },
    stages: base.stages.map((stage) =>
      stage.id === "review"
        ? { ...stage, status: state === "open" ? "blocked" : "active" }
        : stage,
    ),
    transition:
      state === "open"
        ? {
            gateId: "gate-review",
            kind: "gate-opened",
            options,
            question: "Choose how to handle the unresolved review findings.",
            round: 1,
            stage: "review",
          }
        : {
            decision: decision ?? "approve",
            gateId: "gate-review",
            kind: "gate-resolved",
            round: 1,
            stage: "review",
          },
  };
}

async function runFixture(): Promise<void> {
  const artifactsDir = process.env.TUI_ARTIFACTS!;
  const logPath = path.join(artifactsDir, "review_r1.log");
  const log = new StageLog(logPath);
  await log.append("review token=[REDACTED]\n");
  const before = `${process.stdin.isRaw === true}:${process.stdin.isPaused()}`;
  let renderer!: RailTuiRenderer;
  renderer = new RailTuiRenderer(
    process.stdin,
    process.stderr,
    artifactsDir,
    new Map([[path.resolve(logPath), log]]),
    async (gateId, resolution) => {
      process.stdout.write(`\nGATE ANSWER ${gateId} ${resolution}\n`);
      renderer.render(gateSnapshot("resolved", 3, resolution));
    },
    () => {
      const after = `${process.stdin.isRaw === true}:${process.stdin.isPaused()}`;
      void log.close().then(() => {
        process.stdout.write(`\nCANCEL REQUESTED restored=${before === after}\n`, () =>
          process.exit(0),
        );
      });
    },
  );
  renderer.render(snapshot("review", 1));
  process.stdin.on("data", (chunk) => {
    const input = chunk.toString();
    if (input.includes("d")) renderer.render(gateSnapshot("open", 2));
    if (input.includes("n")) renderer.render(snapshot("lint", 2));
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
  failNextWrite = false;
  isTTY = true;
  rows = 24;
  readonly writes: string[] = [];

  write(chunk: string): boolean {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("write failed");
    }
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
  const helper = path.join(
    nodePtyDir,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  if (existsSync(helper)) chmodSync(helper, 0o755);
}

if (process.env.TUI_FIXTURE === "1") {
  await runFixture();
} else {
  test("unsupported terminals fall back to plain status without terminal setup", () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    input.isTTY = false;
    assert.equal(supportsRailTui(input, output, "xterm-256color"), false);
    assert.equal(supportsRailTui(new FakeInput(), output, "dumb"), false);
    const renderer = createRunRenderer(input, output, "/unused");
    renderer.render(snapshot("review", 1));
    assert.deepEqual(output.writes, [
      "no-mistakes run-tui-test stage 3/6 review started\n",
    ]);
  });

  test("renderer errors restore raw mode, cursor, and alternate screen", () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const renderer = new RailTuiRenderer(input, output, "/unused");
    output.failNextWrite = true;
    assert.throws(() => renderer.render(snapshot("review", 1)));
    assert.equal(input.isRaw, false);
    assert.equal(input.isPaused(), true);
    assert.equal(output.writes[0], "\u001b[?1049h\u001b[?25l");
    assert.equal(output.writes.at(-1), "\u001b[?25h\u001b[?1049l");
  });

  test("Resume availability errors close the Rail renderer before fallback", () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const exitListeners = process.listenerCount("exit");
    const renderer = createRunRenderer(
      input,
      output,
      "/unused",
      undefined,
      undefined,
      undefined,
      undefined,
      () => {},
      () => {
        throw new Error("availability failed");
      },
    );

    assert.equal(input.isRaw, false);
    assert.equal(input.isPaused(), true);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(output.listenerCount("error"), 1);
    assert.equal(output.listenerCount("resize"), 0);
    assert.equal(process.listenerCount("exit"), exitListeners);
    assert.ok(output.writes.includes("\u001b[?25h\u001b[?1049l"));
    renderer.render(snapshot("review", 1));
    assert.equal(
      output.writes.at(-1),
      "no-mistakes run-tui-test stage 3/6 review started\n",
    );
  });

  test("unchanged refreshes do not repaint the terminal", () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const renderer = new RailTuiRenderer(input, output, "/unused");
    renderer.render(snapshot("review", 1));
    const writes = output.writes.length;
    output.emit("resize");
    assert.equal(output.writes.length, writes);
    renderer.close();
  });

  test("ONM-88 shows finding dispositions and toggles Auto-fix without settling a gate", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.rows = 20;
    const toggles: boolean[] = [];
    const resolutions: string[] = [];
    const renderer = new RailTuiRenderer(
      input,
      output,
      "/unused",
      new Map(),
      async (_gateId, resolution) => {
        resolutions.push(resolution);
      },
      undefined,
      (enabled) => {
        toggles.push(enabled);
      },
    );
    const base = gateSnapshot("open", 2);
    renderer.render({
      ...base,
      stages: base.stages.map((stage) =>
        stage.id === "review"
          ? {
              ...stage,
              approvedFindings: 1,
              findings: [
                {
                  description: "Still open",
                  disposition: "open" as const,
                  id: "open-finding",
                  severity: "warning" as const,
                },
              ],
              fixedFindings: 2,
              openFindings: 1,
              retainedFixer: true,
              totalFindings: 4,
            }
          : stage,
      ),
    });

    const screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, /auto-fix on/iu);
    assert.match(screen, /Review retained/iu);
    assert.match(screen, /2\/4 fixed 1 approved 1 open/iu);
    assert.match(screen, /6\. Lint/iu);
    assert.match(screen, /A Auto-fix/iu);
    input.emit("data", "A");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(toggles, [false]);
    assert.deepEqual(resolutions, []);
    renderer.close();
  });

  test("Resume is shown only for resumable errors and returns to the pipeline", () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    let requested = 0;
    let available = 0;
    let cancellations = 0;
    const renderer = createRailTuiRenderer(
      input,
      output,
      "/unused",
      new Map(),
      undefined,
      () => {
        cancellations += 1;
      },
      undefined,
      () => {
        requested += 1;
      },
      () => {
        available += 1;
      },
    );
    assert.ok(renderer);
    renderer.render(snapshot("review", 1));
    input.emit("data", "\r");
    assert.match(cleanScreen(output.writes.at(-1) ?? ""), /pinned Review/u);
    input.emit("data", "C");
    assert.match(cleanScreen(output.writes.at(-1) ?? ""), /CANCEL RUN\?/u);
    const resumable = snapshot("test", 2);
    renderer.render({
      ...resumable,
      currentStage: "test",
      error: { resumable: true },
      status: "failed",
      transition: { kind: "error-recorded", resumable: true },
    });
    const screen = (): string => cleanScreen(output.writes.at(-1) ?? "");
    assert.equal(available, 1);
    assert.match(screen(), /RUN ERROR \(RESUMABLE\)/u);
    assert.doesNotMatch(screen(), /CANCEL RUN\?/u);
    assert.match(screen(), /R Resume/u);
    input.emit("data", "R");
    assert.equal(requested, 1);
    assert.match(screen(), /Resume requested\. Waiting for the next attempt\./u);
    assert.doesNotMatch(screen(), /R Resume/u);

    renderer.render({
      ...resumable,
      currentStage: "test",
      error: { resumable: true },
      status: "failed",
      transition: { kind: "run-completed", status: "failed" },
    });
    assert.match(screen(), /Resume requested\. Waiting for the next attempt\./u);
    assert.doesNotMatch(screen(), /R Resume/u);
    input.emit("data", "R");
    assert.equal(requested, 1);

    renderer.render({
      ...resumable,
      attempt: 3,
      currentStage: "test",
      error: undefined,
      status: "in-progress",
      transition: { attempt: 3, kind: "attempt-started" },
    });
    assert.match(screen(), /RECENT ACTIVITY/u);
    assert.match(screen(), /Test LOG/u);
    assert.doesNotMatch(screen(), /pinned Review/u);
    assert.match(screen(), /> RAIL/u);
    assert.match(screen(), /> \[>\] 4\. Test/u);
    input.emit("data", "R");
    assert.equal(requested, 1);

    renderer.render({
      ...resumable,
      currentStage: "test",
      error: { resumable: false },
      status: "failed",
      transition: { kind: "error-recorded", resumable: false },
    });
    assert.doesNotMatch(screen(), /R Resume/u);
    input.emit("data", "R");
    assert.equal(requested, 1);
    input.emit("data", "C");
    assert.equal(cancellations, 1);
    assert.doesNotMatch(screen(), /CANCEL RUN\?/u);
    renderer.close();
  });

  test("C confirms Cancel without hiding the run and Ctrl-C cancels immediately", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    let cancellations = 0;
    const renderer = new RailTuiRenderer(
      input,
      output,
      "/unused",
      new Map(),
      undefined,
      () => {
        cancellations += 1;
      },
    );
    const screen = (): string => cleanScreen(output.writes.at(-1) ?? "");

    renderer.render(gateSnapshot("open", 0));
    input.emit("data", "c");
    assert.equal(cancellations, 0);
    assert.match(screen(), /CANCEL RUN\?/u);
    assert.match(screen(), /run-tui-test.*in-progress/u);
    assert.match(screen(), /3\. Review/u);
    input.emit("data", "\u001b");
    const deadline = Date.now() + 1_000;
    while (/CANCEL RUN\?/u.test(screen())) {
      if (Date.now() >= deadline) assert.fail("Cancel panel did not close");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.doesNotMatch(screen(), /CANCEL RUN\?/u);
    assert.match(screen(), /DECISION REQUIRED/u);

    renderer.render(snapshot("review", 1));
    input.emit("data", "C\r");
    assert.equal(cancellations, 1);
    assert.equal(input.isRaw, false);
    assert.equal(input.isPaused(), true);
    assert.equal(
      output.writes.filter((write) => write === "\u001b[?25h\u001b[?1049l").length,
      1,
    );

    const signalInput = new FakeInput();
    const signalOutput = new FakeOutput();
    const signalRenderer = new RailTuiRenderer(
      signalInput,
      signalOutput,
      "/unused",
      new Map(),
      undefined,
      () => {
        cancellations += 1;
      },
    );
    signalRenderer.render(snapshot("review", 1));
    signalInput.emit("data", "\u0003");
    assert.equal(cancellations, 2);
    assert.equal(signalInput.isRaw, false);
    assert.equal(signalInput.isPaused(), true);
  });

  test("inline decision gate preserves the pin and requires explicit confirmation", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const resolutions: [string, string][] = [];
    const renderer = new RailTuiRenderer(
      input,
      output,
      "/unused",
      new Map(),
      async (gateId, resolution) => {
        resolutions.push([gateId, resolution]);
      },
    );
    const screen = (): string => cleanScreen(output.writes.at(-1) ?? "");

    renderer.render(snapshot("review", 1));
    input.emit("data", "\r");
    renderer.render(gateSnapshot("open", 2));
    assert.match(screen(), /DECISION REQUIRED/u);
    assert.match(screen(), /pinned Review/u);
    assert.match(screen(), /approve.*audited approval/su);
    assert.match(screen(), /skip.*audited waiver/su);
    assert.match(screen(), /stop.*cancel this run/su);

    input.emit("data", "\r");
    assert.deepEqual(resolutions, []);
    assert.match(screen(), /Confirm approve\? Press Enter again/u);
    input.emit("data", "\u001b");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(resolutions, []);
    assert.doesNotMatch(screen(), /DECISION REQUIRED/u);
    assert.match(screen(), /pinned Review/u);

    input.emit("data", "g\u001b[B\r\r");
    assert.deepEqual(resolutions, []);
    assert.match(screen(), /Confirm fix\? Press Enter again/u);
    input.emit("data", "\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(resolutions, [["gate-review", "fix"]]);
    input.emit("data", "\u001bg\r");
    assert.equal(resolutions.length, 1);
    assert.match(screen(), /Waiting for canonical gate settlement/u);
    renderer.render(gateSnapshot("resolved", 3, "fix"));
    assert.doesNotMatch(screen(), /DECISION REQUIRED/u);
    assert.match(screen(), /pinned Review/u);
    renderer.close();
  });

  test("external resolution race closes the decision gate without duplicate submission", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const resolutions: [string, string][] = [];
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const renderer = new RailTuiRenderer(
      input,
      output,
      "/unused",
      new Map(),
      async (gateId, resolution) => {
        resolutions.push([gateId, resolution]);
        await pending;
      },
    );
    const screen = (): string => cleanScreen(output.writes.at(-1) ?? "");

    renderer.render(snapshot("review", 1));
    input.emit("data", "\r");
    renderer.render(gateSnapshot("open", 2));
    input.emit("data", "\r\r");
    assert.deepEqual(resolutions, []);
    input.emit("data", "\r");
    assert.deepEqual(resolutions, [["gate-review", "approve"]]);
    renderer.render(gateSnapshot("resolved", 3, "stop"));
    settle();
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolutions.length, 1);
    assert.doesNotMatch(screen(), /DECISION REQUIRED/u);
    assert.match(screen(), /pinned Review/u);
    renderer.close();
  });

  test(
    "PTY gates and Cancel preserve state and restore the terminal",
    { timeout: 10_000 },
    async () => {
      const artifactsDir = mkdtempSync(path.join(tmpdir(), "orca-tui-"));
      ensurePtyHelperExecutable();
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
        terminal.write("d");
        await waitFor(
          () =>
            screen().includes("DECISION REQUIRED") &&
            screen().includes("pinned Review"),
        );
        terminal.write("\r");
        await waitFor(() => screen().includes("Confirm approve? Press Enter again"));
        terminal.write("\u001b");
        await waitFor(
          () =>
            !screen().includes("DECISION REQUIRED") &&
            screen().includes("pinned Review"),
        );
        terminal.write("g\u001b[B\r\r");
        await waitFor(() => screen().includes("Confirm fix? Press Enter again"));
        terminal.write("\r");
        await waitFor(
          () =>
            output.includes("GATE ANSWER gate-review fix") &&
            !screen().includes("DECISION REQUIRED") &&
            screen().includes("pinned Review"),
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
        terminal.write("c");
        await waitFor(
          () =>
            screen().includes("CANCEL RUN?") &&
            screen().includes("run-tui-test") &&
            screen().includes("in-progress") &&
            screen().includes("3. Review"),
        );
        terminal.write("\u001b");
        await waitFor(
          () =>
            !screen().includes("CANCEL RUN?") &&
            screen().includes("Review LOG (PINNED)"),
        );
        terminal.write("C\r");
        assert.equal(await exited, 0);
        assert.match(output, /CANCEL REQUESTED restored=true/u);
        assert.ok(output.includes("\u001b[?25h\u001b[?1049l"));
      } finally {
        if (!hasExited) terminal.kill("SIGKILL");
        rmSync(artifactsDir, { force: true, recursive: true });
      }
    },
  );

  test.after(() => {
    console.log("TUI CANCELLATION CONTROLS PASSED");
    console.log("ONM-87 PTY AND SIGNAL TESTS PASSED");
  });
}
