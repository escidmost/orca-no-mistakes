import path from "node:path";
import { stripVTControlCharacters } from "node:util";

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

export type TerminalInput = Input;
export type TerminalOutput = Output;


type Region = "activity" | "detail" | "logs" | "rail";

type GateReturnState = {
  activityIndex: number;
  detailOffset: number;
  focus: Region;
  logOffset: number;
  pinnedStage?: StageName;
  selectedStage: number;
};

type Seg = string | readonly [text: string, sgr: string];
type Row = { bar?: string; right?: Seg[]; segs?: Seg[] };

const REGIONS: readonly Region[] = ["rail", "activity", "detail"];
const MIN_COLUMNS = 40;
const MIN_ROWS = 18;
const WIDE_COLUMNS = 90;
const LEFT_WIDTH = 44;
const SGR = {
  accent: "36",
  amber: "33",
  bold: "1",
  dim: "2",
  green: "32",
  red: "31",
  reverse: "7",
} as const;
const GLYPHS = {
  ascii: {
    active: "[>]",
    approved: "[approved]",
    arrows: "Up/Down",
    bar: " | ",
    blocked: "[?]",
    cancelled: "[-]",
    failed: "[!]",
    fixed: "[fixed]",
    fixing: "[F]",
    narrowArrows: "^v",
    open: "[open]",
    passed: "[x]",
    pending: "[ ]",
    sep: ", ",
  },
  unicode: {
    active: "\u25cf",
    approved: "~",
    arrows: "\u2191\u2193",
    bar: " \u2502 ",
    blocked: "?",
    cancelled: "\u2298",
    failed: "\u2717",
    fixed: "\u2713",
    fixing: "F",
    narrowArrows: "\u2191\u2193",
    open: "\u25cb",
    passed: "\u2713",
    pending: "\u00b7",
    sep: " \u00b7 ",
  },
} as const;

function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

function clock(now: number): string {
  const date = new Date(now);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function title(stage: StageName): string {
  return `${stage[0].toUpperCase()}${stage.slice(1)}`;
}

function analysisLabel(stageName: string, round: number): string {
  return `${stageName} analysis ${round}`;
}

function fixPhaseLabel(analysis: number, fixAttempt = 0): string {
  return `fix ${analysis}${fixAttempt > 0 ? ` retry ${fixAttempt}` : ""}`;
}

function analysisNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback;
}

function fixLabel(stageName: string, analysis: number, fixAttempt = 0): string {
  return `${stageName} ${fixPhaseLabel(analysis, fixAttempt)}`;
}

function activityCount(value: number, label: string): string {
  return `${value} ${label}`;
}

function activityResult(
  prefix: string,
  stageName: string,
  round: number,
  results: string[],
): string {
  return `${prefix.padEnd(analysisLabel(stageName, round).length)} · ${results.join(" · ")}`;
}

function printableText(text: string): string {
  let result = "";
  for (const character of text) {
    if (character === "\t") result += "  ";
    else if (character === "\r" || character === "\n") result += " ";
    else result += character >= " " && character <= "~" ? character : "?";
  }
  return result;
}

function safeText(text: string, maxLength = Number.POSITIVE_INFINITY): string {
  return redactKnownSecrets(
    printableText(stripVTControlCharacters(redactKnownSecrets(text))),
  ).slice(0, maxLength);
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
    const sanitized = redactKnownSecrets(
      stripVTControlCharacters(redactKnownSecrets(buffer.toString("utf8")))
        .split("\n")
        .map(printableText)
        .join("\n"),
    );
    const content = Buffer.from(sanitized)
      .subarray(-STAGE_LOG_TAIL_BYTES)
      .toString("utf8");
    return content.split("\n");
  } catch {
    return ["No log output yet."];
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
      return "Resolve the gate with this choice.";
  }
}

export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let rest = redactKnownSecrets(
    safeText(text, 2_048).replace(/\s+/gu, " "),
  ).trim();
  while (rest.length > width) {
    const space = rest.lastIndexOf(" ", width);
    const hyphen = rest.lastIndexOf("-", width - 1);
    let end: number;
    if (space > 0 && space >= hyphen) {
      end = space;
    } else if (hyphen > 0) {
      end = hyphen + 1;
    } else {
      end = width;
    }
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
  readonly #activities: {
    at: string;
    fix?: {
      analysis: number;
      approvedFindings: number;
      fixAttempt: number;
      findingIds: readonly string[];
      targetIndices?: readonly number[];
      verified: boolean;
    };
    label: string;
    stage?: StageName;
  }[] = [];
  readonly #artifactsDir: string;
  readonly #input: Input;
  readonly #inputWasPaused: boolean;
  readonly #inputWasRaw: boolean;
  readonly #output: Output;
  readonly #onFailure?: (
    error: unknown,
    snapshot?: PresentationSnapshot,
  ) => void;
  readonly #requestCancel: () => void;
  readonly #requestResume?: () => void;
  readonly #resolveGate?: GateResolver;
  readonly #setAutoFix?: (enabled: boolean) => Promise<void> | void;
  readonly #stageLogs: ReadonlyMap<string, StageLog>;
  readonly #color = process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
  readonly #glyph = /utf-?8/iu.test(
    process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "",
  )
    ? GLYPHS.unicode
    : GLYPHS.ascii;
  readonly #stageTimes = new Map<StageName, { end?: number; start: number }>();
  readonly #startedAt = Date.now();
  readonly #autoFixedStages = new Set<string>();
  readonly #autoResolvedGateIds = new Set<string>();
  #activityIndex = 0;
  #autoFix = false;
  #bell = "";
  #cancelVisible = false;
  #closed = false;
  #escapeTimer?: ReturnType<typeof setTimeout>;
  #drawImmediate?: ReturnType<typeof setImmediate>;
  #focus: Region = "rail";
  #gateChoice = 0;
  #gateConfirm = false;
  #gateMessage?: string;
  #gateOpenedAt = 0;
  #gateReturn?: GateReturnState;
  #gateSubmitting = false;
  #gateVisible = false;
  #detailOffset = 0;
  #inputBuffer = "";
  #lastFrame?: string;
  #logOffset = 0;
  #modeSubmitting = false;
  #pinnedStage?: StageName;
  #refreshTimer?: ReturnType<typeof setInterval>;
  #resumeVisible = false;
  #selectedStage = 0;
  #snapshot?: PresentationSnapshot;
  #suspended = false;
  #terminalActive = false;

  readonly #onData = (chunk: Buffer | string): void => {
    try {
      this.#handleInput(chunk.toString());
    } catch (error) {
      this.#fail(error);
    }
  };
  readonly #onError = (): void => this.#fail(new Error("terminal output failed"));
  readonly #onExit = (): void => this.close();
  readonly #onResize = (): void => this.#scheduleDraw();
  readonly #onSuspend = (): void => {
    if (this.#closed || this.#suspended) return;
    this.#suspended = true;
    this.#leaveTerminal();
    process.off("SIGTSTP", this.#onSuspend);
    try {
      process.kill(process.pid, "SIGTSTP");
    } catch (error) {
      this.#suspended = false;
      process.on("SIGTSTP", this.#onSuspend);
      this.#fail(error);
    }
  };
  readonly #onContinue = (): void => {
    if (this.#closed || !this.#suspended) return;
    this.#suspended = false;
    process.on("SIGTSTP", this.#onSuspend);
    try {
      this.#enterTerminal();
      this.#lastFrame = undefined;
      this.#scheduleDraw();
    } catch (error) {
      this.#fail(error);
    }
  };

  constructor(
    input: Input,
    output: Output,
    artifactsDir: string,
    stageLogs: ReadonlyMap<string, StageLog> = new Map(),
    resolveGate?: GateResolver,
    requestCancel: () => void = () => process.kill(process.pid, "SIGINT"),
    setAutoFix?: (enabled: boolean) => Promise<void> | void,
    requestResume?: () => void,
    onFailure?: (error: unknown, snapshot?: PresentationSnapshot) => void,
    initialAutoFix = false,
  ) {
    this.#autoFix = initialAutoFix;
    this.#input = input;
    this.#output = output;
    this.#artifactsDir = path.resolve(artifactsDir);
    this.#stageLogs = stageLogs;
    this.#resolveGate = resolveGate;
    this.#requestCancel = requestCancel;
    this.#requestResume = requestResume;
    this.#setAutoFix = setAutoFix;
    this.#onFailure = onFailure;
    this.#inputWasPaused = input.isPaused();
    this.#inputWasRaw = input.isRaw === true;
    try {
      input.on("data", this.#onData);
      output.on("error", this.#onError);
      output.on("resize", this.#onResize);
      process.once("exit", this.#onExit);
      process.on("SIGCONT", this.#onContinue);
      process.on("SIGTSTP", this.#onSuspend);
      this.#enterTerminal();
      this.#refreshTimer = setInterval(this.#onResize, 200);
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
    if (this.#drawImmediate) clearImmediate(this.#drawImmediate);
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#inputBuffer = "";
    this.#input.off("data", this.#onData);
    this.#output.off("error", this.#onError);
    this.#output.off("resize", this.#onResize);
    process.off("exit", this.#onExit);
    process.off("SIGCONT", this.#onContinue);
    process.off("SIGTSTP", this.#onSuspend);
    this.#leaveTerminal();
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
      const now = Date.now();
      for (const stage of snapshot.stages) {
        const time = this.#stageTimes.get(stage.id);
        if (stage.status === "active" || stage.status === "blocked") {
          if (!time || time.end !== undefined) {
            this.#stageTimes.set(stage.id, { start: now });
          }
        } else if (stage.status !== "pending" && time && time.end === undefined) {
          time.end = now;
        }
      }
      if (snapshot.error) this.#cancelVisible = false;
      if (snapshot.transition.kind === "attempt-started") {
        this.#resumeVisible = false;
        this.#returnToRail();
        this.#autoFixedStages.clear();
        this.#autoResolvedGateIds.clear();
      } else if (snapshot.transition.kind === "stage-completed") {
        this.#autoFixedStages.delete(snapshot.transition.stage);
      } else if (
        snapshot.transition.kind === "mode-changed" &&
        snapshot.transition.source !== "initial"
      ) {
        this.#autoFix = snapshot.mode.autoFix;
      }
      if (snapshot.transition.kind === "error-recorded") {
        this.#resumeVisible = Boolean(snapshot.error?.resumable);
      }
      if (opensGate) {
        this.#gateOpenedAt = now;
        this.#bell = "\u0007";
        this.#showGate();
        this.#maybeAutoRespondGate();
      } else if (snapshot.gate?.state === "open") {
        this.#maybeAutoRespondGate();
      }
      this.#logActivity(snapshot.transition, now, snapshot);
      if (settlesGate) this.#leaveGate();
      if (!opensGate && !settlesGate && !this.#pinnedStage && snapshot.currentStage) {
        const next = this.#stageIds().indexOf(snapshot.currentStage);
        if (next !== -1 && next !== this.#selectedStage) {
          this.#selectedStage = next;
          this.#detailOffset = 0;
        }
      }
      this.#scheduleDraw();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  seed(snapshots: readonly PresentationSnapshot[]): void {
    for (const snapshot of snapshots) {
      const now = Date.parse(snapshot.updatedAt) || Date.now();
      this.#logActivity(snapshot.transition, now, snapshot);
    }
  }

  #enterTerminal(): void {
    if (this.#closed || this.#terminalActive) return;
    this.#terminalActive = true;
    try {
      this.#input.setRawMode!(true);
      this.#input.resume();
      this.#output.write("\u001b[?1049h\u001b[?25l");
      if (this.#closed) throw new Error("terminal output failed");
    } catch (error) {
      this.#leaveTerminal();
      throw error;
    }
  }

  #leaveTerminal(): void {
    if (!this.#terminalActive) return;
    this.#terminalActive = false;
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

  #fail(error: unknown): void {
    if (this.#closed) return;
    const snapshot = this.#snapshot;
    this.close();
    try {
      this.#onFailure?.(error, snapshot);
    } catch {}
  }

  #scheduleDraw(): void {
    if (
      this.#closed ||
      this.#suspended ||
      this.#drawImmediate ||
      !this.#snapshot
    ) {
      return;
    }
    this.#drawImmediate = setImmediate(() => {
      this.#drawImmediate = undefined;
      try {
        this.#draw();
      } catch (error) {
        this.#fail(error);
      }
    });
    this.#drawImmediate.unref();
  }

  #stageIds(): readonly StageName[] {
    return this.#snapshot?.stages.map((item) => item.id) ?? PIPELINE_STEPS;
  }

  #showGate(): void {
    const gate = this.#snapshot?.gate;
    if (gate?.state !== "open" || !gate.options?.length || this.#gateVisible) return;
    this.#gateReturn = {
      activityIndex: this.#activityIndex,
      detailOffset: this.#detailOffset,
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
      this.#detailOffset = this.#gateReturn.detailOffset;
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

  #logActivity(
    transition: PresentationTransition,
    now: number,
    snapshot: PresentationSnapshot,
  ): void {
    const stage = transitionStage(transition);
    const last = this.#activities.at(-1);

    switch (transition.kind) {
      case "run-started":
        return;

      case "attempt-started":
        this.#activities.push({
          at: clock(now),
          label: `Run ${transition.attempt} started`,
        });
        break;

      case "mode-changed":
        if (this.#activities.length > 1) {
          this.#activities.push({
            at: clock(now),
            label: `Auto-fix ${transition.enabled ? "on" : "off"}`,
          });
        }
        break;

      case "stage-started":
        if (transition.stage === "intent" || transition.stage === "rebase") {
          this.#activities.push({
            at: clock(now),
            label: `${title(transition.stage)} started`,
            stage,
          });
        }
        break;

      case "stage-reopened":
        this.#activities.push({
          at: clock(now),
          label: `${title(transition.stage)} reopened`,
          stage,
        });
        break;

      case "round-started": {
        if (transition.stage === "intent" || transition.stage === "rebase") return;
        const stageName = title(transition.stage);
        const roundNum = transition.analysis ?? transition.round + 1;

        if (transition.role === "fixer") {
          const stageState = snapshot.stages.find((item) => item.id === transition.stage);
          const fixAnalysis = analysisNumber(
            transition.analysis ?? stageState?.analysis,
            transition.round,
          );
          const fixAttempt = transition.fixAttempt ?? stageState?.fixAttempt ?? 0;
          const fixPrefix = fixLabel(stageName, fixAnalysis, fixAttempt);
          if (!this.#activities.some((a) => a.stage === stage && a.label.startsWith(fixPrefix))) {
            this.#activities.push({
              at: clock(now),
              label: fixPrefix,
              stage,
            });
          }
          break;
        }

        if (roundNum > 1) {
          const priorRoundPrefix = analysisLabel(stageName, roundNum - 1);
          const priorFixPrefix = fixLabel(stageName, roundNum - 1);
          const priorRoundHadFindings = this.#activities.some(
            (a) => a.stage === stage && a.label.startsWith(priorRoundPrefix) && a.label.includes("found"),
          );
          const hasFix = this.#activities.some(
            (a) => a.stage === stage && a.label.startsWith(priorFixPrefix),
          );
          if (priorRoundHadFindings && !hasFix) {
            this.#activities.push({
              at: clock(now),
              label: priorFixPrefix,
              stage,
            });
          }
        }
        this.#activities.push({
          at: clock(now),
          label: analysisLabel(stageName, roundNum),
          stage,
        });
        break;
      }

      case "fix-completed": {
        const stageName = title(transition.stage);
        const stageState = snapshot.stages.find((s) => s.id === transition.stage);
        const fixAnalysis = analysisNumber(stageState?.analysis, transition.round);
        const fixAttempt = stageState?.fixAttempt ?? 0;
        const fixPrefix = fixLabel(stageName, fixAnalysis, fixAttempt);
        const appliedLabel = transition.findingIds.length === 1 ? "fix applied" : "fixes applied";
        const results = [activityCount(transition.findingIds.length, appliedLabel)];
        if (transition.approvedFindings > 0) {
          results.push(activityCount(transition.approvedFindings, "approved"));
        }
        const label = activityResult(
          fixPrefix,
          stageName,
          fixAnalysis,
          results,
        );
        const entry = this.#activities.findLast(
          (activity) => activity.stage === stage && activity.label === fixPrefix,
        );
        const targetIndices: number[] = [];
        if (stageState?.findings) {
          const remainingIds = new Map<string, number>();
          for (const id of transition.findingIds) {
            remainingIds.set(id, (remainingIds.get(id) ?? 0) + 1);
          }
          for (let i = 0; i < stageState.findings.length; i++) {
            const finding = stageState.findings[i];
            const count = remainingIds.get(finding.id) ?? 0;
            if (count > 0 && finding.disposition === "open") {
              remainingIds.set(finding.id, count - 1);
              targetIndices.push(i);
            }
          }
        }
        const fix = {
          analysis: fixAnalysis,
          approvedFindings: transition.approvedFindings,
          fixAttempt,
          findingIds: transition.findingIds,
          targetIndices,
          verified: false,
        };
        if (entry) {
          entry.fix = fix;
          entry.label = label;
        } else {
          this.#activities.push({ at: clock(now), fix, label, stage });
        }
        break;
      }

      case "fix-blocked": {
        const stageName = title(transition.stage);
        const stageState = snapshot.stages.find((item) => item.id === transition.stage);
        const fixAnalysis = analysisNumber(stageState?.analysis, transition.round);
        const fixAttempt = stageState?.fixAttempt ?? 0;
        const fixPrefix = fixLabel(stageName, fixAnalysis, fixAttempt);
        const entry = this.#activities.findLast(
          (activity) =>
            activity.stage === stage &&
            (activity.label === fixPrefix || activity.label.startsWith(`${fixPrefix} `)),
        );
        if (entry) {
          entry.label = activityResult(
            fixPrefix,
            stageName,
            fixAnalysis,
            ["blocked"],
          );
        }
        break;
      }

      case "findings-recorded": {
        if (transition.stage === "intent" || transition.stage === "rebase") return;
        const stageName = title(transition.stage);
        const stageState = snapshot.stages.find((s) => s.id === transition.stage);
        if (stageState?.phase === "fixer" && transition.analysis === undefined) {
          return;
        }
        const roundNum = transition.analysis ?? stageState?.analysis ?? transition.round + 1;
        const roundPrefix = analysisLabel(stageName, roundNum);
        const actionableCount = stageState?.openFindings ?? transition.actionable ?? transition.total;
        const countText =
          actionableCount > 0
            ? activityCount(actionableCount, "found")
            : "clean";

        const completedFix = this.#activities.findLast(
          (activity) => activity.stage === transition.stage && activity.fix && !activity.fix.verified,
        );
        if (completedFix?.fix && stageState?.findings) {
          let fixed = 0;
          let open = 0;
          if (completedFix.fix.targetIndices?.length) {
            for (const idx of completedFix.fix.targetIndices) {
              const finding = stageState.findings[idx];
              if (!finding) continue;
              if (finding.disposition === "fixed") fixed++;
              else if (finding.disposition === "open") open++;
            }
          } else {
            const remaining = new Map<string, number>();
            for (const id of completedFix.fix.findingIds) {
              remaining.set(id, (remaining.get(id) ?? 0) + 1);
            }
            for (const finding of stageState.findings) {
              if (finding.disposition !== "fixed" && finding.disposition !== "open") continue;
              const count = remaining.get(finding.id) ?? 0;
              if (count === 0) continue;
              remaining.set(finding.id, count - 1);
              if (finding.disposition === "fixed") fixed++;
              else if (finding.disposition === "open") open++;
            }
          }
          const results = [];
          if (fixed > 0) results.push(activityCount(fixed, "fixed"));
          if (open > 0) results.push(activityCount(open, "still open"));
          if (completedFix.fix.approvedFindings > 0) {
            results.push(activityCount(completedFix.fix.approvedFindings, "approved"));
          }
          if (results.length === 0) {
            results.push(activityCount(stageState.fixedFindings ?? 0, "fixed"));
          }
          completedFix.fix.verified = true;
          completedFix.label = activityResult(
            fixLabel(
              stageName,
              completedFix.fix.analysis,
              completedFix.fix.fixAttempt,
            ),
            stageName,
            completedFix.fix.analysis,
            results,
          );
        } else if (completedFix?.fix && stageState?.fixedFindings) {
          const results = [activityCount(stageState.fixedFindings, "fixed")];
          if (completedFix.fix.approvedFindings > 0) {
            results.push(activityCount(completedFix.fix.approvedFindings, "approved"));
          }
          completedFix.fix.verified = true;
          completedFix.label = activityResult(
            fixLabel(
              stageName,
              completedFix.fix.analysis,
              completedFix.fix.fixAttempt,
            ),
            stageName,
            completedFix.fix.analysis,
            results,
          );
        } else if (!completedFix && stageState?.fixedFindings) {
          for (let i = this.#activities.length - 1; i >= 0; i--) {
            const entry = this.#activities[i];
            if (
              entry.stage === transition.stage &&
              entry.label.includes("fix") &&
              !entry.label.includes("fixed")
            ) {
              const fixRound = Number(entry.label.match(/ fix (\d+)/u)?.[1] ?? roundNum - 1);
              entry.label = activityResult(
                fixLabel(stageName, fixRound),
                stageName,
                fixRound,
                [activityCount(stageState.fixedFindings, "fixed")],
              );
              break;
            }
          }
        }

        if (
          last &&
          last.stage === transition.stage &&
          last.label === roundPrefix
        ) {
          last.label = activityResult(roundPrefix, stageName, roundNum, [countText]);
        } else if (actionableCount > 0) {
          this.#activities.push({
            at: clock(now),
            label: activityResult(roundPrefix, stageName, roundNum, [countText]),
            stage,
          });
        }
        break;
      }

      case "gate-opened":
        if (!this.#autoFix) {
          this.#activities.push({
            at: clock(now),
            label: `${title(transition.stage)} decision needed`,
            stage,
          });
        }
        break;

      case "gate-resolved": {
        const stageName = title(transition.stage);
        if (transition.decision === "fix") {
          const stageState = snapshot.stages.find((item) => item.id === transition.stage);
          const analysis = analysisNumber(
            stageState?.analysis,
            stageState?.phase === "fixer"
              ? (transition.round ?? 1)
              : (transition.round ?? 0) + 1,
          );
          const fixAttempt =
            stageState?.phase === "fixer" ? (stageState.fixAttempt ?? 0) + 1 : 0;
          const fixPrefix = fixLabel(stageName, analysis, fixAttempt);
          if (
            last &&
            last.stage === transition.stage &&
            last.label.endsWith("decision needed")
          ) {
            last.label = fixPrefix;
          } else {
            this.#activities.push({
              at: clock(now),
              label: fixPrefix,
              stage,
            });
          }
        } else if (transition.decision === "approve") {
          if (
            last &&
            last.stage === transition.stage &&
            last.label.endsWith("decision needed")
          ) {
            last.label = `${stageName} approved`;
          } else {
            this.#activities.push({
              at: clock(now),
              label: `${stageName} approved`,
              stage,
            });
          }
        } else if (transition.decision) {
          this.#activities.push({
            at: clock(now),
            label: `${stageName} ${transition.decision}`,
            stage,
          });
        }
        break;
      }

      case "stage-completed": {
        if (
          last &&
          last.stage === transition.stage &&
          last.label.includes("fix") &&
          !last.label.includes("fixed")
        ) {
          const stageState = snapshot.stages.find((s) => s.id === transition.stage);
          if (stageState?.fixedFindings) {
            const stageName = title(transition.stage);
            const fixAnalysis = last.fix?.analysis ?? Number(last.label.match(/ fix (\d+)/u)?.[1] ?? 1);
            const fixAttempt = last.fix?.fixAttempt ?? 0;
            last.label = activityResult(
              fixLabel(stageName, fixAnalysis, fixAttempt),
              stageName,
              fixAnalysis,
              [activityCount(stageState.fixedFindings, "fixed")],
            );
            if (last.fix) last.fix.verified = true;
          }
        }
        const stageStatus = snapshot.stages.find((s) => s.id === transition.stage)?.status;
        if (stageStatus === "failed" || stageStatus === "cancelled") {
          this.#activities.push({
            at: clock(now),
            label: `${title(transition.stage)} ${stageStatus}`,
            stage,
          });
        }
        break;
      }

      case "error-recorded":
        this.#activities.push({
          at: clock(now),
          label: `Run error${transition.resumable ? " (resumable)" : ""}`,
        });
        break;

      case "cancellation-recorded":
        this.#activities.push({
          at: clock(now),
          label: `Cancelled: ${transition.action}`,
        });
        break;

      case "run-completed":
        this.#activities.push({
          at: clock(now),
          label: `Run ${transition.status}`,
        });
        break;
    }

    if (this.#activities.length > 50) this.#activities.shift();
    this.#activityIndex = this.#activities.length - 1;
  }

  #maybeAutoRespondGate(): void {
    const snapshot = this.#snapshot;
    const gate = snapshot?.gate;
    if (
      !gate ||
      gate.state !== "open" ||
      !gate.options?.length ||
      !this.#autoFix ||
      !this.#resolveGate ||
      this.#gateSubmitting ||
      this.#autoResolvedGateIds.has(gate.id)
    ) {
      return;
    }

    const stage = gate.stage;
    const stageState = stage
      ? snapshot.stages.find((s) => s.id === stage)
      : undefined;
    const actionable =
      (stageState?.openFindings ?? stageState?.actionableFindings ?? 0) > 0;

    let resolution: string | undefined;
    if (actionable) {
      if (stage && !this.#autoFixedStages.has(stage) && gate.options.includes("fix")) {
        resolution = "fix";
      }
    } else if (gate.options.includes("approve")) {
      resolution = "approve";
    }

    if (!resolution) return;

    this.#autoResolvedGateIds.add(gate.id);
    this.#gateSubmitting = true;
    this.#gateMessage = `Auto-resolving gate with ${resolution}...`;
    this.#scheduleDraw();

    void this.#resolveGate(gate.id, resolution).then(
      () => {
        if (resolution === "fix" && stage) {
          this.#autoFixedStages.add(stage);
        }
        if (this.#gateVisible && this.#snapshot?.gate?.id === gate.id) {
          this.#gateMessage = "Decision sent; waiting for settlement.";
          this.#scheduleDraw();
        }
      },
      (error) => {
        this.#autoResolvedGateIds.delete(gate.id);
        if (stage) this.#autoFixedStages.delete(stage);
        this.#gateSubmitting = false;
        if (this.#gateVisible && this.#snapshot?.gate?.id === gate.id) {
          this.#gateMessage = `Auto-resolve failed: ${String(error)}`;
          this.#scheduleDraw();
        }
      },
    );
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
    this.#scheduleDraw();
    void this.#resolveGate(gate.id, resolution).then(
      () => {
        if (this.#gateVisible && this.#snapshot?.gate?.id === gate.id) {
          this.#gateMessage = "Decision sent; waiting for settlement.";
          this.#scheduleDraw();
        }
      },
      (error) => {
        if (this.#gateVisible && this.#snapshot?.gate?.id === gate.id) {
          this.#gateSubmitting = false;
          this.#gateConfirm = false;
          this.#gateMessage = `Could not resolve gate: ${String(error)}`;
          this.#scheduleDraw();
        }
      },
    );
  }

  #draw(): void {
    if (this.#closed || !this.#terminalActive || !this.#snapshot) return;
    const columns = this.#output.columns ?? 0;
    const rows = this.#output.rows ?? 0;
    const screen =
      columns < MIN_COLUMNS || rows < MIN_ROWS
        ? this.#minimal(columns, rows)
        : this.#screen(columns, rows, Date.now());
    const frame = screen.join("\n");
    if (frame === this.#lastFrame) return;
    this.#output.write(`${this.#bell}\u001b[H\u001b[2J${frame}`);
    this.#bell = "";
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
    return lines.map((line) => this.#paint({ segs: [line] }, columns));
  }

  #screen(columns: number, rows: number, now: number): string[] {
    const bodyRows = rows - 3;
    let body: string[];
    if (columns >= WIDE_COLUMNS) {
      const leftWidth = Math.max(LEFT_WIDTH, Math.min(64, Math.floor(columns * 0.46)));
      const rightWidth = columns - leftWidth - this.#glyph.bar.length;
      const stages = this.#stages(now);
      const left = [
        ...stages,
        {},
        ...this.#activity(bodyRows - stages.length - 1),
      ];
      const right = this.#detail(bodyRows, rightWidth, now);
      const bar = this.#sgr(this.#glyph.bar, SGR.dim);
      body = Array.from(
        { length: bodyRows },
        (_, index) =>
          `${this.#paint(left[index] ?? {}, leftWidth)}${bar}${this.#paint(right[index] ?? {}, rightWidth)}`,
      );
    } else if (this.#overlay()) {
      const all = this.#detail(bodyRows, columns, now);
      body = Array.from({ length: bodyRows }, (_, index) =>
        this.#paint(all[index] ?? {}, columns),
      );
    } else {
      const stages = this.#stages(now);
      const remainingRows = bodyRows - stages.length - 2;
      const minDetail = this.#focus === "logs" ? 2 : 1;
      const maxActivity = Math.max(1, remainingRows - minDetail);
      const activityTarget = Math.max(
        1,
        Math.min(
          maxActivity,
          Math.max(
            3,
            Math.min(
              this.#activities.length + 1,
              Math.max(3, Math.floor(remainingRows * 0.35)),
            ),
          ),
        ),
      );
      const activity = this.#activity(activityTarget);
      const detailRows = Math.max(minDetail, remainingRows - activity.length);
      const detail = this.#detail(detailRows, columns, now);
      const all = [...stages, {}, ...activity, {}, ...detail];
      body = Array.from({ length: bodyRows }, (_, index) =>
        this.#paint(all[index] ?? {}, columns),
      );
    }
    return [this.#header(columns, now), "", ...body, this.#footer(columns)];
  }

  #overlay(): boolean {
    return this.#cancelVisible || this.#gateVisible || Boolean(this.#snapshot?.error);
  }

  #sgr(text: string, sgr?: string, bar?: string): string {
    if (!sgr || !this.#color || !text) return text;
    return `\u001b[${sgr}m${text}\u001b[0m${bar ? `\u001b[${bar}m` : ""}`;
  }

  #segs(
    segs: readonly Seg[],
    width: number,
    bar?: string,
  ): { text: string; used: number } {
    let text = "";
    let used = 0;
    for (const seg of segs) {
      const [raw, sgr] = typeof seg === "string" ? [seg, undefined] : seg;
      const room = width - used;
      if (!raw || room <= 0) continue;
      const piece =
        raw.length <= room
          ? raw
          : room === 1
            ? raw.slice(0, 1)
            : `${raw.slice(0, room - 1)}~`;
      used += piece.length;
      text += this.#sgr(piece, sgr, bar);
    }
    return { text, used };
  }

  #paint(row: Row, width: number): string {
    if (width <= 0) return "";
    const right = row.right
      ? this.#segs(row.right, width, row.bar)
      : { text: "", used: 0 };
    const left = this.#segs(
      row.segs ?? [],
      right.used ? Math.max(0, width - right.used - 1) : width,
      row.bar,
    );
    const pad = " ".repeat(Math.max(0, width - left.used - right.used));
    const body = `${left.text}${pad}${right.text}`;
    return row.bar && this.#color ? `\u001b[${row.bar}m${body}\u001b[0m` : body;
  }

  #stageDuration(stage: StageName, now: number): string {
    const time = this.#stageTimes.get(stage);
    return time ? elapsed((time.end ?? now) - time.start) : "";
  }

  #header(width: number, now: number): string {
    const snapshot = this.#snapshot!;
    const segs: Seg[] = width >= 60 ? [safeText(snapshot.runId, 60)] : [];
    if (width >= WIDE_COLUMNS) segs.push([`  attempt ${snapshot.attempt}`, SGR.dim]);
    if (width >= 120) segs.unshift(["orca no-mistakes", SGR.bold], "  ");
    if (this.#pinnedStage) {
      segs.push([`  pinned ${title(this.#pinnedStage)}`, SGR.dim]);
    }
    const autoFix = this.#autoFix;
    return this.#paint(
      {
        right: [
          this.#badge(now),
          "   ",
          [`auto-fix ${autoFix ? "on" : "off"}`, autoFix ? SGR.dim : SGR.amber],
          ...(width >= 120
            ? ["   ", [`run ${elapsed(now - this.#startedAt)}`, SGR.dim] as Seg]
            : []),
        ],
        segs,
      },
      width,
    );
  }

  #badge(now: number): Seg {
    const snapshot = this.#snapshot!;
    if (snapshot.gate?.state === "open") {
      return [
        `${this.#glyph.blocked} decision needed ${elapsed(now - this.#gateOpenedAt)}`,
        `${SGR.amber};${SGR.bold}`,
      ];
    }
    if (snapshot.error) {
      return [
        `${this.#glyph.failed} error${snapshot.error.resumable ? ", resumable" : ""}`,
        `${SGR.red};${SGR.bold}`,
      ];
    }
    if (snapshot.cancellation && snapshot.status === "in-progress") {
      return ["cancelling", SGR.amber];
    }
    if (snapshot.status === "passed") return [`${this.#glyph.passed} passed`, SGR.green];
    if (snapshot.status === "failed") return [`${this.#glyph.failed} failed`, SGR.red];
    if (snapshot.status === "cancelled") return ["cancelled", SGR.amber];
    const stage = snapshot.currentStage;
    if (!stage) return ["starting", SGR.dim];
    return [
      `${title(stage)} ${this.#stageDuration(stage, now)}`.trimEnd(),
      `${SGR.accent};${SGR.bold}`,
    ];
  }

  #regionTitle(label: string, region: Region): Row {
    const focused = this.#focus === region;
    return {
      segs: [
        `${focused ? ">" : " "} `,
        [label, focused ? `${SGR.accent};${SGR.bold}` : SGR.bold],
      ],
    };
  }

  #stages(now: number): Row[] {
    const snapshot = this.#snapshot!;
    const glyph = this.#glyph;
    const rows = [this.#regionTitle("STAGES", "rail")];
    for (const [index, stage] of this.#stageIds().entries()) {
      const state = snapshot.stages.find((item) => item.id === stage);
      const status =
        state?.status === "active" && stage !== snapshot.currentStage
          ? "pending"
          : (state?.status ?? "pending");
      const [marker, color] =
        status === "active"
          ? [glyph.active, SGR.accent]
          : status === "passed"
            ? [glyph.passed, SGR.green]
            : status === "blocked"
              ? [glyph.blocked, SGR.amber]
              : status === "cancelled"
                ? [glyph.cancelled, SGR.dim]
                : status === "pending"
                  ? [glyph.pending, SGR.dim]
                  : [glyph.failed, SGR.red];
      const selected = index === this.#selectedStage;
      const total = state?.totalFindings ?? 0;
      const fixed = state?.fixedFindings ?? 0;
      const approved = state?.approvedFindings ?? 0;
      const open = state?.openFindings ?? state?.actionableFindings ?? 0;
      const segs: Seg[] = [
        `${selected ? ">" : " "} `,
        [marker, color],
        " ",
        [title(stage).padEnd(8), status === "pending" ? SGR.dim : ""],
      ];
      if (state?.retainedFixer) {
        segs.push(" ", ["retained", SGR.dim]);
      }
      if (total > 0) {
        const findings = [
          activityCount(total, "found"),
          activityCount(fixed, "fixed"),
          ...(approved > 0 ? [activityCount(approved, "approved")] : []),
        ];
        segs.push(" ", [
          findings.join(glyph.sep),
          open > 0 ? SGR.amber : SGR.dim,
        ]);
      }
      rows.push({
        right: [[this.#stageDuration(stage, now), SGR.dim]],
        segs,
      });
    }
    return rows;
  }

  #activity(rows: number): Row[] {
    const lines = [this.#regionTitle("ACTIVITY", "activity")];
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
      const selected = index === this.#activityIndex;
      const entry = this.#activities[index];
      lines.push({
        right: [[entry.at, SGR.dim]],
        segs: [`${selected ? ">" : " "} `, entry.label],
      });
    }
    return lines.slice(0, rows);
  }

  #detail(rows: number, width: number, now: number): Row[] {
    const panel = this.#cancelVisible
      ? this.#cancelPanel(width)
      : this.#gateVisible
        ? this.#gatePanel(width, now)
        : this.#snapshot?.error
          ? this.#errorPanel(width)
          : this.#focus === "logs"
            ? this.#logs(rows)
            : this.#summary(width, now);
    const room = Math.max(1, rows);
    this.#detailOffset = Math.max(
      0,
      Math.min(this.#detailOffset, Math.max(0, panel.length - room)),
    );
    return panel.slice(this.#detailOffset, this.#detailOffset + rows);
  }

  #selectedStageId(): StageName {
    return this.#pinnedStage ?? this.#stageIds()[this.#selectedStage];
  }

  #isFixingStage(
    stage: StageName,
    state = this.#snapshot?.stages.find((item) => item.id === stage),
  ): boolean {
    if (state?.phase !== undefined) {
      return state.phase === "fixer";
    }
    return (
      (state?.status === "active" && (state?.round ?? 0) > 0) ||
      this.#autoFixedStages.has(stage)
    );
  }

  #summary(width: number, now: number): Row[] {
    const snapshot = this.#snapshot!;
    const glyph = this.#glyph;
    const stage = this.#selectedStageId();
    const state = snapshot.stages.find((item) => item.id === stage);
    const status = state?.status ?? "pending";
    const isFixing = this.#isFixingStage(stage, state);
    const roundLabel =
      state?.round !== undefined && status !== "pending"
        ? isFixing
          ? fixPhaseLabel(analysisNumber(state.analysis, state.round), state.fixAttempt)
          : `analysis ${state.analysis ?? state.round + 1}`
        : "";
    const meta = [
      status === "pending" ? "" : status,
      roundLabel,
      this.#stageDuration(stage, now),
      state?.retainedFixer ? "fixer retained" : "",
    ]
      .filter(Boolean)
      .join(glyph.sep);
    const focused = this.#focus === "detail";
    const rows: Row[] = [
      {
        segs: [
          `${focused ? ">" : " "} `,
          [title(stage).toUpperCase(), focused ? `${SGR.accent};${SGR.bold}` : SGR.bold],
          ["  " + meta, SGR.dim],
        ],
      },
    ];
    const total = state?.totalFindings ?? 0;
    const open = state?.openFindings ?? state?.actionableFindings ?? 0;
    const fixed = state?.fixedFindings ?? 0;
    const approved = state?.approvedFindings ?? 0;
    if (total > 0) {
      rows.push({
        segs: [
          ["  Findings  ", SGR.dim],
          [`${open} open`, open > 0 ? SGR.amber : SGR.dim],
          [glyph.sep, SGR.dim],
          [`${fixed} fixed`, fixed > 0 ? SGR.green : SGR.dim],
          [glyph.sep, SGR.dim],
          [`${approved} approved`, SGR.dim],
        ],
      });
    }
    if (snapshot.gate?.state === "open" && snapshot.gate.stage === stage) {
      rows.push({
        segs: ["  ", ["Waiting for your decision. Press G to open the gate.", SGR.amber]],
      });
    }
    rows.push({});
    const findings = state?.findings ?? [];
    if (findings.length === 0) {
      rows.push({
        segs: [
          "  ",
          [
            status === "pending"
              ? "Not started."
              : status === "active" || status === "blocked"
                ? "No findings yet."
                : "No findings.",
            SGR.dim,
          ],
        ],
      });
    }
    const targetFindingIds = state?.targetFindingIds
      ? new Set(state.targetFindingIds)
      : undefined;

    for (const finding of findings) {
      let dispGlyph: string;
      let color: string;
      const isTargetFixing =
        targetFindingIds !== undefined
          ? targetFindingIds.has(finding.id)
          : true;
      if (finding.disposition === "fixed") {
        dispGlyph = glyph.fixed;
        color = SGR.green;
      } else if (finding.disposition === "approved") {
        dispGlyph = glyph.approved;
        color = SGR.dim;
      } else if (isFixing && status === "active" && isTargetFixing) {
        dispGlyph = glyph.fixing;
        color = SGR.amber;
      } else {
        dispGlyph = glyph.open;
        color =
          finding.severity === "error"
            ? SGR.red
            : finding.severity === "warning"
              ? SGR.amber
              : SGR.accent;
      }
      const head = `  ${dispGlyph} `;
      const idWidth = 24;
      const idLines = wrap(finding.id, idWidth);
      const location = finding.file
        ? safeText(
            `${finding.file}${finding.line ? `:${finding.line}` : ""}`,
            120,
          )
        : "";

      const stack = width - (head.length + idWidth + 2) < 16;
      if (stack) {
        for (let i = 0; i < idLines.length; i++) {
          if (i === 0) {
            rows.push({
              segs: ["  ", [dispGlyph, color], " ", [idLines[i] ?? "", SGR.bold]],
            });
          } else {
            rows.push({
              segs: [" ".repeat(head.length), [idLines[i] ?? "", SGR.bold]],
            });
          }
        }
        const descIndent = " ".repeat(head.length);
        const descLines = wrap(finding.description, Math.max(8, width - descIndent.length));
        for (const descLine of descLines) {
          rows.push({ segs: [descIndent, descLine] });
        }
        if (location) {
          rows.push({ segs: [descIndent, [location, SGR.dim]] });
        }
      } else {
        const indent = " ".repeat(head.length + idWidth + 2);
        const descLines = wrap(finding.description, width - indent.length);
        const lineCount = Math.max(idLines.length, descLines.length);

        for (let i = 0; i < lineCount; i++) {
          const idPart = (idLines[i] ?? "").padEnd(idWidth);
          const descPart = descLines[i] ?? "";
          if (i === 0) {
            rows.push({
              segs: ["  ", [dispGlyph, color], " ", [idPart, SGR.bold], "  ", descPart],
            });
          } else {
            rows.push({
              segs: [" ".repeat(head.length), [idPart, SGR.bold], "  ", descPart],
            });
          }
        }
        if (location) {
          const last = rows[rows.length - 1];
          const used = (last?.segs ?? []).reduce(
            (sum, seg) => sum + (typeof seg === "string" ? seg : seg[0]).length,
            0,
          );
          if (last && used + location.length + 2 <= width) {
            last.right = [[location, SGR.dim]];
          } else {
            rows.push({ segs: [indent, [location, SGR.dim]] });
          }
        }
      }
    }
    return rows;
  }

  #logs(rows: number): Row[] {
    const snapshot = this.#snapshot!;
    const stage = this.#selectedStageId();
    const state = snapshot.stages.find((item) => item.id === stage);
    const isFixing = this.#isFixingStage(stage, state);
    const round = state?.round ?? 0;
    const roundLabel =
      round !== undefined
        ? isFixing
          ? `  ${fixPhaseLabel(analysisNumber(state?.analysis, round), state?.fixAttempt)}`
          : `  analysis ${state?.analysis ?? round + 1}`
        : "";
    const all = logTail(this.#artifactsDir, `${stage}_r${round}.log`, this.#stageLogs);
    const room = Math.max(0, rows - 1);
    this.#logOffset = Math.min(this.#logOffset, Math.max(0, all.length - room));
    const bottom = Math.max(0, all.length - this.#logOffset);
    const visible = all.slice(Math.max(0, bottom - room), bottom);
    const focused = this.#focus === "logs";
    return [
      {
        segs: [
          `${focused ? ">" : " "} `,
          [`${title(stage).toUpperCase()} LOG`, focused ? `${SGR.accent};${SGR.bold}` : SGR.bold],
          [roundLabel, SGR.dim],
        ],
      },
      ...visible.map((line) => ({ segs: [line] })),
    ];
  }

  #gatePanel(width: number, now: number): Row[] {
    const gate = this.#snapshot?.gate;
    if (!gate) return [];
    const options = gate.options ?? [];
    const choice = options[this.#gateChoice];
    const stage = gate.stage ?? this.#snapshot!.currentStage ?? "intent";
    const stageState = this.#snapshot?.stages.find((item) => item.id === stage);
    const gateLabel = this.#isFixingStage(stage, stageState)
      ? fixPhaseLabel(
          analysisNumber(
            stageState?.analysis,
            stageState?.round ?? gate.round ?? 1,
          ),
          stageState?.fixAttempt,
        )
      : `analysis ${stageState?.analysis ?? (gate.round ?? 0) + 1}`;
    const rows: Row[] = [
      { segs: ["  ", ["DECISION REQUIRED", `${SGR.amber};${SGR.bold}`]] },
      {
        segs: [
          "  ",
          [
            `${title(stage)} ${gateLabel}${this.#glyph.sep}waiting ${elapsed(now - this.#gateOpenedAt)}`,
            SGR.dim,
          ],
        ],
      },
      {},
      ...wrap(gate.question ?? "Human decision required.", width - 2)
        .slice(0, 4)
        .map((line) => ({ segs: ["  ", line] })),
      {},
    ];
    for (const [index, option] of options.entries()) {
      const selected = index === this.#gateChoice;
      rows.push({
        bar: selected ? SGR.reverse : undefined,
        segs: [
          `${selected ? ">" : " "} `,
          [safeText(option, 16).padEnd(8), selected ? SGR.bold : ""],
          ["  " + gateConsequence(option, gate.stage), SGR.dim],
        ],
      });
    }
    rows.push({});
    rows.push({
      segs: [
        "  ",
        this.#gateConfirm
          ? [`Confirm ${safeText(choice ?? "", 16)}? Press Enter again.`, SGR.amber]
          : this.#gateMessage
            ? [safeText(this.#gateMessage, 240), SGR.amber]
            : ["Enter selects. Esc returns unanswered.", SGR.dim],
      ],
    });
    if (this.#gateConfirm || this.#gateSubmitting) {
      rows.push({
        segs: [
          "  ",
          [
            this.#gateMessage
              ? safeText(this.#gateMessage, 240)
              : "Esc returns without resolving the gate.",
            SGR.dim,
          ],
        ],
      });
    }
    return rows;
  }

  #cancelPanel(width: number): Row[] {
    const stage = this.#snapshot?.currentStage;
    return [
      { segs: ["  ", ["CANCEL RUN?", `${SGR.red};${SGR.bold}`]] },
      {
        segs: [
          "  ",
          [
            `${stage ? `${title(stage)}${this.#glyph.sep}` : ""}${this.#snapshot?.status ?? "in-progress"}`,
            SGR.dim,
          ],
        ],
      },
      {},
      ...wrap(
        "Cancel stops new work, preserves recovery evidence, and cleans up resources.",
        width - 2,
      ).map((line) => ({ segs: ["  ", line] })),
      {},
      { segs: ["  Press Enter to confirm Cancel."] },
      { segs: ["  Press Esc to keep the run active."] },
    ];
  }

  #errorPanel(width: number): Row[] {
    const resumable = this.#snapshot?.error?.resumable === true;
    const stage = this.#snapshot?.currentStage;
    return [
      {
        segs: [
          "  ",
          [`RUN ERROR${resumable ? " (RESUMABLE)" : ""}`, `${SGR.red};${SGR.bold}`],
        ],
      },
      {
        segs: [
          "  ",
          [
            `${stage ? `${title(stage)}${this.#glyph.sep}` : ""}attempt ${this.#snapshot?.attempt ?? 0} settled`,
            SGR.dim,
          ],
        ],
      },
      {},
      ...wrap(
        resumable
          ? "The failed attempt is settled and cleaned. Resume reconstructs the next attempt from its durable checkpoint."
          : "This error is not safe to resume in the current process.",
        width - 2,
      ).map((line) => ({ segs: ["  ", line] })),
      {},
      {
        segs: [
          "  ",
          resumable && this.#requestResume
            ? this.#resumeVisible
              ? "Press R to resume, or C to leave the run stopped."
              : "Resume requested. Waiting for the next attempt."
            : "Press C to leave the run stopped.",
        ],
      },
    ];
  }

  #footer(width: number): string {
    const isNarrow = width < 60;
    const arrows = isNarrow ? this.#glyph.narrowArrows : this.#glyph.arrows;
    const hints: [string, string][] = [];
    if (this.#cancelVisible) {
      hints.push(["Enter", "confirm cancel"], ["Esc", "keep running"]);
    } else if (this.#gateVisible) {
      if (this.#gateSubmitting) hints.push(["", "Waiting for gate settlement"]);
      else {
        hints.push(
          [arrows, "choose"],
          ["Enter", isNarrow ? "select" : "select/confirm"],
          ["Esc", isNarrow ? "back" : "return unanswered"],
        );
      }
      if (this.#setAutoFix) hints.push(["A", "auto-fix"]);
      hints.push(["C", "cancel"]);
    } else if (this.#snapshot?.error) {
      if (this.#snapshot.error.resumable && this.#requestResume && this.#resumeVisible) {
        hints.push(["R", "resume"]);
      }
      hints.push(["C", "leave stopped"]);
    } else {
      hints.push(["Tab", "pane"]);
      if (this.#focus === "logs" || this.#focus === "detail") hints.push([arrows, "scroll"]);
      else {
        hints.push([arrows, "move"]);
        if (!isNarrow) hints.push(["Enter", "open"]);
      }
      if (!isNarrow && (this.#pinnedStage || this.#focus === "logs" || this.#focus === "detail")) hints.push(["Esc", "back"]);
      if (!isNarrow && this.#snapshot?.gate?.state === "open") hints.push(["G", "gate"]);
      if (this.#setAutoFix) hints.push(["A", "auto-fix"]);
      hints.push(["C", "cancel"]);
    }
    const segs: Seg[] = [" "];
    const separator = isNarrow ? "  " : "   ";
    for (const [key, action] of hints) {
      if (segs.length > 1) segs.push(separator);
      if (key) segs.push([key, SGR.bold], " ");
      segs.push([action, key === "G" ? SGR.amber : SGR.dim]);
    }
    return this.#paint({ segs }, width);
  }

  #handleInput(input: string): void {
    if (this.#escapeTimer) {
      clearTimeout(this.#escapeTimer);
      this.#escapeTimer = undefined;
    }
    this.#inputBuffer += input;
    const incomplete =
      this.#inputBuffer.match(
        new RegExp(
          "\\x1b(?:\\[[0-?]*[ -/]*|O|\\][^\\x00-\\x1f]*\\x1b?|[P_^][^\\x00-\\x1f]*\\x1b?)?$",
          "u",
        ),
      )?.[0] ?? "";
    const complete = incomplete
      ? this.#inputBuffer.slice(0, -incomplete.length)
      : this.#inputBuffer;
    this.#inputBuffer = incomplete.length > 4096 ? "" : incomplete;
    const keys =
      complete.match(
        new RegExp(
          "\\x1b\\[[0-?]*[ -/]*[@-~]|\\x1bO[@-~]|\\x1b\\][^\\x00-\\x1f]*(?:\\x07|\\x1b\\\\)|\\x1b\\][^\\x00-\\x1f]*|\\x1b[P_^][^\\x00-\\x1f]*\\x1b\\\\|\\x1b[P_^][^\\x00-\\x1f]*|\\x03|\\x1a|\\r|\\n|\\t|\\x1b|[aAcCgGrR]",
          "g",
        ),
      ) ?? [];
    for (let key of keys) {
      if (key.length === 3 && key.startsWith("\u001bO") && "ABCD".includes(key[2])) {
        key = `\u001b[${key[2]}`;
      }
      if (key === "\u001a") {
        this.#onSuspend();
        return;
      } else if (key === "\u0003") {
        this.#cancelRun();
        return;
      } else if (this.#cancelVisible) {
        if (key === "\u001b") this.#cancelVisible = false;
        else if (key === "\r" || key === "\n") {
          this.#cancelRun();
          return;
        }
      } else if ((key === "c" || key === "C") && this.#snapshot?.error) {
        this.#cancelRun();
        return;
      } else if (key === "c" || key === "C") {
        this.#cancelVisible = true;
      } else if (key === "a" || key === "A") {
        this.#toggleAutoFix();
      } else if (
        (key === "r" || key === "R") &&
        this.#resumeVisible &&
        this.#requestResume
      ) {
        this.#resumeVisible = false;
        this.#activities.push({ at: clock(Date.now()), label: "Resume requested" });
        this.#requestResume();
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
        const held = this.#inputBuffer;
        this.#inputBuffer = "";
        if (this.#closed || held !== "\x1b") return;
        try {
          if (this.#cancelVisible) this.#cancelVisible = false;
          else if (this.#gateVisible) {
            if (!this.#gateSubmitting) this.#leaveGate();
          } else this.#returnToRail();
          this.#scheduleDraw();
        } catch (error) {
          this.#fail(error);
        }
      }, 100);
    }
    this.#scheduleDraw();
  }

  #cancelRun(): void {
    this.close();
    this.#requestCancel();
  }

  #toggleAutoFix(): void {
    if (this.#modeSubmitting) return;
    this.#autoFix = !this.#autoFix;
    const enabled = this.#autoFix;
    this.#scheduleDraw();
    if (!this.#setAutoFix) {
      if (enabled) this.#maybeAutoRespondGate();
      return;
    }
    this.#modeSubmitting = true;
    void Promise.resolve()
      .then(() => this.#setAutoFix!(enabled))
      .then(
        () => {
          this.#modeSubmitting = false;
          if (enabled && this.#snapshot?.mode.autoFix === enabled) {
            this.#maybeAutoRespondGate();
          }
          this.#scheduleDraw();
        },
        (error) => {
          this.#modeSubmitting = false;
          this.#autoFix = !enabled;
          this.#activities.push({
            at: clock(Date.now()),
            label: safeText(`Auto-fix unchanged: ${String(error)}`, 240),
          });
          this.#scheduleDraw();
        },
      );
  }

  #returnToRail(): void {
    this.#pinnedStage = undefined;
    this.#focus = "rail";
    const current = this.#snapshot?.currentStage;
    if (current) {
      const next = this.#stageIds().indexOf(current);
      if (next !== -1 && next !== this.#selectedStage) {
        this.#selectedStage = next;
        this.#detailOffset = 0;
      }
    }
  }

  #move(direction: -1 | 1): void {
    if (this.#focus === "rail") {
      const next = Math.max(
        0,
        Math.min(this.#stageIds().length - 1, this.#selectedStage + direction),
      );
      if (next !== this.#selectedStage) {
        this.#selectedStage = next;
        this.#detailOffset = 0;
      }
    } else if (this.#focus === "activity") {
      this.#activityIndex = Math.max(
        0,
        Math.min(this.#activities.length - 1, this.#activityIndex + direction),
      );
    } else if (this.#focus === "detail") {
      this.#detailOffset = Math.max(0, this.#detailOffset + direction);
    } else {
      this.#logOffset = Math.max(0, this.#logOffset - direction);
    }
  }

  #open(): void {
    if (this.#focus === "logs") return;
    if (this.#focus === "activity") {
      const stage = this.#activities[this.#activityIndex]?.stage;
      if (stage) {
        const next = this.#stageIds().indexOf(stage);
        if (next !== -1 && next !== this.#selectedStage) {
          this.#selectedStage = next;
          this.#detailOffset = 0;
        }
      }
    }
    this.#pinnedStage = this.#stageIds()[this.#selectedStage];
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
  requestCancel?: () => void,
  setAutoFix?: (enabled: boolean) => Promise<void> | void,
  requestResume?: () => void,
  onResumeAvailable?: () => void,
  onFailure?: (error: unknown, snapshot?: PresentationSnapshot) => void,
  initialAutoFix = false,
): RailTuiRenderer | undefined {
  if (!supportsRailTui(input, output)) return undefined;
  let renderer: RailTuiRenderer | undefined;
  try {
    renderer = new RailTuiRenderer(
      input,
      output,
      artifactsDir,
      stageLogs,
      resolveGate,
      requestCancel,
      setAutoFix,
      requestResume,
      onFailure,
      initialAutoFix,
    );
    onResumeAvailable?.();
    return renderer;
  } catch (error) {
    renderer?.close();
    onFailure?.(error);
    return undefined;
  }
}

export function createRunRenderer(
  input: Input,
  output: Output & ConstructorParameters<typeof PlainStatusRenderer>[0],
  artifactsDir: string,
  stageLogs?: ReadonlyMap<string, StageLog>,
  resolveGate?: GateResolver,
  requestCancel?: () => void,
  setAutoFix?: (enabled: boolean) => Promise<void> | void,
  requestResume?: () => void,
  onResumeAvailable?: () => void,
  onFailure?: (error: unknown) => void,
  initialAutoFix = false,
): PresentationRenderer & { close?: () => void } {
  let fallback: PlainStatusRenderer | undefined;
  let failed = false;
  let rail: RailTuiRenderer | undefined;
  const plain = (): PlainStatusRenderer =>
    (fallback ??= new PlainStatusRenderer(output));
  const switchToPlain = (
    error: unknown,
    snapshot?: PresentationSnapshot,
  ): void => {
    if (failed) return;
    failed = true;
    rail?.close();
    if (onFailure) {
      try {
        onFailure(error);
      } catch {}
    } else {
      try {
        output.write("warning: interactive presentation failed; using plain status\n");
      } catch {}
    }
    if (snapshot) {
      try {
        plain().render(snapshot);
      } catch {}
    }
  };
  rail = createRailTuiRenderer(
    input,
    output,
    artifactsDir,
    stageLogs,
    resolveGate,
    requestCancel,
    setAutoFix,
    requestResume,
    undefined,
    switchToPlain,
    initialAutoFix,
  );
  if (!rail || failed) return plain();
  try {
    onResumeAvailable?.();
  } catch (error) {
    switchToPlain(error);
    return plain();
  }
  return {
    close: () => rail.close(),
    render: (snapshot) => {
      if (failed) {
        plain().render(snapshot);
        return;
      }
      try {
        rail.render(snapshot);
      } catch (error) {
        switchToPlain(error, snapshot);
      }
    },
    seed: (snapshots) => {
      if (failed) return;
      try {
        rail.seed(snapshots);
      } catch (error) {
        switchToPlain(error);
      }
    },
  };
}
