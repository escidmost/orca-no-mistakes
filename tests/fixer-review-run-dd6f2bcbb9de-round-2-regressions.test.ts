import assert from "node:assert/strict";
import test from "node:test";

import {
  PresentationPublisher,
  type PresentationSnapshot,
} from "../scripts/presentation.ts";

test("round-started clears targetFindingIds when transitioning from fixer to reviewer", () => {
  class MemoryStore {
    snapshots: PresentationSnapshot[] = [];
    listPresentationSnapshots(): PresentationSnapshot[] {
      return this.snapshots;
    }
    recordPresentationSnapshot(_runId: string, _key: string, snapshot: PresentationSnapshot): boolean {
      this.snapshots.push(snapshot);
      return true;
    }
  }

  const store = new MemoryStore();
  const publisher = new PresentationPublisher(
    store,
    "run_dd6f2bcbb9de",
    { render: () => {} },
    () => new Date(0),
  );

  publisher.publish("run-start", { kind: "run-started" });
  publisher.publish("review-start", { kind: "stage-started", stage: "review" });

  // Fixer round starts targeting specific findings
  publisher.publish("review-fixer", {
    kind: "round-started",
    role: "fixer",
    round: 1,
    stage: "review",
    targetFindingIds: ["finding-target-1", "finding-target-2"],
  });

  let reviewStage = publisher.current.stages.find((s) => s.id === "review");
  assert.equal(reviewStage?.phase, "fixer");
  assert.deepEqual(reviewStage?.targetFindingIds, ["finding-target-1", "finding-target-2"]);

  // Re-review starts with role: "reviewer" (omitting targetFindingIds)
  publisher.publish("review-re-review", {
    kind: "round-started",
    role: "reviewer",
    round: 1,
    stage: "review",
  });

  reviewStage = publisher.current.stages.find((s) => s.id === "review");
  assert.equal(reviewStage?.phase, "reviewer");
  assert.equal(
    reviewStage?.targetFindingIds,
    undefined,
    "targetFindingIds must be cleared at round-started boundary when role is reviewer",
  );
});
