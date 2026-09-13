import assert from "node:assert/strict";
import test from "node:test";

import { resolvePipelineConfig } from "../scripts/config.ts";
import { trustedRepoPolicyConfig } from "../scripts/policy.ts";

const repoConfig = {
  ci: { no_ci: true, timeout_ms: 1000 },
  media_publication: { enabled: true, approved_sha256: ["a".repeat(64)] },
};

test("a local-config bypass cannot self-authorize media publication or skip CI", () => {
  const trusted = trustedRepoPolicyConfig(repoConfig, {
    effectivePolicyHash: "x",
    localBypass: true,
  });
  assert.equal(trusted.media_publication, undefined);
  assert.equal(trusted.ci?.no_ci, false);
  assert.equal(trusted.ci?.timeout_ms, 1000);

  const resolved = resolvePipelineConfig({ repoGlobalConfig: trusted });
  assert.equal(resolved.media_publication.enabled, false);
  assert.deepEqual(resolved.media_publication.approved_sha256, []);
  assert.equal(resolved.ci.no_ci, false);
});

test("trusted base policy keeps its own media approvals and no_ci", () => {
  const trusted = trustedRepoPolicyConfig(repoConfig, {
    effectivePolicyHash: "x",
    localBypass: false,
  });
  const resolved = resolvePipelineConfig({ repoGlobalConfig: trusted });
  assert.equal(resolved.media_publication.enabled, true);
  assert.deepEqual(resolved.media_publication.approved_sha256, ["a".repeat(64)]);
  assert.equal(resolved.ci.no_ci, true);
});

test("user-global media approvals survive a local-config bypass", () => {
  const trusted = trustedRepoPolicyConfig(repoConfig, {
    effectivePolicyHash: "x",
    localBypass: true,
  });
  const resolved = resolvePipelineConfig({
    repoGlobalConfig: trusted,
    userGlobalConfig: {
      media_publication: { enabled: true, approved_sha256: ["b".repeat(64)] },
    },
  });
  assert.equal(resolved.media_publication.enabled, true);
  assert.deepEqual(resolved.media_publication.approved_sha256, ["b".repeat(64)]);
});
