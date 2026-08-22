import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseConfigYaml, type OrcaNoMistakesConfig } from "./config.ts";

export const POLICY_CONFIG_PATH = ".orca/no-mistakes.yaml";

export type PolicyProvenance = {
  baseRef?: string;
  baseRefSha?: string;
  effectivePolicyHash: string;
  localBypass: boolean;
};

export type PolicyGitSource = {
  resolveRefSha(ref: string): Promise<string | undefined>;
  showFile(ref: string, filePath: string): Promise<string | undefined>;
  /** Must return false only when absence is positively established; any
   *  inspection error must throw so a failed read never certifies an empty policy. */
  pathExists(ref: string, filePath: string): Promise<boolean>;
};

export function canonicalPolicyJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalPolicyJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalPolicyJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function effectivePolicyHash(config: unknown): string {
  return createHash("sha256").update(canonicalPolicyJson(config)).digest("hex");
}

export async function extractTrustedBaseConfig(
  git: PolicyGitSource,
  base: string,
): Promise<{ config: OrcaNoMistakesConfig; provenance: PolicyProvenance }> {
  const ref = `origin/${base}`;
  const sha = await git.resolveRefSha(ref);
  if (!sha) {
    throw new Error(
      `could not resolve trusted base ref ${ref}; fetch origin or pass --allow-local-config`,
    );
  }
  const contents = await git.showFile(ref, POLICY_CONFIG_PATH);
  if (
    contents === undefined &&
    (await git.pathExists(ref, POLICY_CONFIG_PATH))
  ) {
    throw new Error(`could not read ${POLICY_CONFIG_PATH} from ${ref}`);
  }
  const config = contents === undefined ? {} : parseConfigYaml(contents);
  return {
    config,
    provenance: {
      baseRef: ref,
      baseRefSha: sha,
      effectivePolicyHash: effectivePolicyHash(config),
      localBypass: false,
    },
  };
}

async function readPolicyFile(sourcePath: string): Promise<string | undefined> {
  try {
    return await readFile(sourcePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadLocalPolicyConfig(
  sourcePath: string,
): Promise<OrcaNoMistakesConfig> {
  const contents = await readPolicyFile(sourcePath);
  if (contents === undefined)
    throw new Error(`--config could not read ${sourcePath}: no such file`);
  return parseConfigYaml(contents);
}

export async function resolveRunPolicy(options: {
  allowLocalConfig?: boolean;
  base: string;
  configPath?: string;
  git: PolicyGitSource;
  repoRoot: string;
}): Promise<{ config: OrcaNoMistakesConfig; provenance: PolicyProvenance }> {
  // --allow-local-config / --config are development bypasses: the run is uncertified.
  if (!options.allowLocalConfig && !options.configPath) {
    return extractTrustedBaseConfig(options.git, options.base);
  }
  // Missing working-tree config under the bypass is an empty policy; an explicit --config path must exist.
  let config: OrcaNoMistakesConfig;
  if (options.configPath) {
    config = await loadLocalPolicyConfig(options.configPath);
  } else {
    const contents = await readPolicyFile(
      path.join(path.resolve(options.repoRoot), POLICY_CONFIG_PATH),
    );
    config = contents === undefined ? {} : parseConfigYaml(contents);
  }
  return {
    config,
    provenance: {
      effectivePolicyHash: effectivePolicyHash(config),
      localBypass: true,
    },
  };
}
