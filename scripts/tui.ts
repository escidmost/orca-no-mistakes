import path from "node:path";

import { PIPELINE_STEPS, type StageName } from "./config.ts";
import {
  knownSecretPrefixBytes,
  redactKnownSecrets,
  STAGE_LOG_TAIL_BYTES,
  type StageLog,
} from "./ledger.ts";
import {
  PlainStatusRenderer,
  type GateResolver,
  type PresentationRenderer,
  type PresentationSnapshot,
  type PresentationTransition,
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

type GateReturnState = {
  activityIndex: number;
  focus: Region;
  logOffset: number;
  pinnedStage?: StageName;
  selectedStage: number;
};

const REGIONS: readonly Region[] = ["rail", "activity", "logs"];
const MIN_COLUMNS = 72;
const MIN_ROWS = 18;
const FULL_COLUMNS = 100;
const FULL_ROWS = 24;

function title(stage: StageName): string {
  return `${stage[0].toUpperCase()}${stage.slice(1)}`;
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const value = text
    .replaceAll("\t", "  ")
    .replaceAll(new RegExp("[\\x00-\\x1f\\x7f-\\x9f]", "gu"), "?");
  if (value.length > width) {
    return width === 1 ? value.slice(0, 1) : `${value.slice(0, width - 1)}~`;
  }
  return value.padEnd(width);
}

function logTail(
  artifactsDir: string,
  fileName: string,
  stageLogs: ReadonlyMap<string, StageLog>,
): string[] {
  try {
    const root = path.resolve(artifactsDir);
    const filePath = path.resolve(root, fileName);
    const relative = path.relative(root, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("log path escapes artifact root");
    }
    const log = stageLogs.get(filePath);
    if (!log) throw new Error("log is not coordinator-owned");
    const buffer = log.tail(STAGE_LOG_TAIL_BYTES + knownSecretPrefixBytes());
    const redacted = redactKnownSecrets(
      buffer
        .toString("utf8")
        .replaceAll(new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "gu"), ""),
    );
    const sanitized = Array.from(
      redacted,
      (character) => {
        if (character === "\t") return "  ";
        return character === "\n" ||
            (character >= " " && character <= "~")
          ? character
          : "?";
      },
    ).join("");
    const content = Buffer.from(sanitized)
      .subarray(-STAGE_LOG_TAIL_BYTES)
      .toString("utf8");
    return content.split("\n");
  } catch {
    return ["No log output yet."];
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

function gateConsequence(option: string, stage?: StageName): string {
  switch (option) {
    case "approve":
      return "Continue with an audited approval.";
    case "fix":
      return stage === "rebase"
        ? "Retry the rebase after conflicts are resolved."
        : "Fix all findings, then recheck this stage.";
    case "skip":
      return "Continue with an audited waiver.";
    case "stop":
      return "Stop and cancel this run.";
    default:
      return "Resolve the canonical gate with this choice.";
  }
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let rest = text.replace(/\s+/gu, " ").trim();
  while (rest.length > width) {
    const space = rest.lastIndexOf(" ", width);
    const end = space > 0 ? space : width;
    lines.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  if (rest) lines.push(rest);
  return lines;
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
  readonly #input: Input;
  readonly #inputWasPaused: boolean;
  readonly #inputWasRaw: boolean;
  readonly #output: Output;
  readonly #resolveGate?: GateResolver;
  readonly #stageLogs: ReadonlyMap<string, StageLog>;
  #activityIndex = 0;
  #closed = false;
  #escapeTimer?: ReturnType<typeof setTimeout>;
  #focus: Region = "rail";
  #gateChoice = 0;
  #gateConfirm = false;
  #gateMessage?: string;
  #gateReturn?: GateReturnState;
  #gateSubmitting = false;
  #gateVisible = false;
  #inputBuffer = "";
  #lastFrame?: string;
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

  constructor(
    input: Input,
    output: Output,
    artifactsDir: string,
    stageLogs: ReadonlyMap<string, StageLog> = new Map(),
    resolveGate?: GateResolver,
  ) {
    this.#input = input;
    this.#output = output;
    this.#artifactsDir = path.resolve(artifactsDir);
    this.#stageLogs = stageLogs;
    this.#resolveGate = resolveGate;
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
    } catch {}
    try {
      if (this.#inputWasPaused) this.#input.pause();
    } catch {}
    try {
      this.#output.write("\u001b[?25h\u001b[?1049l");
    } catch {}
  }

  render(snapshot: PresentationSnapshot): void {
    if (this.#closed) return;
    try {
      const opensGate =
        snapshot.transition.kind === "gate-opened" &&
        snapshot.gate?.state === "open";
      const settlesGate =
        this.#gateVisible &&
        (snapshot.gate?.state !== "open" ||
          snapshot.gate.id !== this.#snapshot?.gate?.id);
      this.#snapshot = snapshot;
      if (opensGate) this.#showGate();
      this.#activities.push({
        label: activity(snapshot.transition),
        stage: transitionStage(snapshot.transition),
      });
      if (this.#activities.length > 50) this.#activities.shift();
      this.#activityIndex = this.#activities.length - 1;
      if (settlesGate) this.#leaveGate();
      if (!opensGate && !settlesGate && !this.#pinnedStage && snapshot.currentStage) {
        this.#selectedStage = PIPELINE_STEPS.indexOf(snapshot.currentStage);
      }
      this.#draw();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #showGate(): void {
    const gate = this.#snapshot?.gate;
    if (gate?.state !== "open" || !gate.options?.length || this.#gateVisible) return;
    this.#gateReturn = {
      activityIndex: this.#activityIndex,
      focus: this.#focus,
      logOffset: this.#logOffset,
      pinnedStage: this.#pinnedStage,
      selectedStage: this.#selectedStage,
    };
    this.#gateChoice = 0;
    this.#gateConfirm = false;
    this.#gateMessage = undefined;
    this.#gateSubmitting = false;
    this.#gateVisible = true;
  }

  #leaveGate(): void {
    if (this.#gateReturn) {
      this.#activityIndex = this.#gateReturn.activityIndex;
      this.#focus = this.#gateReturn.focus;
      this.#logOffset = this.#gateReturn.logOffset;
      this.#pinnedStage = this.#gateReturn.pinnedStage;
      this.#selectedStage = this.#gateReturn.selectedStage;
    }
    this.#gateReturn = undefined;
    this.#gateVisible = false;
    this.#gateConfirm = false;
    this.#gateMessage = undefined;
    this.#gateSubmitting = false;
  }

  #submitGate(): void {
    const gate = this.#snapshot?.gate;
    const resolution = gate?.options?.[this.#gateChoice];
    if (!gate || gate.state !== "open" || !resolution) return;
    if (!this.#resolveGate) {
      this.#gateConfirm = false;
      this.#gateMessage = "Inline resolution is unavailable.";
      return;
    }
    this.#gateConfirm = false;
    this.#gateSubmitting = true;
    this.#gateMessage = "Submitting canonical gate decision...";
    this.#draw();
    void this.#resolveGate(gate.id, resolution).then(
      () => {
        if (this.#gateVisible && this.#snapshot?.gate?.id === gate.id) {
          this.#gateMessage = "Decision sent; waiting for settlement.";
          this.#draw();
        }
      },
      (error) => {
        if (this.#gateVisible && this.#snapshot?.gate?.id === gate.id) {
          this.#gateSubmitting = false;
          this.#gateConfirm = false;
          this.#gateMessage = `Could not resolve gate: ${String(error)}`;
          this.#draw();
        }
      },
    );
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
    const frame = screen.join("\n");
    if (frame === this.#lastFrame) return;
    this.#output.write(`\u001b[H\u001b[2J${frame}`);
    this.#lastFrame = frame;
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
    const bodyRows = rows - 3;
    const rail = this.#rail(bodyRows, railWidth);
    if (this.#gateVisible) {
      const gate = this.#gatePanel(bodyRows, columns - railWidth - 3);
      return [
        this.#header(columns),
        fit("=".repeat(columns), columns),
        ...Array.from(
          { length: bodyRows },
          (_, index) => `${rail[index]} | ${gate[index]}`,
        ),
        this.#footer(columns),
      ];
    }
    const activityWidth = 31;
    const logWidth = columns - railWidth - activityWidth - 6;
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
    const detail = this.#gateVisible
      ? this.#gatePanel(bodyRows, detailWidth)
      : this.#focus === "activity"
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
      const status =
        snapshot.stages.find((item) => item.id === stage)?.status ?? "pending";
      const active = snapshot.currentStage === stage && status === "active";
      const marker = active
        ? ">"
        : status === "passed"
          ? "x"
          : status === "failed" || status === "cancelled"
            ? "!"
            : status === "blocked"
              ? "-"
              : " ";
      const selected = index === this.#selectedStage ? ">" : " ";
      lines.push(`${selected} [${marker}] ${index + 1}. ${title(stage)}`);
    }
    return Array.from({ length: rows }, (_, index) => fit(lines[index] ?? "", width));
  }

  #gatePanel(rows: number, width: number): string[] {
    const gate = this.#snapshot?.gate;
    if (!gate) return Array.from({ length: rows }, () => fit("", width));
    const options = gate.options ?? [];
    const choice = options[this.#gateChoice];
    const question = wrap(gate.question ?? "Human decision required.", width).slice(
      0,
      2,
    );
    const lines = [
      fit("> DECISION REQUIRED", width),
      fit(
        `${title(gate.stage ?? this.#snapshot!.currentStage ?? "intent")} round ${gate.round ?? 0} | ${gate.id}`,
        width,
      ),
      ...question.map((line) => fit(line, width)),
      fit("Canonical choices:", width),
    ];
    for (const [index, option] of options.entries()) {
      lines.push(fit(`${index === this.#gateChoice ? ">" : " "} ${option}`, width));
      lines.push(fit(`  ${gateConsequence(option, gate.stage)}`, width));
    }
    lines.push(
      fit(
        this.#gateConfirm
          ? `Confirm ${choice}? Press Enter again.`
          : this.#gateMessage ?? "Enter selects. Esc returns unanswered.",
        width,
      ),
    );
    if (this.#gateConfirm || this.#gateSubmitting) {
      lines.push(
        fit(
          this.#gateMessage ?? "Esc returns without resolving the gate.",
          width,
        ),
      );
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
      `${stage}_r${round}.log`,
      this.#stageLogs,
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
    if (this.#gateVisible) {
      return fit(
        this.#gateSubmitting
          ? "Waiting for canonical gate settlement"
          : "Up/Down choice | Enter select/confirm | Esc return unanswered",
        width,
      );
    }
    const keys = ["Tab/Shift-Tab region"];
    if (this.#focus === "logs") keys.push("Up/Down scroll");
    else keys.push("Up/Down move", "Enter open");
    if (this.#pinnedStage || this.#focus === "logs") keys.push("Esc return");
    if (this.#snapshot?.gate?.state === "open") keys.push("G open gate");
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
        new RegExp(
          "\\x03|\\x1b\\[Z|\\x1b\\[[ABCD]|\\r|\\n|\\t|\\x1b|[gG]",
          "g",
        ),
      ) ?? [];
    for (const key of keys) {
      if (key === "\u0003") {
        this.close();
        process.kill(process.pid, "SIGINT");
        return;
      } else if (this.#gateVisible) {
        if (key === "\u001b" && !this.#gateSubmitting) {
          this.#leaveGate();
        } else if (!this.#gateSubmitting && (key === "\r" || key === "\n")) {
          if (this.#gateConfirm) this.#submitGate();
          else {
            this.#gateConfirm = true;
            break;
          }
        } else if (
          !this.#gateSubmitting &&
          (key === "\u001b[A" ||
            key === "\u001b[D" ||
            key === "\u001b[B" ||
            key === "\u001b[C")
        ) {
          const direction = key === "\u001b[A" || key === "\u001b[D" ? -1 : 1;
          const count = this.#snapshot?.gate?.options?.length ?? 0;
          this.#gateChoice = Math.max(
            0,
            Math.min(count - 1, this.#gateChoice + direction),
          );
          this.#gateConfirm = false;
          this.#gateMessage = undefined;
        }
      } else if (key === "\t" || key === "\u001b[Z") {
        const direction = key === "\t" ? 1 : -1;
        const index = REGIONS.indexOf(this.#focus);
        this.#focus = REGIONS[(index + direction + REGIONS.length) % REGIONS.length];
      } else if (key === "\u001b") {
        this.#returnToRail();
      } else if (key === "g" || key === "G") {
        this.#showGate();
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
          if (this.#gateVisible) {
            if (!this.#gateSubmitting) this.#leaveGate();
          } else this.#returnToRail();
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
  stageLogs?: ReadonlyMap<string, StageLog>,
  resolveGate?: GateResolver,
): RailTuiRenderer | undefined {
  if (!supportsRailTui(input, output)) return undefined;
  try {
    return new RailTuiRenderer(
      input,
      output,
      artifactsDir,
      stageLogs,
      resolveGate,
    );
  } catch {
    return undefined;
  }
}

export function createRunRenderer(
  input: Input,
  output: Output & ConstructorParameters<typeof PlainStatusRenderer>[0],
  artifactsDir: string,
  stageLogs?: ReadonlyMap<string, StageLog>,
  resolveGate?: GateResolver,
): PresentationRenderer & { close?: () => void } {
  return (
    createRailTuiRenderer(
      input,
      output,
      artifactsDir,
      stageLogs,
      resolveGate,
    ) ?? new PlainStatusRenderer(output)
  );
}
