import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { freezeCoordinatorProgram } from "../scripts/orca-no-mistakes.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");

function installedPackageRoot(dependency: string): string {
  let dir = path.dirname(fileURLToPath(import.meta.resolve(dependency)));
  while (true) {
    const manifest = path.join(dir, "package.json");
    if (
      existsSync(manifest) &&
      (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === dependency
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`cannot locate installed dependency ${dependency}`);
    dir = parent;
  }
}

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
      cpSync(installedPackageRoot(dependency), vendored, {
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
      const staged = path.join(program, "node_modules", dependency);
      assert.ok(lstatSync(staged).isDirectory(), `${dependency} should be copied, not linked`);
      const manifest = JSON.parse(
        readFileSync(path.join(staged, "package.json"), "utf8"),
      ) as { name: string };
      assert.equal(manifest.name, dependency);
    }
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("freeze rebuilds a snapshot whose executable was removed", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "onm-stale-frozen-"));
  try {
    const evidenceDir = path.join(home, "run_stale");
    mkdirSync(evidenceDir, { recursive: true });
    const executable = freezeCoordinatorProgram(evidenceDir);
    rmSync(executable);
    assert.equal(freezeCoordinatorProgram(evidenceDir), executable);
    assert.ok(existsSync(executable));
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
