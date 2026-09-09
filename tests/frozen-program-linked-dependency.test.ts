import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("freeze copies dependencies linked from outside node_modules", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "onm-linked-dep-"));
  try {
    const checkout = path.join(home, "checkout");
    for (const entry of ["bin", "scripts", "package.json"]) {
      cpSync(path.join(repoRoot, entry), path.join(checkout, entry), {
        dereference: true,
        recursive: true,
      });
    }
    mkdirSync(path.join(checkout, "node_modules"));
    for (const dependency of ["yaml", "zod"]) {
      const vendored = path.join(home, "vendor", dependency);
      cpSync(path.join(repoRoot, "node_modules", dependency), vendored, {
        dereference: true,
        recursive: true,
      });
      symlinkSync(vendored, path.join(checkout, "node_modules", dependency));
    }
    const evidenceDir = path.join(home, "artifacts", "run_linked");
    const executable = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(path.join(checkout, "scripts", "orca-no-mistakes.ts"))});
process.stdout.write(m.freezeCoordinatorProgram(${JSON.stringify(evidenceDir)}));`,
      ],
      { encoding: "utf8", env: { ...process.env, ORCA_NO_MISTAKES_HOME: home } },
    );
    const program = path.dirname(path.dirname(executable));
    for (const dependency of ["yaml", "zod"]) {
      const manifest = JSON.parse(
        readFileSync(path.join(program, "node_modules", dependency, "package.json"), "utf8"),
      ) as { name: string };
      assert.equal(manifest.name, dependency);
    }
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
