import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../scripts/orca-no-mistakes.ts";

test("stranded prune suppresses only a missing marker directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "onm-marker-read-"));
  const previousHome = process.env.ORCA_NO_MISTAKES_HOME;
  process.env.ORCA_NO_MISTAKES_HOME = path.join(root, "home");
  try {
    await main(["prune", "--stranded", "--repo", root]);

    await mkdir(path.join(root, ".orca"));
    await writeFile(path.join(root, ".orca", "no-mistakes"), "not a directory");
    await assert.rejects(
      main(["prune", "--stranded", "--repo", root]),
      { code: "ENOTDIR" },
    );
  } finally {
    if (previousHome === undefined) delete process.env.ORCA_NO_MISTAKES_HOME;
    else process.env.ORCA_NO_MISTAKES_HOME = previousHome;
    await rm(root, { force: true, recursive: true });
  }
});
