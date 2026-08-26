import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DomainLedger } from "../scripts/ledger.ts";
import {
  CliOrca,
  runPipeline,
  type GitOperations,
  type OrcaOperations,
} from "../scripts/orca-no-mistakes.ts";

test("gate audit is durable before detached notification", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "orca-gate-audit-order-"));
  const ledgerPath = path.join(temp, "ledger.db");
  const markerPath = path.join(temp, "notification-audit.json");
  const fakeOrca = path.join(temp, "orca");
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  const previousHandle = process.env.ORCA_TERMINAL_HANDLE;
  const previousLedger = process.env.TEST_GATE_LEDGER;
  const previousMarker = process.env.TEST_GATE_MARKER;
  process.env.ORCA_NO_MISTAKES_HOME = temp;
  process.env.ORCA_TERMINAL_HANDLE = "coordinator";
  process.env.TEST_GATE_LEDGER = ledgerPath;
  process.env.TEST_GATE_MARKER = markerPath;
  const ledger = new DomainLedger(ledgerPath);
  try {
    await writeFile(
      fakeOrca,
      `#!/usr/bin/env node
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
const args = process.argv.slice(2)
let result = { ok: true }
if (args[1] === 'run-create') result = { run: { id: 'gate-audit-run' } }
if (args[1] === 'gate-create') result = { gate: { id: 'gate-review' } }
if (args[0] === 'orchestration' && args[1] === 'send') {
  const db = new DatabaseSync(process.env.TEST_GATE_LEDGER)
  const row = db.prepare('SELECT gate_kind, decision FROM gate_audit WHERE gate_id = ?').get('gate-review')
  db.close()
  fs.writeFileSync(process.env.TEST_GATE_MARKER, JSON.stringify(row ?? null))
}
console.log(JSON.stringify({ result }))
`,
    );
    await chmod(fakeOrca, 0o755);

    const cli = new CliOrca({
      command: fakeOrca,
      cwd: temp,
      notifyHandle: "originating-terminal",
    });
    let task = 0;
    const orca: OrcaOperations = {
      createRun: (objective) => cli.createRun(objective),
      async createTask() {
        return `task-${++task}`;
      },
      async startWorker(taskId, launch) {
        return {
          dispatchId: `dispatch-${launch.stage}`,
          report: { findings: [], summary: launch.stage },
          taskId,
        };
      },
      async finishWorker() {},
      async removeWorktree() {},
      async completeTask() {},
      createGate: (taskId, question, options, onCreated) =>
        cli.createGate(taskId, question, options, onCreated),
      async waitForGate() {
        return "stop";
      },
      async setWorktreeStatus() {},
    };
    const oid = "a".repeat(40);
    const git: GitOperations = {
      async assertReady() {
        return {
          base: "main",
          baseOid: oid,
          branch: "feature",
          head: oid,
          root: temp,
        };
      },
      async assertClean() {},
      async assertFixerChangesAllowed() {},
      async head() {
        return oid;
      },
      async diffBase() {
        return "";
      },
      async rebase() {
        return {
          findings: [
            {
              action: "auto-fix",
              description: "conflict",
              id: "rebase-conflict",
              severity: "error",
            },
          ],
          summary: "rebase conflict",
        };
      },
      async resolveRefSha() {
        return undefined;
      },
      async showFile() {
        return undefined;
      },
      async pathExists() {
        return false;
      },
      async policySha256() {
        return "b".repeat(64);
      },
      async resolveBaseOid() {
        return oid;
      },
      async applyWorktreeCommits() {
        return false;
      },
      async headOf() {
        return oid;
      },
      async worktreeIsReusable() {
        return false;
      },
      async anchorRecoveryRef() {},
    };

    await assert.rejects(
      runPipeline(
        {
          allowLocalConfig: true,
          intent: "Record an exhausted gate before notification.",
          maxFixRounds: 0,
        },
        orca,
        git,
        ledger,
      ),
      /gate stopped the pipeline/,
    );
    assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), {
      decision: "pending",
      gate_kind: "exhaustion",
    });
  } finally {
    ledger.close();
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    if (previousHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = previousHandle;
    if (previousLedger === undefined) delete process.env.TEST_GATE_LEDGER;
    else process.env.TEST_GATE_LEDGER = previousLedger;
    if (previousMarker === undefined) delete process.env.TEST_GATE_MARKER;
    else process.env.TEST_GATE_MARKER = previousMarker;
    await rm(temp, { recursive: true, force: true });
  }
});
