import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { PIPELINE_STEPS, type StageName } from "./config.ts";
import { knownSecretPrefixBytes, redactKnownSecrets } from "./ledger.ts";
import type {
  PresentationRenderer,
  PresentationSnapshot,
  PresentationTransition,
} from "./presentation.ts";

type Input = {
  isPaused(): boolean;
  isRaw?: boolean;
  isTTY?: boolean;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  setRawMode?(mode: boolean): unknown;
};

type Output = {
  columns?: number;
  isTTY?: boolean;
  off(event: "error" | "resize", listener: () => void): unknown;
  on(event: "error" | "resize", listener: () => void): unknown;
  rows?: number;
  write(chunk: string): unknown;
};

type Region = "activity" | "logs" | "rail";

const REGIONS: readonly Region[] = ["rail", "activity", "logs"];
const MIN_COLUMNS = 72;
const MIN_ROWS = 18;
const FULL_COLUMNS = 100;
const FULL_ROWS = 24;
const LOG_BYTES = 64 * 1024;

function title(stage: StageName): string {
  return `${stage[0].toUpperCase()}${stage.slice(1)}`;
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const value = text.replaceAll("\t", "  ");
  if (value.length > width) {
    return width === 1 ? value.slice(0, 1) : `${value.slice(0, width - 1)}~`;
  }
  return value.padEnd(width);
}

function artifactDirectoryIdentity(artifactsDir: string): string | undefined {
  try {
    const directory = path.resolve(artifactsDir);
    const root = path.dirname(directory);
    return [root, directory]
      .flatMap((entry) => {
        const info = lstatSync(entry, { bigint: true });
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error();
        return [realpathSync(entry), info.dev, info.ino, info.birthtimeNs];
      })
      .join("\0");
  } catch {
    return undefined;
  }
}

function logTail(
  artifactsDir: string,
  artifactsIdentity: string | undefined,
  fileName: string,
): string[] {
  let descriptor: number | undefined;
  try {
    if (
      artifactsIdentity === undefined ||
      artifactDirectoryIdentity(artifactsDir) !== artifactsIdentity
    ) {
      throw new Error("artifact directory identity changed");
    }
    const root = path.resolve(artifactsDir);
    const filePath = path.resolve(root, fileName);
    const relative = path.relative(root, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("log path escapes artifact root");
    }
    descriptor = openSync(
      filePath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error("log path must be a private regular file");
    }
    const size = info.size;
    const length = Math.min(size, LOG_BYTES + knownSecretPrefixBytes());
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readSync(
        descriptor,
        buffer,
        bytesRead,
        length - bytesRead,
        size - length + bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    const content = Buffer.from(
      redactKnownSecrets(buffer.subarray(0, bytesRead).toString("utf8")),
    )
      .subarray(-LOG_BYTES)
      .toString("utf8")
      .replaceAll(new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "gu"), "");
    return Array.from(content, (character) => {
      if (character === "\t") return "  ";
      return character === "\n" || character === "\r" ||
          (character >= " " && character <= "~")
        ? character
        : "?";
    })
      .join("")
      .replaceAll("\r", "")
      .split("\n");
  } catch {
    return ["No log output yet."];
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function activity(transition: PresentationTransition): string {
  switch (transition.kind) {
    case "run-started":
      return "Run started";
    case "attempt-started":
      return `Attempt ${transition.attempt} started`;
    case "mode-changed":
      return `Auto-fix ${transition.enabled ? "on" : "off"}`;
    case "stage-started":
      return `${title(transition.stage)} started`;
    case "round-started":
      return `${title(transition.stage)} round ${transition.round}`;
    case "findings-recorded":
      return `${title(transition.stage)} findings ${transition.actionable}/${transition.total}`;
    case "gate-opened":
      return `${title(transition.stage)} gate opened`;
    case "gate-resolved":
      return `${title(transition.stage)} gate resolved`;
    case "stage-completed":
      return `${title(transition.stage)} completed`;
    case "error-recorded":
      return `Run error${transition.resumable ? " (resumable)" : ""}`;
    case "cancellation-recorded":
      return `Cancellation: ${transition.action}`;
    case "run-completed":
      return `Run ${transition.status}`;
  }
}

function transitionStage(
  transition: PresentationTransition,
): StageName | undefined {
  return "stage" in transition ? transition.stage : undefined;
}

export function supportsRailTui(
  input: Pick<Input, "isTTY" | "setRawMode">,
  output: Pick<Output, "columns" | "isTTY" | "rows" | "write">,
  term = process.env.TERM,
): boolean {
  return Boolean(
    input.isTTY &&
      input.setRawMode &&
      output.isTTY &&
      output.columns &&
      output.rows &&
      term?.toLowerCase() !== "dumb",
  );
}

export class RailTuiRenderer implements PresentationRenderer {
  readonly #activities: { label: string; stage?: StageName }[] = [];
  readonly #artifactsDir: string;
  readonly #artifactsIdentity: string | undefined;
  readonly #input: Input;
  readonly #inputWasPaused: boolean;
  readonly #inputWasRaw: boolean;
  readonly #output: Output;
  #activityIndex = 0;
  #closed = false;
  #escapeTimer?: ReturnType<typeof setTimeout>;
  #focus: Region = "rail";
  #inputBuffer = "";
  #logOffset = 0;
  #pinnedStage?: StageName;
  #refreshTimer?: ReturnType<typeof setInterval>;
  #selectedStage = 0;
  #snapshot?: PresentationSnapshot;

  readonly #onData = (chunk: Buffer | string): void => {
    try {
      this.#handleInput(chunk.toString());
    } catch {
      this.close();
    }
  };
  readonly #onError = (): void => this.close();
  readonly #onExit = (): void => this.close();
  readonly #onResize = (): void => {
    try {
      this.#draw();
    } catch {
      this.close();
    }
  };

  constructor(input: Input, output: Output, artifactsDir: string) {
    this.#input = input;
    this.#output = output;
    this.#artifactsDir = path.resolve(artifactsDir);
    this.#artifactsIdentity = artifactDirectoryIdentity(this.#artifactsDir);
    this.#inputWasPaused = input.isPaused();
    this.#inputWasRaw = input.isRaw === true;
    try {
      input.setRawMode!(true);
      input.resume();
      input.on("data", this.#onData);
      output.on("error", this.#onError);
      output.on("resize", this.#onResize);
      process.once("exit", this.#onExit);
      output.write("\u001b[?1049h\u001b[?25l");
      this.#refreshTimer = setInterval(this.#onResize, 250);
      this.#refreshTimer.unref();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#escapeTimer) clearTimeout(this.#escapeTimer);
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#inputBuffer = "";
    this.#input.off("data", this.#onData);
    this.#output.off("error", this.#onError);
    this.#output.off("resize", this.#onResize);
    process.off("exit", this.#onExit);
    try {
      this.#input.setRawMode?.(this.#inputWasRaw);
      if (this.#inputWasPaused) this.#input.pause();
      this.#output.write("\u001b[?25h\u001b[?1049l");
    } catch {}
  }

  render(snapshot: PresentationSnapshot): void {
    if (this.#closed) return;
    try {
      this.#snapshot = snapshot;
      this.#activities.push({
        label: activity(snapshot.transition),
        stage: transitionStage(snapshot.transition),
      });
      if (this.#activities.length > 50) this.#activities.shift();
      this.#activityIndex = this.#activities.length - 1;
      if (!this.#pinnedStage && snapshot.currentStage) {
        this.#selectedStage = PIPELINE_STEPS.indexOf(snapshot.currentStage);
      }
      this.#draw();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #draw(): void {
    if (this.#closed || !this.#snapshot) return;
    const columns = this.#output.columns ?? 0;
    const rows = this.#output.rows ?? 0;
    const screen =
      columns < MIN_COLUMNS || rows < MIN_ROWS
        ? this.#minimal(columns, rows)
        : columns >= FULL_COLUMNS && rows >= FULL_ROWS
          ? this.#full(columns, rows)
          : this.#compact(columns, rows);
    this.#output.write(`\u001b[H\u001b[2J${screen.join("\n")}`);
  }

  #minimal(columns: number, rows: number): string[] {
    const lines = Array.from({ length: Math.max(1, rows) }, () => "");
    const message = "Terminal too small";
    const hint = `Resize to at least ${MIN_COLUMNS}x${MIN_ROWS}`;
    const middle = Math.max(0, Math.floor(rows / 2) - 1);
    lines[middle] = message.padStart(Math.floor((columns + message.length) / 2));
    if (middle + 1 < lines.length) {
      lines[middle + 1] = hint.padStart(Math.floor((columns + hint.length) / 2));
    }
    return lines.map((line) => fit(line, columns));
  }

  #header(width: number): string {
    const snapshot = this.#snapshot!;
    const pin = this.#pinnedStage ? ` | pinned ${title(this.#pinnedStage)}` : "";
    return fit(
      `ORCA NO-MISTAKES | ${snapshot.runId} | attempt ${snapshot.attempt} | ${snapshot.status}${pin}`,
      width,
    );
  }

  #full(columns: number, rows: number): string[] {
    const railWidth = 25;
    const activityWidth = 31;
    const logWidth = columns - railWidth - activityWidth - 6;
    const bodyRows = rows - 3;
    const rail = this.#rail(bodyRows, railWidth);
    const recent = this.#recent(bodyRows, activityWidth);
    const logs = this.#logs(bodyRows, logWidth);
    return [
      this.#header(columns),
      fit("=".repeat(columns), columns),
      ...Array.from(
        { length: bodyRows },
        (_, index) => `${rail[index]} | ${recent[index]} | ${logs[index]}`,
      ),
      this.#footer(columns),
    ];
  }

  #compact(columns: number, rows: number): string[] {
    const railWidth = 24;
    const detailWidth = columns - railWidth - 3;
    const bodyRows = rows - 3;
    const rail = this.#rail(bodyRows, railWidth);
    const detail =
      this.#focus === "activity"
        ? this.#recent(bodyRows, detailWidth)
        : this.#logs(bodyRows, detailWidth);
    return [
      this.#header(columns),
      fit("=".repeat(columns), columns),
      ...Array.from(
        { length: bodyRows },
        (_, index) => `${rail[index]} | ${detail[index]}`,
      ),
      this.#footer(columns),
    ];
  }

  #rail(rows: number, width: number): string[] {
    const snapshot = this.#snapshot!;
    const lines = [this.#regionTitle("RAIL", "rail", width), ""];
    for (const [index, stage] of PIPELINE_STEPS.entries()) {
      const state = snapshot.stages[index];
      const active = snapshot.currentStage === stage && state.status === "active";
      const marker = active
        ? ">"
        : state.status === "passed"
          ? "x"
          : state.status === "failed" || state.status === "cancelled"
            ? "!"
            : state.status === "blocked"
              ? "-"
              : " ";
      const selected = index === this.#selectedStage ? ">" : " ";
      lines.push(`${selected} [${marker}] ${index + 1}. ${title(stage)}`);
    }
    return Array.from({ length: rows }, (_, index) => fit(lines[index] ?? "", width));
  }

  #recent(rows: number, width: number): string[] {
    const lines = [this.#regionTitle("RECENT ACTIVITY", "activity", width)];
    const room = Math.max(0, rows - 1);
    const start = Math.max(
      0,
      Math.min(this.#activityIndex, this.#activities.length - room),
    );
    for (
      let index = start;
      index < Math.min(this.#activities.length, start + room);
      index += 1
    ) {
      const selected = index === this.#activityIndex ? ">" : " ";
      lines.push(`${selected} ${this.#activities[index].label}`);
    }
    return Array.from({ length: rows }, (_, index) => fit(lines[index] ?? "", width));
  }

  #logs(rows: number, width: number): string[] {
    const snapshot = this.#snapshot!;
    const stage = this.#pinnedStage ?? PIPELINE_STEPS[this.#selectedStage];
    const round = snapshot.stages.find((item) => item.id === stage)?.round ?? 0;
    const all = logTail(
      this.#artifactsDir,
      this.#artifactsIdentity,
      `${stage}_r${round}.log`,
    );
    const room = Math.max(0, rows - 1);
    this.#logOffset = Math.min(
      this.#logOffset,
      Math.max(0, all.length - room),
    );
    const bottom = Math.max(0, all.length - this.#logOffset);
    const visible = all.slice(Math.max(0, bottom - room), bottom);
    const lines = [
      this.#regionTitle(
        `${title(stage)} LOG${this.#pinnedStage ? " (PINNED)" : ""}`,
        "logs",
        width,
      ),
      ...visible,
    ];
    return Array.from({ length: rows }, (_, index) => fit(lines[index] ?? "", width));
  }

  #regionTitle(label: string, region: Region, width: number): string {
    return fit(`${this.#focus === region ? ">" : " "} ${label}`, width);
  }

  #footer(width: number): string {
    const keys = ["Tab/Shift-Tab region"];
    if (this.#focus === "logs") keys.push("Up/Down scroll");
    else keys.push("Up/Down move", "Enter open");
    if (this.#pinnedStage || this.#focus === "logs") keys.push("Esc return");
    return fit(keys.join(" | "), width);
  }

  #handleInput(input: string): void {
    if (this.#escapeTimer) {
      clearTimeout(this.#escapeTimer);
      this.#escapeTimer = undefined;
    }
    this.#inputBuffer += input;
    const incomplete = this.#inputBuffer.endsWith("\u001b[")
      ? 2
      : this.#inputBuffer.endsWith("\u001b")
        ? 1
        : 0;
    const complete = incomplete
      ? this.#inputBuffer.slice(0, -incomplete)
      : this.#inputBuffer;
    this.#inputBuffer = incomplete ? this.#inputBuffer.slice(-incomplete) : "";
    const keys =
      complete.match(
        new RegExp("\\x03|\\x1b\\[Z|\\x1b\\[[ABCD]|\\r|\\n|\\t|\\x1b", "g"),
      ) ?? [];
    for (const key of keys) {
      if (key === "\u0003") {
        this.close();
        process.kill(process.pid, "SIGINT");
        return;
      } else if (key === "\t" || key === "\u001b[Z") {
        const direction = key === "\t" ? 1 : -1;
        const index = REGIONS.indexOf(this.#focus);
        this.#focus = REGIONS[(index + direction + REGIONS.length) % REGIONS.length];
      } else if (key === "\u001b") {
        this.#returnToRail();
      } else if (key === "\r" || key === "\n") {
        this.#open();
      } else if (key === "\u001b[A" || key === "\u001b[D") {
        this.#move(-1);
      } else if (key === "\u001b[B" || key === "\u001b[C") {
        this.#move(1);
      }
    }
    if (this.#inputBuffer) {
      this.#escapeTimer = setTimeout(() => {
        this.#escapeTimer = undefined;
        this.#inputBuffer = "";
        if (this.#closed) return;
        try {
          this.#returnToRail();
          this.#draw();
        } catch {
          this.close();
        }
      }, 100);
    }
    this.#draw();
  }

  #returnToRail(): void {
    this.#pinnedStage = undefined;
    this.#focus = "rail";
    const current = this.#snapshot?.currentStage;
    if (current) this.#selectedStage = PIPELINE_STEPS.indexOf(current);
  }

  #move(direction: -1 | 1): void {
    if (this.#focus === "rail") {
      this.#selectedStage = Math.max(
        0,
        Math.min(PIPELINE_STEPS.length - 1, this.#selectedStage + direction),
      );
    } else if (this.#focus === "activity") {
      this.#activityIndex = Math.max(
        0,
        Math.min(this.#activities.length - 1, this.#activityIndex + direction),
      );
    } else {
      this.#logOffset = Math.max(0, this.#logOffset - direction);
    }
  }

  #open(): void {
    if (this.#focus === "logs") return;
    if (this.#focus === "activity") {
      const stage = this.#activities[this.#activityIndex]?.stage;
      if (stage) this.#selectedStage = PIPELINE_STEPS.indexOf(stage);
    }
    this.#pinnedStage = PIPELINE_STEPS[this.#selectedStage];
    this.#logOffset = 0;
    this.#focus = "logs";
  }
}

export function createRailTuiRenderer(
  input: Input,
  output: Output,
  artifactsDir: string,
): RailTuiRenderer | undefined {
  if (!supportsRailTui(input, output)) return undefined;
  try {
    return new RailTuiRenderer(input, output, artifactsDir);
  } catch {
    return undefined;
  }
}
