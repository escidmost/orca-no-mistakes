import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { StageLog } from "../scripts/ledger.ts";

test("fresh accounting precedes output and batches until close", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-accounting-baseline-"));
  const logPath = path.join(temp, "artifacts", "run", "review_r1.log");
  const probe = await open(path.join(temp, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as {
    writeFile: (...args: unknown[]) => Promise<void>;
  };
  const originalWriteFile = prototype.writeFile;
  const { promise: writeReleased, resolve: releaseWrite } =
    Promise.withResolvers<void>();
  const { promise: writeReached, resolve: reachedWrite } =
    Promise.withResolvers<void>();
  await probe.close();
  prototype.writeFile = async function (...args: unknown[]): Promise<void> {
    if (Buffer.isBuffer(args[0]) && args[0].equals(Buffer.from("first"))) {
      reachedWrite();
      await writeReleased;
    }
    await originalWriteFile.apply(this, args);
  };
  try {
    const log = new StageLog(logPath);
    const appending = log.append("first");
    await writeReached;
    const baseline = JSON.parse(await readFile(`${logPath}.meta`, "utf8"));
    assert.equal(baseline.fileBytes, 0);
    assert.equal(baseline.originalBytes, 0);
    assert.equal(typeof baseline.fileIdentity, "string");

    releaseWrite();
    await appending;
    await log.append("second");
    assert.deepEqual(
      JSON.parse(await readFile(`${logPath}.meta`, "utf8")),
      baseline,
    );
    await log.close();
    assert.deepEqual(JSON.parse(await readFile(`${logPath}.meta`, "utf8")), {
      ...baseline,
      fileBytes: 11,
      originalBytes: 11,
    });
  } finally {
    prototype.writeFile = originalWriteFile;
    releaseWrite();
    await rm(temp, { recursive: true, force: true });
  }
});
