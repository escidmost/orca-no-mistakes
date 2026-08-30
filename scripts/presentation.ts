import { PIPELINE_STEPS, type StageName } from "./config.ts";

export type PresentationStatus =
  | "in-progress"
  | "passed"
  | "failed"
  | "cancelled";

export type PresentationTransition =
  | { kind: "run-started" }
  | { attempt: number; kind: "attempt-started" }
  | { enabled: boolean; kind: "mode-changed" }
  | { kind: "stage-started"; stage: StageName }
  | { kind: "round-started"; round: number; stage: StageName }
  | {
      actionable: number;
      kind: "findings-recorded";
      round: number;
      stage: StageName;
      total: number;
    }
  | { gateId: string; kind: "gate-opened"; round: number; stage: StageName }
  | {
      decision: string;
      gateId: string;
      kind: "gate-resolved";
      round: number;
      stage: StageName;
    }
  | { kind: "stage-completed"; round: number; stage: StageName }
  | { kind: "error-recorded"; resumable: boolean }
  | {
      action: "cancel" | "gate-stop";
      kind: "cancellation-recorded";
    }
  | {
      kind: "run-completed";
      status: "passed" | "failed" | "cancelled";
    };

export type PresentationSnapshot = {
  attempt: number;
  cancellation?: { action: "cancel" | "gate-stop" };
  currentStage?: StageName;
  error?: { resumable: boolean };
  gate?: {
    decision?: string;
    id: string;
    state: "open" | "resolved";
  };
  mode: { autoFix: boolean };
  runId: string;
  sequence: number;
  stages: readonly {
    actionableFindings: number;
    id: StageName;
    round: number;
    status: "pending" | "active" | "blocked" | "passed" | "failed" | "cancelled";
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

function initialSnapshot(runId: string): PresentationSnapshot {
  return {
    attempt: 0,
    mode: { autoFix: true },
    runId,
    sequence: 0,
    stages: PIPELINE_STEPS.map((id) => ({
      actionableFindings: 0,
      id,
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
          status: stage.status === "passed" ? "passed" : "pending",
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
          round: transition.round,
          status: "active",
        }),
      };
      break;
    case "findings-recorded":
      next = {
        ...next,
        currentStage: transition.stage,
        stages: updateStage(next, transition.stage, {
          actionableFindings: transition.actionable,
          round: transition.round,
          status: transition.actionable > 0 ? "blocked" : "active",
          totalFindings: transition.total,
        }),
      };
      break;
    case "gate-opened":
      next = {
        ...next,
        gate: { id: transition.gateId, state: "open" },
        stages: updateStage(next, transition.stage, { status: "blocked" }),
      };
      break;
    case "gate-resolved":
      next = {
        ...next,
        gate: {
          decision: transition.decision,
          id: transition.gateId,
          state: "resolved",
        },
      };
      break;
    case "stage-completed":
      next = {
        ...next,
        currentStage: undefined,
        gate: undefined,
        stages: updateStage(next, transition.stage, {
          round: transition.round,
          status: "passed",
        }),
      };
      break;
    case "error-recorded":
      next = {
        ...next,
        error: { resumable: transition.resumable },
        stages: next.currentStage
          ? updateStage(next, next.currentStage, { status: "failed" })
          : next.stages,
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
      next = { ...next, status: transition.status };
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
  ) {
    this.clock = clock;
    this.onRendererError = onRendererError;
    this.runId = runId;
    this.store = store;
    const snapshots = store.listPresentationSnapshots(runId);
    this.#current = snapshots.at(-1) ?? initialSnapshot(runId);
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
  return value.replaceAll(/[^\p{L}\p{N}._:\/-]+/gu, " ").trim().slice(0, 120);
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
      ? PIPELINE_STEPS.indexOf(event.stage) + 1
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
        line = `${prefix} stage ${stageNumber}/${PIPELINE_STEPS.length} ${event.stage} started`;
        break;
      case "round-started":
        line = `${prefix} ${event.stage} round ${event.round} started`;
        break;
      case "findings-recorded":
        line = `${prefix} ${event.stage} round ${event.round} findings total=${event.total} actionable=${event.actionable}`;
        break;
      case "gate-opened":
        line = `${prefix} ${event.stage} round ${event.round} gate opened`;
        break;
      case "gate-resolved":
        line = `${prefix} ${event.stage} round ${event.round} gate resolved ${safeToken(event.decision)}`;
        break;
      case "stage-completed":
        line = `${prefix} stage ${stageNumber}/${PIPELINE_STEPS.length} ${event.stage} completed`;
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
