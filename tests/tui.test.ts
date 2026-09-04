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
  autoFix = false,
): PresentationSnapshot {
  const base = snapshot("review", sequence);
  const options = ["approve", "fix", "skip", "stop"];
  return {
    ...base,
    mode: { autoFix },
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
  emitErrorOnNextWrite = false;
  failNextWrite = false;
  isTTY = true;
  rows = 24;
  readonly writes: string[] = [];

  write(chunk: string): boolean {
    if (this.emitErrorOnNextWrite) {
      this.emitErrorOnNextWrite = false;
      this.emit("error", new Error("emitted write failure"));
      return false;
    }
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

async function nextDraw(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
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
      "no-mistakes run-tui-test stage 3/8 review started\n",
    ]);
  });

  test("runtime renderer errors restore once and permanently fall back to plain status", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const failures: string[] = [];
    const renderer = createRunRenderer(
      input,
      output,
      "/unused",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (error) => failures.push(String(error)),
    );
    output.failNextWrite = true;
    renderer.render(snapshot("review", 1));
    await nextDraw();
    assert.equal(input.isRaw, false);
    assert.equal(input.isPaused(), true);
    assert.equal(output.writes[0], "\u001b[?1049h\u001b[?25l");
    assert.equal(
      output.writes.filter((write) => write === "\u001b[?25h\u001b[?1049l").length,
      1,
    );
    assert.deepEqual(failures, ["Error: write failed"]);
    assert.equal(
      output.writes.at(-1),
      "no-mistakes run-tui-test stage 3/8 review started\n",
    );

    output.emit("resize");
    renderer.render(snapshot("lint", 2));
    await nextDraw();
    assert.deepEqual(failures, ["Error: write failed"]);
    assert.equal(
      output.writes.at(-1),
      "no-mistakes run-tui-test stage 6/8 lint started\n",
    );
    renderer.close?.();
  });

  test("constructor output errors fall back before advertising Resume controls", () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const failures: string[] = [];
    let resumeAvailable = 0;
    output.emitErrorOnNextWrite = true;

    const renderer = createRunRenderer(
      input,
      output,
      "/unused",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        resumeAvailable += 1;
      },
      (error) => failures.push(String(error)),
    );
    renderer.render(snapshot("review", 1));

    assert.equal(input.isRaw, false);
    assert.equal(input.isPaused(), true);
    assert.equal(resumeAvailable, 0);
    assert.deepEqual(failures, ["Error: terminal output failed"]);
    assert.equal(
      output.writes.filter((write) => write === "\u001b[?25h\u001b[?1049l").length,
      1,
    );
    assert.equal(
      output.writes.at(-1),
      "no-mistakes run-tui-test stage 3/8 review started\n",
    );
    renderer.close?.();
  });

  test("constructor write failures warn once before plain fallback", () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    let resumeAvailable = 0;
    output.failNextWrite = true;

    const renderer = createRunRenderer(
      input,
      output,
      "/unused",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        resumeAvailable += 1;
      },
    );
    renderer.render(snapshot("review", 1));

    assert.equal(input.isRaw, false);
    assert.equal(input.isPaused(), true);
    assert.equal(resumeAvailable, 0);
    assert.equal(
      output.writes.filter(
        (write) =>
          write === "warning: interactive presentation failed; using plain status\n",
      ).length,
      1,
    );
    assert.equal(
      output.writes.at(-1),
      "no-mistakes run-tui-test stage 3/8 review started\n",
    );
    renderer.close?.();
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
    assert.equal(
      output.writes.filter(
        (write) =>
          write === "warning: interactive presentation failed; using plain status\n",
      ).length,
      1,
    );
    renderer.render(snapshot("review", 1));
    assert.equal(
      output.writes.at(-1),
      "no-mistakes run-tui-test stage 3/8 review started\n",
    );
  });

  test("semantic redraws wait one event-loop turn and unchanged refreshes do not repaint", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const renderer = new RailTuiRenderer(input, output, "/unused");
    renderer.render(snapshot("review", 1));
    assert.equal(output.writes.length, 1);
    await nextDraw();
    const writes = output.writes.length;
    input.emit("data", "\t");
    assert.equal(output.writes.length, writes);
    await nextDraw();
    assert.equal(output.writes.length, writes + 1);
    const navigatedWrites = output.writes.length;
    output.emit("resize");
    await nextDraw();
    assert.equal(output.writes.length, navigatedWrites);
    renderer.close();
  });

  test("ONM-88 shows finding dispositions and toggles Auto-fix without settling a gate", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 140;
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
    await nextDraw();

    const screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, /auto-fix off/iu);
    assert.match(screen, /Review\s+retained\s+4 found .*2 fixed .*1 approved/u);
    assert.match(screen, /Lint/u);
    assert.match(screen, /A Auto-fix/iu);
    input.emit("data", "A");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(toggles, [true]);
    assert.deepEqual(resolutions, []);

    input.emit("data", "\u001b");
    await new Promise((resolve) => setTimeout(resolve, 120));
    input.emit("data", "\u001b[B\u001b[B");
    await nextDraw();
    const summaryScreen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(summaryScreen, /1 open/u);
    assert.match(summaryScreen, /1 approved/u);
    renderer.close();
  });

  test("auto-responder auto-resolves gates with fix for actionable findings and approve on re-review", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.rows = 20;
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
      undefined,
      undefined,
      undefined,
      true,
    );

    const base = gateSnapshot("open", 2, undefined, true);
    renderer.render({
      ...base,
      stages: base.stages.map((stage) =>
        stage.id === "review"
          ? {
              ...stage,
              actionableFindings: 1,
              openFindings: 1,
              totalFindings: 1,
            }
          : stage,
      ),
    });
    await nextDraw();
    assert.deepEqual(resolutions, ["fix"]);

    renderer.render(gateSnapshot("resolved", 3, "fix", true));
    await nextDraw();

    const round2 = gateSnapshot("open", 4, undefined, true);
    renderer.render({
      ...round2,
      gate: {
        ...round2.gate!,
        id: "gate-review-2",
      },
      stages: base.stages.map((stage) =>
        stage.id === "review"
          ? {
              ...stage,
              fixedFindings: 1,
              openFindings: 0,
              round: 2,
              totalFindings: 1,
            }
          : stage,
      ),
    });
    await nextDraw();
    assert.deepEqual(resolutions, ["fix", "approve"]);
    renderer.close();
  });

  test("mode-changed transition synchronizes autoFix mode", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 100;
    output.rows = 24;
    const renderer = new RailTuiRenderer(input, output, "/unused");

    const base = snapshot("review", 1);
    const resumed = {
      ...base,
      mode: { autoFix: true },
      transition: { kind: "mode-changed" as const, enabled: true },
    };
    renderer.render(resumed);
    await nextDraw();
    const screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, /auto-fix on/iu);
    renderer.close();
  });

  test("initial mode-changed transition does not enable autoFix", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 100;
    output.rows = 24;
    const renderer = new RailTuiRenderer(input, output, "/unused");

    const base = snapshot("review", 1);
    const initial = {
      ...base,
      mode: { autoFix: true },
      transition: { enabled: true, kind: "mode-changed" as const, source: "initial" as const },
    };
    renderer.render(initial);
    await nextDraw();
    const screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, /auto-fix off/iu);
    renderer.close();
  });

  test("narrow findings stack description below ID at narrow pane width", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 40;
    output.rows = 24;
    const renderer = new RailTuiRenderer(input, output, "/unused");

    const base = snapshot("review", 1);
    renderer.render({
      ...base,
      stages: base.stages.map((stage) =>
        stage.id === "review"
          ? {
              ...stage,
              findings: [
                {
                  description: "Full description readable without truncation",
                  disposition: "open" as const,
                  file: "scripts/tui.ts",
                  id: "narrow-findings-truncate",
                  line: 1179,
                  severity: "error" as const,
                },
              ],
              totalFindings: 1,
            }
          : stage,
      ),
      transition: { kind: "findings-recorded" as const, actionable: 1, round: 1, stage: "review" as const, total: 1 },
    });
    await nextDraw();
    const screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, /Full description/u);
    assert.match(screen, /scripts\/tui\.ts:1179/u);
    renderer.close();
  });

  test("narrow screen stacks stages, activity, and detail vertically", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 72;
    output.rows = 24;
    const renderer = new RailTuiRenderer(input, output, "/unused");

    const base = snapshot("review", 1);
    renderer.render({
      ...base,
      transition: { kind: "round-started", round: 0, stage: "review" },
    });
    await nextDraw();

    const screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, /STAGES/u);
    assert.match(screen, /ACTIVITY/u);
    assert.match(screen, /REVIEW/u);
    renderer.close();
  });

  test("narrow footer uses ASCII ^v under ASCII locale without Unicode arrows", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 50;
    output.rows = 24;
    const oldLang = process.env.LANG;
    const oldLcAll = process.env.LC_ALL;
    const oldLcCtype = process.env.LC_CTYPE;
    process.env.LANG = "C";
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    try {
      const renderer = new RailTuiRenderer(input, output, "/unused");
      const base = snapshot("review", 1);
      renderer.render(base);
      await nextDraw();
      const screen = cleanScreen(output.writes.at(-1) ?? "");
      assert.match(screen, /\^v move/u);
      assert.ok(!screen.includes("\u2191\u2193"));
      renderer.close();
    } finally {
      if (oldLang !== undefined) process.env.LANG = oldLang;
      else delete process.env.LANG;
      if (oldLcAll !== undefined) process.env.LC_ALL = oldLcAll;
      else delete process.env.LC_ALL;
      if (oldLcCtype !== undefined) process.env.LC_CTYPE = oldLcCtype;
      else delete process.env.LC_CTYPE;
    }
  });

  test("detail scroll resets when stage changes", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 100;
    output.rows = 20;
    const renderer = new RailTuiRenderer(input, output, "/unused");

    const base = snapshot("review", 1);
    renderer.render(base);
    await nextDraw();

    input.emit("data", "\t\t\u001b[B\u001b[B\u001b[B");
    await nextDraw();

    input.emit("data", "\t\u001b[B");
    await nextDraw();

    const screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, /> · Test/u);
    assert.match(screen, /TEST/u);
    assert.match(screen, /Not started\./u);
    renderer.close();
  });

  test("de-noised activity log consolidates rounds, findings, and fix progress", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 140;
    output.rows = 24;
    const renderer = new RailTuiRenderer(input, output, "/unused");

    const base = snapshot("intent", 1);
    renderer.render({ ...base, transition: { attempt: 1, kind: "attempt-started" } });
    renderer.render({ ...base, transition: { kind: "stage-started", stage: "intent" } });
    renderer.render({ ...base, transition: { kind: "stage-started", stage: "rebase" } });
    renderer.render({ ...base, transition: { kind: "round-started", round: 0, stage: "review" } });
    renderer.render({ ...base, transition: { actionable: 5, kind: "findings-recorded", round: 0, stage: "review", total: 6 } });
    renderer.render({ ...base, transition: { decision: "fix", gateId: "g1", kind: "gate-resolved", round: 0, stage: "review" } });
    const withFixed = {
      ...base,
      stages: base.stages.map((s) =>
        s.id === "review"
          ? { ...s, approvedFindings: 1, fixedFindings: 5, totalFindings: 6 }
          : s,
      ),
    };
    renderer.render({
      ...withFixed,
      transition: {
        approvedFindings: 1,
        findingIds: ["a", "b", "c", "d", "e"],
        kind: "fix-completed",
        round: 1,
        stage: "review",
      },
    });
    renderer.render({
      ...withFixed,
      transition: { kind: "round-started", round: 1, stage: "review" },
    });
    renderer.render({ ...withFixed, transition: { actionable: 3, kind: "findings-recorded", round: 1, stage: "review", total: 3 } });
    renderer.render({ ...withFixed, transition: { kind: "round-started", round: 0, stage: "test" } });

    await nextDraw();
    const screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, /Run 1 started/u);
    assert.match(screen, /Intent started/u);
    assert.match(screen, /Rebase started/u);
    assert.match(screen, /Review analysis 1 ·  5 found/u);
    assert.match(screen, /Review fix 1\s+·  5 applied ·  1 approved/u);
    assert.match(screen, /Review analysis 2 ·  3 found/u);
    assert.match(screen, /Test analysis 1/u);
    const activityLines = screen.split("\n").filter((line) => /Review (?:analysis|fix)/u.test(line));
    assert.ok(activityLines.length >= 3);
    assert.equal(activityLines[0].indexOf("·"), activityLines[1].indexOf("·"));
    assert.equal(activityLines[1].indexOf("·"), activityLines[2].indexOf("·"));
    renderer.close();
  });

  test("fixer execution displays fix 1 instead of analysis 2 in activity, detail header, and log header", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 100;
    output.rows = 24;
    const renderer = new RailTuiRenderer(input, output, "/unused");

    const base = snapshot("review", 1);
    renderer.render({ ...base, transition: { kind: "round-started", role: "reviewer", round: 0, stage: "review" } });
    renderer.render({ ...base, transition: { actionable: 2, kind: "findings-recorded", round: 0, stage: "review", total: 2 } });
    renderer.render({ ...base, transition: { decision: "fix", gateId: "g1", kind: "gate-resolved", round: 0, stage: "review" } });

    // Fixer starts (round-started with role: "fixer", round: 1)
    const fixingSnapshot = {
      ...base,
      stages: base.stages.map((s) => (s.id === "review" ? { ...s, phase: "fixer" as const, round: 1, status: "active" as const } : s)),
    };
    renderer.render({
      ...fixingSnapshot,
      transition: { kind: "round-started", role: "fixer", round: 1, stage: "review" },
    });

    await nextDraw();
    const screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.match(screen, /Review fix 1/u);
    assert.doesNotMatch(screen, /Review analysis 2/u);
    assert.match(screen, /REVIEW.*fix 1/u);
    renderer.close();
  });

  test("finding names wrap on hyphens without truncation", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 120;
    output.rows = 24;
    const renderer = new RailTuiRenderer(input, output, "/unused");

    const base = snapshot("review", 1);
    const withLongFinding = {
      ...base,
      stages: base.stages.map((s) =>
        s.id === "review"
          ? {
              ...s,
              findings: [
                {
                  description: "Long finding explanation that wraps cleanly across multiple lines.",
                  disposition: "open" as const,
                  file: "scripts/tui.ts",
                  id: "unexplained-policy-relaxation",
                  line: 437,
                  severity: "error" as const,
                },
              ],
              openFindings: 1,
              totalFindings: 1,
            }
          : s,
      ),
    };

    renderer.render(withLongFinding);
    await nextDraw();
    const screen = cleanScreen(output.writes.at(-1) ?? "");
    assert.doesNotMatch(screen, /~/u);
    assert.match(screen, /unexplained-policy-/u);
    assert.match(screen, /relaxation/u);
    renderer.close();
  });

  test("untrusted terminal text is redacted, ASCII-safe, bounded, and textually labeled", async () => {
    const previousSecret = process.env.ONM_TEST_SECRET;
    const previousPassword = process.env.ONM_TEST_PASSWORD;
    const previousNoColor = process.env.NO_COLOR;
    process.env.ONM_TEST_SECRET = "secret-value";
    process.env.ONM_TEST_PASSWORD = "open sesame";
    process.env.NO_COLOR = "1";
    const input = new FakeInput();
    const output = new FakeOutput();
    const renderer = new RailTuiRenderer(input, output, "/unused");
    const base = snapshot("review", 1);
    const hostile = "sec\u001b[31mret-value\u001b[0m-open\nsesame\nwide-\u4e2d-combining-e\u0301-";
    try {
      renderer.render({
        ...base,
        runId: `${"x".repeat(72)}open\nsesame-${hostile}`,
        stages: base.stages.map((stage) =>
          stage.id === "review"
            ? {
                ...stage,
                findings: [
                  {
                    description: `${hostile}open  sesame-${"y".repeat(500)}`,
                    disposition: "open" as const,
                    file: `${hostile}.ts`,
                    id: "secret-value",
                    severity: "warning" as const,
                  },
                ],
                openFindings: 1,
                retainedFixer: true,
                totalFindings: 1,
              }
            : stage,
        ),
        transition: {
          actionable: 1,
          kind: "findings-recorded",
          retainedFixer: true,
          round: 1,
          stage: "review",
          total: 1,
        },
      });
      await nextDraw();

      const frame = (output.writes.at(-1) ?? "").replace(
        "\u001b[H\u001b[2J",
        "",
      );
      assert.equal(frame.includes("\u001b"), false);
      assert.equal(frame.includes("secret-value"), false);
      assert.equal(frame.includes("open sesame"), false);
      assert.equal(frame.includes("open s"), false);
      assert.equal(frame.includes("\u4e2d"), false);
      assert.equal(frame.includes("\u0301"), false);
      assert.match(frame, /\[REDACTED\]/u);
      assert.match(frame, /> (?:\u25cf|\[>\]) Review/u);
      assert.equal(frame.split("\n").length, output.rows);
      assert.ok(
        frame
          .split("\n")
          .every(
            (line) => line.length <= output.columns && /^[\x20-\x7e\u00b7\u2191\u2193\u2502\u2713\u2717\u25cb\u25cf]*$/u.test(line),
          ),
      );
      assert.doesNotMatch(frame, new RegExp("x{100}|y{100}", "u"));
    } finally {
      renderer.close();
      if (previousSecret === undefined) delete process.env.ONM_TEST_SECRET;
      else process.env.ONM_TEST_SECRET = previousSecret;
      if (previousPassword === undefined) delete process.env.ONM_TEST_PASSWORD;
      else process.env.ONM_TEST_PASSWORD = previousPassword;
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
    }
  });

  test("empty NO_COLOR presence disables color styling", async () => {
    const previousNoColor = process.env.NO_COLOR;
    const previousTerm = process.env.TERM;
    process.env.NO_COLOR = "";
    process.env.TERM = "xterm-256color";
    const input = new FakeInput();
    const output = new FakeOutput();
    const renderer = new RailTuiRenderer(input, output, "/unused");
    const base = snapshot("review", 1);
    try {
      renderer.render(base);
      await nextDraw();
      const frame = output.writes.at(-1) ?? "";
      assert.equal(frame.includes("\u001b[3"), false);
      assert.equal(frame.includes("\u001b[0m"), false);
    } finally {
      renderer.close();
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
      if (previousTerm === undefined) delete process.env.TERM;
      else process.env.TERM = previousTerm;
    }
  });

  test("Resume is shown only for resumable errors and returns to the pipeline", async () => {
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
    await nextDraw();
    input.emit("data", "\r");
    await nextDraw();
    assert.match(cleanScreen(output.writes.at(-1) ?? ""), /pinned Review/u);
    input.emit("data", "C");
    await nextDraw();
    assert.match(cleanScreen(output.writes.at(-1) ?? ""), /CANCEL RUN\?/u);
    const resumable = snapshot("test", 2);
    renderer.render({
      ...resumable,
      currentStage: "test",
      error: { resumable: true },
      status: "failed",
      transition: { kind: "error-recorded", resumable: true },
    });
    await nextDraw();
    const screen = (): string => cleanScreen(output.writes.at(-1) ?? "");
    assert.equal(available, 1);
    assert.match(screen(), /RUN ERROR \(RESUMABLE\)/u);
    assert.doesNotMatch(screen(), /CANCEL RUN\?/u);
    assert.match(screen(), /R resume/u);
    input.emit("data", "R");
    await nextDraw();
    assert.equal(requested, 1);
    assert.match(screen(), /Resume requested\. Waiting for the next attempt\./u);
    assert.doesNotMatch(screen(), /R resume/u);

    renderer.render({
      ...resumable,
      currentStage: "test",
      error: { resumable: true },
      status: "failed",
      transition: { kind: "run-completed", status: "failed" },
    });
    await nextDraw();
    assert.match(screen(), /Resume requested\. Waiting for the next attempt\./u);
    assert.doesNotMatch(screen(), /R resume/u);
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
    await nextDraw();
    assert.match(screen(), /ACTIVITY/u);
    assert.match(screen(), /TEST\s+active/u);
    assert.doesNotMatch(screen(), /pinned Review/u);
    assert.match(screen(), /> STAGES/u);
    assert.match(screen(), /> (?:\u25cf|\[>\]) Test/u);
    input.emit("data", "R");
    assert.equal(requested, 1);

    renderer.render({
      ...resumable,
      currentStage: "test",
      error: { resumable: false },
      status: "failed",
      transition: { kind: "error-recorded", resumable: false },
    });
    await nextDraw();
    assert.doesNotMatch(screen(), /R resume/u);
    input.emit("data", "R");
    assert.equal(requested, 1);
    input.emit("data", "C");
    assert.equal(cancellations, 1);
    assert.doesNotMatch(screen(), /CANCEL RUN\?/u);
    renderer.close();
  });

  test("terminal control replies do not trigger keyboard actions", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    let cancellations = 0;
    let resumes = 0;
    const toggles: boolean[] = [];
    const renderer = new RailTuiRenderer(
      input,
      output,
      "/unused",
      new Map(),
      undefined,
      () => {
        cancellations += 1;
      },
      (enabled) => {
        toggles.push(enabled);
      },
      () => {
        resumes += 1;
      },
    );
    const base = snapshot("review", 1);

    renderer.render({
      ...base,
      error: { resumable: true },
      status: "failed",
      transition: { kind: "error-recorded", resumable: true },
    });
    input.emit("data", "\u001b[?1;2c");
    input.emit("data", "\u001b[?1;");
    input.emit("data", "2c");
    input.emit("data", "\u001b]11;rgb:cafe/0000/0000\u0007");
    input.emit("data", "\u001bP1+r636f=726762\u001b\\");
    input.emit("data", "\u001b_cag\u001b");
    input.emit("data", "\\");
    input.emit("data", "\u001b^r\u001b\\");
    input.emit("data", "\u001bO");
    input.emit("data", "D");
    await nextDraw();

    assert.equal(cancellations, 0);
    assert.equal(resumes, 0);
    assert.deepEqual(toggles, []);
    assert.doesNotMatch(cleanScreen(output.writes.at(-1) ?? ""), /CANCEL RUN\?/u);
    assert.match(cleanScreen(output.writes.at(-1) ?? ""), /> (?:\u00b7|\[ \]) Rebase/u);
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
    await nextDraw();
    assert.equal(cancellations, 0);
    assert.match(screen(), /CANCEL RUN\?/u);
    assert.match(screen(), /run-tui-test.*attempt 1/u);
    assert.match(screen(), /Review/u);
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
    await nextDraw();
    input.emit("data", "\r");
    await nextDraw();
    renderer.render(gateSnapshot("open", 2));
    await nextDraw();
    assert.match(screen(), /DECISION REQUIRED/u);
    assert.match(screen(), /pinned Review/u);
    assert.match(screen(), /approve.*audited approval/su);
    assert.match(screen(), /skip.*audited waiver/su);
    assert.match(screen(), /stop.*cancel this run/su);

    input.emit("data", "\r");
    await nextDraw();
    assert.deepEqual(resolutions, []);
    assert.match(screen(), /Confirm approve\? Press Enter again/u);
    input.emit("data", "\u001b");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(resolutions, []);
    assert.doesNotMatch(screen(), /DECISION REQUIRED/u);
    assert.match(screen(), /pinned Review/u);

    input.emit("data", "g\u001b[B\r\r");
    await nextDraw();
    assert.deepEqual(resolutions, []);
    assert.match(screen(), /Confirm fix\? Press Enter again/u);
    input.emit("data", "\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(resolutions, [["gate-review", "fix"]]);
    input.emit("data", "\u001bg\r");
    assert.equal(resolutions.length, 1);
    assert.match(screen(), /Waiting for gate settlement/u);
    renderer.render(gateSnapshot("resolved", 3, "fix"));
    await nextDraw();
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
    await nextDraw();
    input.emit("data", "\r");
    await nextDraw();
    renderer.render(gateSnapshot("open", 2));
    await nextDraw();
    input.emit("data", "\r\r");
    assert.deepEqual(resolutions, []);
    input.emit("data", "\r");
    assert.deepEqual(resolutions, [["gate-review", "approve"]]);
    renderer.render(gateSnapshot("resolved", 3, "stop"));
    await nextDraw();
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
          rows: 30,
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
        await waitFor(
          () =>
            screen().includes("ACTIVITY") &&
            screen().includes("Lint"),
        );
        const initial = screen().slice(screen().indexOf("STAGES"));
        const labels = [
          "Intent",
          "Rebase",
          "Review",
          "Test",
          "Document",
          "Lint",
        ];
        assert.ok(
          labels.every(
            (label, index) =>
              index === 0 ||
              initial.indexOf(labels[index - 1]) < initial.indexOf(label),
          ),
        );
        assert.equal(initial.match(/(?:\u25cf|\[>\]) (?:Intent|Rebase|Review|Test|Document|Lint)/gu)?.length, 1);

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
            /(?:\u25cf|\[>\]) Lint/u.test(screen()) &&
            screen().includes("pinned Review"),
        );
        assert.match(screen(), /(?:\u25cf|\[>\]) Lint/u);
        assert.equal(screen().match(/(?:\u25cf|\[>\]) (?:Intent|Rebase|Review|Test|Document|Lint)/gu)?.length, 1);

        terminal.resize(30, 10);
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
            /> (?:\u25cf|\[>\]) Lint/u.test(screen()),
        );
        terminal.write("\u001b[Z");
        await waitFor(() => screen().includes("scroll"));
        assert.ok(!screen().includes("Enter open"));
        terminal.write("\t\t");
        await waitFor(() => screen().includes("Enter open"));
        terminal.write("\u001b[A\r");
        await waitFor(() => screen().includes("pinned Review"));

        terminal.resize(72, 18);
        await waitFor(
          () =>
            screen().includes("STAGES") && screen().includes("ACTIVITY"),
        );
        terminal.write("c");
        await waitFor(
          () =>
            screen().includes("CANCEL RUN?") &&
            screen().includes("run-tui-test") &&
            screen().includes("Review"),
        );
        terminal.write("\u001b");
        await waitFor(
          () =>
            !screen().includes("CANCEL RUN?") &&
            screen().includes("REVIEW LOG"),
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
