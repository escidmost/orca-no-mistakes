import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { StageLog } from "../scripts/ledger.ts";

test("StageLog rejects stale accounting when birth time is unavailable", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-zero-birthtime-"));
  const logPath = path.join(temp, "artifacts", "run", "review_r1.log");
  const probe = await open(path.join(temp, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as {
    stat: (...args: unknown[]) => Promise<object>;
  };
  const originalStat = prototype.stat;
  await probe.close();
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, "replacement");
    const current = await stat(logPath, { bigint: true });
    await writeFile(
      `${logPath}.meta`,
      JSON.stringify({
        fileBytes: Number(current.size),
        fileIdentity: `${current.dev}:${current.ino}:0`,
        originalBytes: 5_000,
        originalBytesKnown: true,
      }),
    );
    prototype.stat = async function (...args: unknown[]): Promise<object> {
      const result = await originalStat.apply(this, args);
      if ((args[0] as { bigint?: boolean } | undefined)?.bigint !== true) {
        return result;
      }
      return { ...result, birthtimeNs: 0n };
    };

    const log = new StageLog(logPath, 2_048);
    await log.append("new".repeat(1_000));
    await log.close();

    assert.match(await readFile(logPath, "utf8"), /original bytes unknown/);
  } finally {
    prototype.stat = originalStat;
    await rm(temp, { recursive: true, force: true });
  }
});
