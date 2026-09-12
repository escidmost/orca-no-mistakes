import { stripVTControlCharacters } from "node:util";

import { PIPELINE_STEPS, type StageName } from "./config.ts";
import { redactKnownSecrets } from "./ledger.ts";
import type { LiveValidation } from "./live-validation.ts";

export type PresentationStatus =
  | "in-progress"
  | "passed"
  | "failed"
  | "cancelled";

export type GateResolver = (gateId: string, resolution: string) => Promise<void>;
export type CancellationAction = "cancel" | "force-stop" | "gate-stop";

export type PresentationFinding = {
  description: string;
  disposition: "approved" | "fixed" | "open";
  file?: string;
  id: string;
  line?: number;
  severity: "error" | "info" | "warning";
};

export type FixRecord = {
  analysis: number;
  fixAttempt?: number;
  summary: string;
};

export type PresentationTransition =
  | { kind: "run-started" }
  | { attempt: number; kind: "attempt-started" }
  | { enabled: boolean; kind: "mode-changed"; source?: "initial" | "operator" }
  | { kind: "stage-started"; stage: StageName }
  | { kind: "stage-reopened"; stage: StageName }
  | {
      analysis?: number;
      fixAttempt?: number;
      kind: "round-started";
      role?: "fixer" | "reviewer";
      round: number;
      stage: StageName;
      targetFindingIds?: readonly string[];
    }
  | {
      analysis?: number;
      approvedFindings: number;
      findingIds: readonly string[];
      fixAttempt?: number;
      kind: "fix-completed";
      round: number;
      stage: StageName;
      summary?: string;
    }
  | {
      actionable: number;
      findings: readonly Omit<PresentationFinding, "disposition">[];
      kind: "fix-blocked";
      round: number;
      stage: StageName;
      total: number;
    }
  | {
      analysis?: number;
      actionable: number;
      findings?: readonly Omit<PresentationFinding, "disposition">[];
      kind: "findings-recorded";
      liveValidation?: LiveValidation;
      evidenceCommitOid?: string;
      retainedFixer?: boolean;
      round: number;
      stage: StageName;
      total: number;
    }
  | {
      gateId: string;
      gateKind?: PresentationGateKind;
      kind: "gate-opened";
      options: string[];
      question: string;
      round: number;
      stage: StageName;
    }
  | {
      decision: string;
      gateId: string;
      kind: "gate-resolved";
      round: number;
      stage: StageName;
      targetFindingIds?: readonly string[];
    }
  | { kind: "stage-completed"; round: number; stage: StageName }
  | { kind: "error-recorded"; resumable: boolean }
  | {
      action: CancellationAction;
      kind: "cancellation-recorded";
    }
  | {
      kind: "run-completed";
      status: "passed" | "failed" | "cancelled";
    };

export type PresentationGateKind = "exhaustion" | "finding" | "guardrail";

export type PresentationSnapshot = {
  attempt: number;
  cancellation?: { action: CancellationAction };
  currentStage?: StageName;
  error?: { resumable: boolean };
  gate?: {
    decision?: string;
    gateKind?: PresentationGateKind;
    id: string;
    options?: readonly string[];
    question?: string;
    round?: number;
    state: "open" | "resolved";
    stage?: StageName;
  };
  mode: { autoFix: boolean };
  runId: string;
  sequence: number;
  stages: readonly {
    actionableFindings: number;
    analysis?: number;
    analysisFindings?: { new: number; stillOpen: number; reopened: number };
    approvedFindings?: number;
    findings?: readonly PresentationFinding[];
    fixRecords?: readonly FixRecord[];
    fixSummaries?: readonly string[];
    fixAttempt?: number;
    fixedFindings?: number;
    id: StageName;
    liveValidation?: LiveValidation;
    evidenceCommitOid?: string;
    openFindings?: number;
    phase?: "fixer" | "reviewer";
    retainedFixer?: boolean;
    round: number;
    status: "pending" | "active" | "blocked" | "passed" | "failed" | "cancelled";
    targetFindingIds?: readonly string[];
    totalFindings: number;
  }[];
  status: PresentationStatus;
  transition: PresentationTransition;
  updatedAt: string;
  version: 1;
};

export interface PresentationStore {
  listPresentationSnapshots(runId: string): PresentationSnapshot[];
  recordPresentationSnapshot(
    runId: string,
    eventKey: string,
    snapshot: PresentationSnapshot,
  ): boolean;
}

export interface PresentationRenderer {
  render(snapshot: PresentationSnapshot): void;
  seed?(snapshots: readonly PresentationSnapshot[]): void;
}

function initialSnapshot(
  runId: string,
  stages: readonly StageName[] = PIPELINE_STEPS,
): PresentationSnapshot {
  return {
    attempt: 0,
    mode: { autoFix: true },
    runId,
    sequence: 0,
    stages: stages.map((id) => ({
      actionableFindings: 0,
      analysis: 0,
      approvedFindings: 0,
      findings: [],
      fixRecords: [],
      fixSummaries: [],
      fixedFindings: 0,
      id,
      openFindings: 0,
      round: 0,
      status: "pending" as const,
      totalFindings: 0,
    })),
    status: "in-progress",
    transition: { kind: "run-started" },
    updatedAt: "",
    version: 1,
  };
}

function updateStage(
  snapshot: PresentationSnapshot,
  stage: StageName,
  update: Partial<PresentationSnapshot["stages"][number]>,
): PresentationSnapshot["stages"] {
  return snapshot.stages.map((item) =>
    item.id === stage ? { ...item, ...update } : item,
  );
}

function isExactFindingMatch(
  prev: PresentationFinding,
  curr: Omit<PresentationFinding, "disposition">,
): boolean {
  return (
    prev.id === curr.id &&
    prev.description === curr.description &&
    prev.severity === curr.severity &&
    prev.file === curr.file &&
    prev.line === curr.line
  );
}

function updateFindings(
  previous: readonly PresentationFinding[],
  current: readonly Omit<PresentationFinding, "disposition">[],
  options?: { inheritApproval?: boolean },
): PresentationFinding[] {
  const inheritApproval = options?.inheritApproval ?? true;
  const matchedInPrevious = new Map<
    number,
    Omit<PresentationFinding, "disposition">
  >();
  const usedCurrent = new Set<number>();

  for (let ci = 0; ci < current.length; ci++) {
    const curr = current[ci];
    let matchIndex = -1;
    for (let pi = 0; pi < previous.length; pi++) {
      if (
        !matchedInPrevious.has(pi) &&
        previous[pi].disposition === "open" &&
        isExactFindingMatch(previous[pi], curr)
      ) {
        matchIndex = pi;
        break;
      }
    }
    if (matchIndex === -1 && inheritApproval) {
      for (let pi = 0; pi < previous.length; pi++) {
        if (
          !matchedInPrevious.has(pi) &&
          previous[pi].disposition !== "open" &&
          isExactFindingMatch(previous[pi], curr)
        ) {
          matchIndex = pi;
          break;
        }
      }
    }
    if (matchIndex !== -1) {
      matchedInPrevious.set(matchIndex, curr);
      usedCurrent.add(ci);
    }
  }

  for (let ci = 0; ci < current.length; ci++) {
    if (usedCurrent.has(ci)) continue;
    const curr = current[ci];
    let matchIndex = -1;
    for (let pi = 0; pi < previous.length; pi++) {
      if (
        !matchedInPrevious.has(pi) &&
        previous[pi].disposition === "open" &&
        previous[pi].id === curr.id
      ) {
        matchIndex = pi;
        break;
      }
    }
    if (matchIndex === -1) {
      matchIndex = previous.findIndex((prev, pi) =>
        !matchedInPrevious.has(pi) && prev.disposition === "fixed" && prev.id === curr.id,
      );
    }
    if (matchIndex !== -1) {
      matchedInPrevious.set(matchIndex, curr);
      usedCurrent.add(ci);
    }
  }

  const next = previous.map((prev, pi) => {
    const reported = matchedInPrevious.get(pi);
    if (reported) {
      if (prev.disposition === "approved" && inheritApproval) {
        return { ...reported, disposition: "approved" as const };
      }
      return { ...reported, disposition: "open" as const };
    }
    return prev.disposition === "open" && inheritApproval
      ? { ...prev, disposition: "fixed" as const }
      : prev;
  });

  const remaining: PresentationFinding[] = [];
  for (let ci = 0; ci < current.length; ci++) {
    if (!usedCurrent.has(ci)) {
      remaining.push({ ...current[ci], disposition: "open" as const });
    }
  }

  return [...next, ...remaining];
}

function updateSelectedFindings(
  findings: readonly PresentationFinding[],
  selectedIds: readonly string[],
  selectedDisposition: PresentationFinding["disposition"],
  unselectedDisposition?: PresentationFinding["disposition"],
): PresentationFinding[] {
  const remaining = new Map<string, number>();
  for (const id of selectedIds) remaining.set(id, (remaining.get(id) ?? 0) + 1);
  return findings.map((finding) => {
    if (finding.disposition !== "open") return finding;
    const count = remaining.get(finding.id) ?? 0;
    if (count > 0) {
      remaining.set(finding.id, count - 1);
      return { ...finding, disposition: selectedDisposition };
    }
    return unselectedDisposition
      ? { ...finding, disposition: unselectedDisposition }
      : finding;
  });
}

function nextSnapshot(
  previous: PresentationSnapshot,
  transition: PresentationTransition,
  updatedAt: string,
): PresentationSnapshot {
  let next: PresentationSnapshot = {
    ...previous,
    sequence: previous.sequence + 1,
    transition,
    updatedAt,
  };
  switch (transition.kind) {
    case "run-started":
      next = { ...next, status: "in-progress" };
      break;
    case "attempt-started":
      next = {
        ...next,
        attempt: transition.attempt,
        cancellation: undefined,
        currentStage: undefined,
        error: undefined,
        gate: undefined,
        stages: next.stages.map((stage) => ({
          ...stage,
          phase: stage.status === "passed" || stage.fixAttempt !== undefined ? stage.phase : undefined,
          round: stage.status === "passed" || stage.fixAttempt !== undefined ? stage.round : 0,
          status: stage.status === "passed" ? "passed" : "pending",
          targetFindingIds:
            stage.status === "passed" ? stage.targetFindingIds : undefined,
        })),
        status: "in-progress",
      };
      break;
    case "mode-changed":
      next = { ...next, mode: { autoFix: transition.enabled } };
      break;
    case "stage-started":
      next = {
        ...next,
        currentStage: transition.stage,
        error: undefined,
        gate: undefined,
        stages: updateStage(next, transition.stage, { status: "active" }),
      };
      break;
    case "stage-reopened": {
      const stage = next.stages.find((item) => item.id === transition.stage);
      const invalidatedFindings = stage?.findings?.map((f) =>
        f.disposition === "approved" ? { ...f, disposition: "open" as const } : f,
      );
      const fixed = invalidatedFindings?.filter((f) => f.disposition === "fixed").length ?? 0;
      const open = invalidatedFindings?.filter((f) => f.disposition === "open").length ?? 0;
      next = {
        ...next,
        currentStage: transition.stage,
        error: undefined,
        gate: undefined,
        stages: updateStage(next, transition.stage, {
          actionableFindings: open,
          analysisFindings: undefined,
          liveValidation: undefined,
          evidenceCommitOid: undefined,
          approvedFindings: 0,
          findings: invalidatedFindings,
          fixAttempt: undefined,
          fixRecords: stage?.fixRecords,
          fixSummaries: stage?.fixSummaries,
          fixedFindings: fixed > 0 ? fixed : (stage?.fixedFindings ?? 0),
          openFindings: open,
          phase: undefined,
          status: "active",
          targetFindingIds: undefined,
          totalFindings: stage?.totalFindings ?? (invalidatedFindings?.length ?? 0),
        }),
      };
      break;
    }
    case "round-started": {
      const stage = next.stages.find((item) => item.id === transition.stage);
      next = {
        ...next,
        currentStage: transition.stage,
        stages: updateStage(next, transition.stage, {
          phase: transition.role,
          ...(transition.role === "reviewer"
            ? {
                analysis: transition.analysis ?? (stage?.analysis ?? 0) + 1,
                fixAttempt: undefined,
              }
            : {
                analysis:
                  transition.analysis ??
                  (stage?.analysis && stage.analysis > 0
                    ? stage.analysis
                    : transition.round),
                fixAttempt:
                  transition.fixAttempt ??
                  (stage?.fixAttempt !== undefined ? stage.fixAttempt + 1 : 0),
              }),
          round: transition.round,
          status: "active",
          ...(transition.targetFindingIds !== undefined
            ? { targetFindingIds: transition.targetFindingIds }
            : transition.role !== "fixer"
              ? { targetFindingIds: undefined }
              : {}),
        }),
      };
      break;
    }
    case "fix-completed": {
      const stage = next.stages.find((item) => item.id === transition.stage);
      const fixAnalysis =
        transition.analysis ??
        (stage?.analysis && stage.analysis > 0
          ? stage.analysis
          : transition.round);
      const fixAttempt = transition.fixAttempt ?? stage?.fixAttempt ?? 0;
      const summary = transition.summary?.trim();
      const newRecord: FixRecord | undefined = summary
        ? { analysis: fixAnalysis, fixAttempt, summary }
        : undefined;
      next = {
        ...next,
        currentStage: transition.stage,
        stages: updateStage(next, transition.stage, {
          phase: "fixer",
          round: transition.round,
          status: "active",
          ...(summary
            ? {
                fixRecords: [
                  ...(stage?.fixRecords ?? []),
                  newRecord!,
                ],
                fixSummaries: [
                  ...(stage?.fixSummaries ?? []),
                  summary,
                ],
              }
            : {}),
          targetFindingIds: undefined,
        }),
      };
      break;
    }
    case "fix-blocked": {
      const stage = next.stages.find((item) => item.id === transition.stage);
      const isCoordinatorBlocker = (
        finding: PresentationFinding | Omit<PresentationFinding, "disposition">,
      ) =>
        (finding.id === "fixer-no-change" || finding.id === "fixer-policy-violation") &&
        finding.file === undefined &&
        finding.line === undefined &&
        finding.severity === "error";

      const priorFindings = (stage?.findings ?? []).filter((prev) => {
        if (
          prev.disposition === "open" &&
          isCoordinatorBlocker(prev) &&
          !transition.findings.some(
            (curr) => isCoordinatorBlocker(curr) && curr.id === prev.id,
          )
        ) {
          return false;
        }
        return true;
      });
      const findings = updateFindings(priorFindings, transition.findings, {
        inheritApproval: false,
      });
      const fixed = findings.filter((finding) => finding.disposition === "fixed").length;
      const approved = findings.filter(
        (finding) => finding.disposition === "approved",
      ).length;
      const open = findings.filter((finding) => finding.disposition === "open").length;
      next = {
        ...next,
        currentStage: transition.stage,
        stages: updateStage(next, transition.stage, {
          actionableFindings: open,
          approvedFindings: approved,
          findings,
          fixedFindings: fixed,
          openFindings: open,
          phase: "fixer",
          round: transition.round,
          status: "blocked",
          targetFindingIds: undefined,
          totalFindings: findings.length,
        }),
      };
      break;
    }
    case "findings-recorded":
      {
        const stage = next.stages.find((item) => item.id === transition.stage);
        const findings = transition.findings
          ? updateFindings(stage?.findings ?? [], transition.findings)
          : undefined;
        const analysisFindings = findings && stage?.findings
          ? { new: 0, stillOpen: 0, reopened: 0 }
          : undefined;
        if (analysisFindings) {
          // Reconciliation retains previous occurrence indices and appends new ones.
          findings!.forEach((finding, index) => {
            if (finding.disposition !== "open") return;
            const prior = stage?.findings?.[index];
            if (!prior) analysisFindings.new++;
            else if (prior.disposition === "fixed") analysisFindings.reopened++;
            else analysisFindings.stillOpen++;
          });
        }
        const fixed = findings?.filter((finding) => finding.disposition === "fixed").length;
        const approved = findings?.filter(
          (finding) => finding.disposition === "approved",
        ).length;
        const open = findings?.filter((finding) => finding.disposition === "open").length;
      next = {
        ...next,
        currentStage: transition.stage,
        stages: next.stages.map((item) =>
          item.id === transition.stage
            ? {
                ...item,
                actionableFindings: open ?? transition.actionable,
                analysisFindings,
                ...(transition.analysis !== undefined
                  ? { analysis: transition.analysis }
                  : {}),
                approvedFindings: approved,
                findings,
                fixedFindings: fixed,
                openFindings: open,
                retainedFixer: transition.retainedFixer,
                ...(transition.liveValidation ? {
                  liveValidation: transition.liveValidation,
                  evidenceCommitOid: transition.evidenceCommitOid,
                } : {}),
                round: transition.round,
                status: (open ?? transition.actionable) > 0 ? "blocked" : "active",
                targetFindingIds: undefined,
                totalFindings: findings?.length ?? transition.total,
              }
            : { ...item, retainedFixer: false },
        ),
      };
      }
      break;
    case "gate-opened":
      next = {
        ...next,
        gate: {
          gateKind: transition.gateKind,
          id: transition.gateId,
          options: transition.options,
          question: transition.question,
          round: transition.round,
          stage: transition.stage,
          state: "open",
        },
        stages: next.stages.map((item) =>
          item.id === transition.stage
            ? {
                ...item,
                retainedFixer: false,
                status: "blocked" as const,
                targetFindingIds: undefined,
              }
            : { ...item, retainedFixer: false },
        ),
      };
      break;
    case "gate-resolved":
      {
        const stage = next.stages.find((item) => item.id === transition.stage);
        const approved = next.gate?.gateKind === "guardrail"
          ? stage?.findings
          : ["approve", "skip"].includes(transition.decision)
          ? stage?.findings?.map((finding) =>
              finding.disposition === "open"
                ? { ...finding, disposition: "approved" as const }
                : finding,
            )
          : transition.decision === "fix" && transition.targetFindingIds
            ? updateSelectedFindings(
                stage?.findings ?? [],
                transition.targetFindingIds,
                "open",
                "approved",
              )
          : stage?.findings;
      next = {
        ...next,
        gate: {
          ...next.gate,
          decision: transition.decision,
          id: transition.gateId,
          state: "resolved",
        },
        stages: updateStage(next, transition.stage, {
          actionableFindings:
            approved?.filter((finding) => finding.disposition === "open").length ??
            stage?.actionableFindings,
          approvedFindings: approved?.filter(
            (finding) => finding.disposition === "approved",
          ).length,
          findings: approved,
          openFindings: approved?.filter(
            (finding) => finding.disposition === "open",
          ).length,
          ...(transition.targetFindingIds !== undefined
            ? { targetFindingIds: transition.targetFindingIds }
            : {}),
        }),
      };
      }
      break;
    case "stage-completed":
      next = {
        ...next,
        currentStage: undefined,
        gate: undefined,
        stages: updateStage(next, transition.stage, {
          round: transition.round,
          status: "passed",
          targetFindingIds: undefined,
        }),
      };
      break;
    case "error-recorded":
      next = {
        ...next,
        error: { resumable: transition.resumable },
        stages: next.stages.map((stage) => ({
          ...stage,
          retainedFixer: false,
          status:
            stage.id === next.currentStage
              ? ("failed" as const)
              : stage.status,
        })),
        status: "failed",
      };
      break;
    case "cancellation-recorded":
      next = {
        ...next,
        cancellation: { action: transition.action },
        stages: next.currentStage
          ? updateStage(next, next.currentStage, { status: "cancelled" })
          : next.stages,
        status: "cancelled",
      };
      break;
    case "run-completed":
      next = {
        ...next,
        stages: next.stages.map((stage) => ({
          ...stage,
          retainedFixer: false,
        })),
        status: transition.status,
      };
      break;
  }
  Object.freeze(next.mode);
  next.stages.forEach(Object.freeze);
  Object.freeze(next.stages);
  if (next.gate) Object.freeze(next.gate);
  if (next.error) Object.freeze(next.error);
  if (next.cancellation) Object.freeze(next.cancellation);
  return Object.freeze(next);
}

export class PresentationPublisher {
  #current: PresentationSnapshot;
  #fallbackRenderer?: () => PresentationRenderer;
  #renderer?: PresentationRenderer;
  #rendererFailed = false;
  readonly clock: () => Date;
  readonly onRendererError: (error: unknown) => void;
  readonly runId: string;
  readonly store: PresentationStore;

  constructor(
    store: PresentationStore,
    runId: string,
    renderer?: PresentationRenderer,
    clock: () => Date = () => new Date(),
    onRendererError: (error: unknown) => void = () => {},
    fallbackRenderer?: () => PresentationRenderer,
    stages: readonly StageName[] = PIPELINE_STEPS,
  ) {
    this.clock = clock;
    this.onRendererError = onRendererError;
    this.runId = runId;
    this.store = store;
    const snapshots = store.listPresentationSnapshots(runId);
    this.#current = snapshots.at(-1) ?? initialSnapshot(runId, stages);
    this.#fallbackRenderer = fallbackRenderer;
    this.#renderer = renderer;
    if (snapshots.length > 0 && renderer?.seed) {
      renderer.seed(snapshots);
    }
  }

  get current(): PresentationSnapshot {
    return this.#current;
  }

  nextAttempt(): number {
    return this.#current.attempt + 1;
  }

  #accept(snapshot: PresentationSnapshot): PresentationSnapshot {
    this.#current = snapshot;
    if (this.#renderer && !this.#rendererFailed) {
      try {
        this.#renderer.render(snapshot);
      } catch (error) {
        this.#rendererFailed = true;
        this.onRendererError(error);
        const fallback = this.#fallbackRenderer;
        this.#fallbackRenderer = undefined;
        if (fallback) {
          try {
            this.#renderer = fallback();
            this.#rendererFailed = false;
            const history = this.store.listPresentationSnapshots(this.runId);
            if (history.length > 0 && this.#renderer?.seed) {
              this.#renderer.seed(history);
            }
          } catch (fallbackError) {
            this.onRendererError(fallbackError);
          }
        }
      }
    }
    return snapshot;
  }

  publish(
    eventKey: string,
    transition: PresentationTransition,
    persist: (snapshot: PresentationSnapshot) => boolean | void = (snapshot) =>
      this.store.recordPresentationSnapshot(this.runId, eventKey, snapshot),
  ): PresentationSnapshot {
    const snapshot = nextSnapshot(
      this.#current,
      transition,
      this.clock().toISOString(),
    );
    if (persist(snapshot) === false) {
      return this.#current;
    }
    return this.#accept(snapshot);
  }

  async publishAsync<T>(
    transition: PresentationTransition,
    persist: (snapshot: PresentationSnapshot) => Promise<T>,
  ): Promise<T> {
    const snapshot = nextSnapshot(
      this.#current,
      transition,
      this.clock().toISOString(),
    );
    const result = await persist(snapshot);
    this.#accept(snapshot);
    return result;
  }
}

function safeToken(value: string): string {
  const normalized = redactKnownSecrets(
    stripVTControlCharacters(redactKnownSecrets(value)),
  )
    .replaceAll(/[^\x20-\x7e]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return redactKnownSecrets(normalized).slice(0, 120);
}

export class PlainStatusRenderer implements PresentationRenderer {
  #failed = false;
  readonly output: {
    on?(event: "error", listener: (error: Error) => void): unknown;
    write(chunk: string): unknown;
  };

  constructor(output: {
    on?(event: "error", listener: (error: Error) => void): unknown;
    write(chunk: string): unknown;
  }) {
    this.output = output;
    this.output.on?.("error", () => {
      this.#failed = true;
    });
  }

  render(snapshot: PresentationSnapshot): void {
    if (this.#failed) return;
    const event = snapshot.transition;
    const stageNumber = "stage" in event
      ? snapshot.stages.findIndex((item) => item.id === event.stage) + 1
      : 0;
    const prefix = `no-mistakes ${safeToken(snapshot.runId)}`;
    let line: string;
    switch (event.kind) {
      case "run-started":
        line = `${prefix} run started`;
        break;
      case "attempt-started":
        line = `${prefix} attempt ${event.attempt} started`;
        break;
      case "mode-changed":
        line = `${prefix} auto-fix ${event.enabled ? "on" : "off"}`;
        break;
      case "stage-started":
        line = `${prefix} stage ${stageNumber}/${snapshot.stages.length} ${event.stage} started`;
        break;
      case "stage-reopened":
        line = `${prefix} ${event.stage} reopened for a changed candidate`;
        break;
      case "round-started":
        {
          const stage = snapshot.stages.find((item) => item.id === event.stage);
          const analysis =
            (stage?.analysis ?? event.analysis ?? 0) > 0
              ? (stage?.analysis ?? event.analysis)!
              : event.round;
          line = event.role === "fixer"
            ? `${prefix} ${event.stage} fix ${analysis}${(stage?.fixAttempt ?? event.fixAttempt ?? 0) > 0 ? ` retry ${stage?.fixAttempt ?? event.fixAttempt}` : ""} started`
            : `${prefix} ${event.stage} analysis ${event.analysis ?? stage?.analysis ?? event.round + 1} started`;
        }
        break;
      case "fix-completed":
        {
          const stage = snapshot.stages.find((item) => item.id === event.stage);
          const analysis = stage?.analysis && stage.analysis > 0 ? stage.analysis : event.round;
          line = `${prefix} ${event.stage} fix ${analysis}${(stage?.fixAttempt ?? 0) > 0 ? ` retry ${stage?.fixAttempt}` : ""} completed applied=${event.findingIds.length} approved=${event.approvedFindings}`;
        }
        break;
      case "fix-blocked":
        {
          const stage = snapshot.stages.find((item) => item.id === event.stage);
          const analysis = stage?.analysis && stage.analysis > 0 ? stage.analysis : event.round;
          line = `${prefix} ${event.stage} fix ${analysis}${(stage?.fixAttempt ?? 0) > 0 ? ` retry ${stage?.fixAttempt}` : ""} blocked open=${event.actionable}`;
        }
        break;
      case "findings-recorded":
        {
          const stage = snapshot.stages.find((item) => item.id === event.stage);
          line = `${prefix} ${event.stage} round ${event.round} findings fixed=${stage?.fixedFindings ?? 0}/${stage?.totalFindings ?? event.total} approved=${stage?.approvedFindings ?? 0} open=${stage?.openFindings ?? event.actionable}`;
        }
        break;
      case "gate-opened":
        line = `${prefix} ${event.stage} round ${event.round} gate opened`;
        break;
      case "gate-resolved":
        line = `${prefix} ${event.stage} round ${event.round} gate resolved ${safeToken(event.decision)}`;
        break;
      case "stage-completed":
        line = `${prefix} stage ${stageNumber}/${snapshot.stages.length} ${event.stage} completed`;
        break;
      case "error-recorded":
        line = `${prefix} error${event.resumable ? " resumable" : ""}`;
        break;
      case "cancellation-recorded":
        line = `${prefix} cancellation ${event.action}`;
        break;
      case "run-completed":
        line = `${prefix} run ${event.status}`;
        break;
    }
    this.output.write(`${line}\n`);
  }
}
