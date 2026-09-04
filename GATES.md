# Gates: ONM-80 Bind Pull Requests and Settle Remote Runs

OWNS: scripts/**, tests/**, docs/**, templates/config.yaml, GATES.md

Scope: New direct and gate runs execute and recover the complete Release 2 publication and pull-request flow with exact durable evidence.

- [ ] G0: this ledger states outcome checks that can fail
  CHECK: node /Users/host/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: Release 2 pull-request publication and settlement behavior passes focused tests
  CHECK: node --test tests/github-authority.test.ts tests/candidate-publication.test.ts tests/pull-request-binding.test.ts tests/pull-request-route-facts.test.ts tests/pipeline-release-2-integration.test.ts tests/pipeline-completion-attestation.test.ts tests/presentation-plan-stages.test.ts tests/release-2-ledger-model.test.ts tests/fixer-review-1-3-resume-retry-regressions.test.ts tests/fixer-review-1-completion-base-and-diagnostic-round-regressions.test.ts tests/fixer-review-1-release-2-passed-outcome-regressions.test.ts tests/fixer-review-1-resume-checkpoint-chain-regressions.test.ts tests/fixer-review-2-frozen-plan-and-fact-order-regressions.test.ts tests/fixer-review-2-pr-body-budget-and-comment-reconciliation-regressions.test.ts tests/fixer-review-3-comment-receipt-and-release2-approved-resume-regressions.test.ts tests/fixer-review-3-passed-marker-refresh-after-custody-regression.test.ts tests/fixer-review-3-upstream-route-and-evidence-root-regressions.test.ts tests/fixer-review-4-clock-rollback-and-direct-run-route-regressions.test.ts tests/fixer-review-5-pr-binding-resume-regression.test.ts tests/fixer-review-6-resolved-intent-terminal-fence-regressions.test.ts tests/fixer-review-child-lineage-and-resume-notification-regressions.test.ts tests/fixer-review-publication-route-and-forge-regressions.test.ts tests/fixer-review-1-pull-request-binding-regressions.test.ts tests/fixer-review-1-pr-resume-content-regressions.test.ts tests/fixer-review-2-hardlink-and-draft-race-regressions.test.ts tests/fixer-review-3-pr-resume-and-presentation-regressions.test.ts tests/fixer-review-4-pr-body-untrusted-html-comment-regression.test.ts tests/fixer-review-1-publication-reverification-and-budget-regressions.test.ts && node -e "console.log('release 2 focused verification passed')"
  EXPECT: release 2 focused verification passed
  EVIDENCE: pending

- [ ] G2: the complete TypeScript project typechecks
  CHECK: npm run typecheck && node -e "console.log('typecheck verification passed')"
  EXPECT: typecheck verification passed
  EVIDENCE: pending

- [ ] G3: the complete regression suite passes
  CHECK: npm test && node -e "console.log('full regression verification passed')"
  EXPECT: full regression verification passed
  EVIDENCE: pending

- [ ] G4: the pull request has the ONM-80 prefix and CodeRabbit reports no issues
  EVIDENCE: pending
