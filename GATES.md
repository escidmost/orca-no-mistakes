# Gates: ONM-80 Bind Pull Requests and Settle Remote Runs

OWNS: scripts/**, tests/**, docs/**, templates/config.yaml, GATES.md

Scope: New direct and gate runs execute and recover the complete Release 2 publication and pull-request flow with exact durable evidence.

- [x] G0: this ledger states outcome checks that can fail
  CHECK: node /Users/host/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/onm-80-bind-pull-requests-and-settle-remote-runs; path=891ea4e2ea56/12 entries; EXPECT=matched; output-sha256=6525bbd0bf4f2030c3cffeb6cb58862218dbb78b255b8a8596f680dca3c52136; output-bytes=302

- [x] G1: Release 2 pull-request publication and settlement behavior passes focused tests
  CHECK: node --test tests/github-authority.test.ts tests/candidate-publication.test.ts tests/pull-request-binding.test.ts tests/pull-request-route-facts.test.ts tests/pipeline-release-2-integration.test.ts tests/pipeline-completion-attestation.test.ts tests/presentation-plan-stages.test.ts tests/release-2-ledger-model.test.ts tests/fixer-review-1-3-resume-retry-regressions.test.ts tests/fixer-review-1-completion-base-and-diagnostic-round-regressions.test.ts tests/fixer-review-2-frozen-plan-and-fact-order-regressions.test.ts tests/fixer-review-2-pr-body-budget-and-comment-reconciliation-regressions.test.ts tests/fixer-review-3-comment-receipt-and-release2-approved-resume-regressions.test.ts tests/fixer-review-3-upstream-route-and-evidence-root-regressions.test.ts tests/fixer-review-4-clock-rollback-and-direct-run-route-regressions.test.ts tests/fixer-review-5-managed-comment-definite-failure-regressions.test.ts tests/fixer-review-5-pr-binding-resume-regression.test.ts tests/fixer-review-6-resolved-intent-terminal-fence-regressions.test.ts tests/fixer-review-child-lineage-and-resume-notification-regressions.test.ts tests/fixer-review-publication-route-and-forge-regressions.test.ts && node -e "console.log('release 2 focused verification passed')"
  EXPECT: release 2 focused verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/no-mistakes-gate-9b9340f3; path=891ea4e2ea56/12 entries; EXPECT=matched; output-sha256=ee51a00d98e50fa52520cad570ff313f6b463942cb69ec07fc939a53690a2d3d; output-bytes=12605

- [x] G2: the complete TypeScript project typechecks
  CHECK: npm run typecheck && node -e "console.log('typecheck verification passed')"
  EXPECT: typecheck verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/onm-80-bind-pull-requests-and-settle-remote-runs; path=891ea4e2ea56/12 entries; EXPECT=matched; output-sha256=a426ef3f522e707297d02b63c25b7b52e67838f7d7c8fe151ad013e82828b8a5; output-bytes=82

- [x] G3: the complete regression suite passes
  CHECK: npm test && node -e "console.log('full regression verification passed')"
  EXPECT: full regression verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/onm-80-bind-pull-requests-and-settle-remote-runs; path=891ea4e2ea56/12 entries; EXPECT=matched; output-sha256=b278dde3a717f0eaa5b0e8ce43566546f21d46e2ed024174a71ec1c9946b537f; output-bytes=130223

- [ ] G4: the pull request has the ONM-80 prefix and CodeRabbit reports no issues
  EVIDENCE: pending
