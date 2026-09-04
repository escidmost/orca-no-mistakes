import { stripVTControlCharacters } from "node:util";

import { PIPELINE_STEPS, type StageName } from "./config.ts";
import { redactKnownSecrets } from "./ledger.ts";

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

export type PresentationTransition =
  | { kind: "run-started" }
  | { attempt: number; kind: "attempt-started" }
  | { enabled: boolean; kind: "mode-changed"; source?: "initial" | "operator" }
  | { kind: "stage-started"; stage: StageName }
  | {
      kind: "round-started";
      role?: "fixer" | "reviewer";
      round: number;
      stage: StageName;
      targetFindingIds?: readonly string[];
    }
  | {
      actionable: number;
      findings?: readonly Omit<PresentationFinding, "disposition">[];
      kind: "findings-recorded";
      retainedFixer?: boolean;
      round: number;
      stage: StageName;
      total: number;
    }
  | {
      gateId: string;
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

export type PresentationSnapshot = {
  attempt: number;
  cancellation?: { action: CancellationAction };
  currentStage?: StageName;
  error?: { resumable: boolean };
  gate?: {
    decision?: string;
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
    approvedFindings?: number;
    findings?: readonly PresentationFinding[];
    fixedFindings?: number;
    id: StageName;
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
      approvedFindings: 0,
      findings: [],
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

function updateFindings(
  previous: readonly PresentationFinding[],
  current: readonly Omit<PresentationFinding, "disposition">[],
): PresentationFinding[] {
  const pending = new Map<string, Omit<PresentationFinding, "disposition">[]>();
  for (const finding of current) {
    const queue = pending.get(finding.id);
    if (queue) queue.push(finding);
    else pending.set(finding.id, [finding]);
  }
  const next = previous.map((finding) => {
    const reported = pending.get(finding.id)?.shift();
    if (reported) {
      if (pending.get(finding.id)?.length === 0) pending.delete(finding.id);
      return { ...reported, disposition: "open" as const };
    }
    return finding.disposition === "open"
      ? { ...finding, disposition: "fixed" as const }
      : finding;
  });
  return [
    ...next,
    ...[...pending.values()].flat().map((finding) => ({
      ...finding,
      disposition: "open" as const,
    })),
  ];
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
          phase: stage.status === "passed" ? stage.phase : undefined,
          round: stage.status === "passed" ? stage.round : 0,
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
    case "round-started":
      next = {
        ...next,
        currentStage: transition.stage,
        stages: updateStage(next, transition.stage, {
          phase: transition.role,
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
    case "findings-recorded":
      {
        const stage = next.stages.find((item) => item.id === transition.stage);
        const findings = transition.findings
          ? updateFindings(stage?.findings ?? [], transition.findings)
          : undefined;
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
                approvedFindings: approved,
                findings,
                fixedFindings: fixed,
                openFindings: open,
                retainedFixer: transition.retainedFixer,
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
        const approved = ["approve", "skip"].includes(transition.decision)
          ? stage?.findings?.map((finding) =>
              finding.disposition === "open"
                ? { ...finding, disposition: "approved" as const }
                : finding,
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
      case "round-started":
        line = `${prefix} ${event.stage} round ${event.round} started`;
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
