import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const executable = path.join(root, "bin", "orca-no-mistakes");

async function submit(report: unknown, outsideArtifacts = false, link?: "home" | "artifacts" | "run" | "report") {
  const temp = await mkdtemp(path.join(tmpdir(), "onm-worker-report-"));
  const home = link === "home" ? path.join(temp, "linked-home") : temp;
  if (link === "home") await symlink(temp, home, "dir");
  const out = outsideArtifacts
    ? path.join(temp, "review.json")
    : path.join(home, "artifacts", "run", "review.json");
  await mkdir(path.dirname(out), { recursive: true });
  if (link === "artifacts" || link === "run") {
    const parent = link === "artifacts" ? path.join(home, "artifacts") : path.dirname(out);
    const target = path.join(temp, "relocated-evidence");
    await rename(parent, target);
    await symlink(target, parent, "dir");
  } else if (link === "report") {
    const target = path.join(temp, "outside.json");
    await writeFile(target, "unchanged");
    await symlink(target, out);
  }
  const child = spawn(
    executable,
    ["report", "--stage", "review", "--role", "reviewer", "--out", out],
    {
      cwd: root,
      env: { ...process.env, ORCA_NO_MISTAKES_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.stdin.end(JSON.stringify(report));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, out, stderr, stdout, temp };
}

test("worker report command rejects invalid enum values without writing a report", async () => {
  const result = await submit({
    findings: [{
      action: "fix",
      description: "Use the supported repair action.",
      id: "invalid-action",
      severity: "error",
    }],
    summary: "invalid action",
  });
  try {
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid fields: action/u);
    await assert.rejects(readFile(result.out), { code: "ENOENT" });
  } finally {
    await rm(result.temp, { force: true, recursive: true });
  }
});

test("worker report command validates and atomically writes accepted reports", async () => {
  const report = {
    findings: [{
      action: "auto-fix",
      description: "Use the supported repair action.",
      id: "valid-action",
      severity: "error",
    }],
    summary: "valid action",
  };
  const result = await submit(report);
  try {
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(result.out, "utf8")), report);
    assert.match(result.stdout, /"ok":true/u);
  } finally {
    await rm(result.temp, { force: true, recursive: true });
  }
});

test("worker report command rejects output outside its artifact root", async () => {
  const result = await submit({ findings: [], summary: "valid report" }, true);
  try {
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--out must be inside/u);
    await assert.rejects(readFile(result.out), { code: "ENOENT" });
  } finally {
    await rm(result.temp, { force: true, recursive: true });
  }
});

for (const link of ["home", "artifacts", "run", "report"] as const) {
  test(`worker report symlink boundary: ${link}`, async () => {
    const report = { findings: [], summary: "valid report" };
    const result = await submit(report, false, link);
    try {
      if (link === "home" || link === "artifacts") {
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(JSON.parse(await readFile(result.out, "utf8")), report);
      } else {
        assert.equal(result.code, 1);
        assert.match(result.stderr, /symlink/u);
        if (link === "report") assert.equal(await readFile(result.out, "utf8"), "unchanged");
        else await assert.rejects(readFile(result.out), { code: "ENOENT" });
      }
    } finally {
      await rm(result.temp, { force: true, recursive: true });
    }
  });
}
