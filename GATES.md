# Gates: ONM-80 Bind Pull Requests and Settle Remote Runs

OWNS: scripts/**, tests/**, docs/**, templates/config.yaml, GATES.md

Scope: New direct and gate runs execute and recover the complete Release 2 publication and pull-request flow with exact durable evidence.

- [ ] G0: this ledger states outcome checks that can fail
  CHECK: node /Users/host/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: Release 2 pull-request publication and settlement behavior passes focused tests
  CHECK: node --test tests/github-authority.test.ts tests/candidate-publication.test.ts tests/pull-request-binding.test.ts tests/pull-request-route-facts.test.ts tests/pipeline-release-2-integration.test.ts tests/pipeline-completion-attestation.test.ts tests/presentation-plan-stages.test.ts tests/release-2-ledger-model.test.ts tests/resume-interactive-retry-and-worker-drain.test.ts tests/pipeline-completion-base-and-diagnostic-settlement.test.ts tests/pipeline-publication-passed-outcome-journal.test.ts tests/resume-final-checkpoint-chain-and-approval.test.ts tests/ledger-fact-order-and-resume-frozen-plan.test.ts tests/pull-request-complete-report-and-body-budget.test.ts tests/pull-request-update-reconciliation-and-approved-resume.test.ts tests/pipeline-passed-settlement-marker-refresh-failure.test.ts tests/ledger-authoritative-evidence-and-pull-request-root.test.ts tests/admission-direct-run-route-prerequisite.test.ts tests/ledger-resume-pull-request-receipt-upgrade.test.ts tests/ledger-resolved-intent-migration-and-terminal-fence.test.ts tests/gate-child-lineage-and-resume-notification.test.ts tests/publication-route-snapshot-and-forge-neutral-init.test.ts tests/pull-request-binding-reconciliation-and-artifact-safety.test.ts tests/pull-request-resume-published-content.test.ts tests/pull-request-artifact-hardlinks-and-update-races.test.ts tests/pull-request-title-resume-and-checkpoint-snapshots.test.ts tests/pull-request-untrusted-html-containment.test.ts tests/pull-request-reverification-and-content-budget.test.ts && node -e "console.log('release 2 focused verification passed')"
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
