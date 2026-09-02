# Gates: ONM-80 Bind Pull Requests and Settle Remote Runs

OWNS: scripts/**, tests/**, docs/**, templates/config.yaml, GATES.md

Scope: New direct and gate runs execute and recover the complete Release 2 publication and pull-request flow with exact durable evidence.

- [x] G0: this ledger states outcome checks that can fail
  CHECK: node /Users/host/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/onm-80-bind-pull-requests-and-settle-remote-runs; path=891ea4e2ea56/12 entries; EXPECT=matched; output-sha256=6525bbd0bf4f2030c3cffeb6cb58862218dbb78b255b8a8596f680dca3c52136; output-bytes=302

- [x] G1: Release 2 pull-request publication and settlement behavior passes focused tests
  CHECK: node --test tests/github-authority.test.ts tests/candidate-publication.test.ts tests/pull-request-binding.test.ts tests/pull-request-route-facts.test.ts tests/pipeline-release-2-integration.test.ts tests/pipeline-completion-attestation.test.ts tests/presentation-plan-stages.test.ts tests/release-2-ledger-model.test.ts && node -e "console.log('release 2 focused verification passed')"
  EXPECT: release 2 focused verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/onm-80-bind-pull-requests-and-settle-remote-runs; path=891ea4e2ea56/12 entries; EXPECT=matched; output-sha256=011aa17167d359d7a694d608e936a307d0c9662e50dc0887158356a540afa9e3; output-bytes=8415

- [x] G2: the complete TypeScript project typechecks
  CHECK: npm run typecheck && node -e "console.log('typecheck verification passed')"
  EXPECT: typecheck verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/onm-80-bind-pull-requests-and-settle-remote-runs; path=891ea4e2ea56/12 entries; EXPECT=matched; output-sha256=a426ef3f522e707297d02b63c25b7b52e67838f7d7c8fe151ad013e82828b8a5; output-bytes=82

- [x] G3: the complete regression suite passes
  CHECK: npm test && node -e "console.log('full regression verification passed')"
  EXPECT: full regression verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/onm-80-bind-pull-requests-and-settle-remote-runs; path=891ea4e2ea56/12 entries; EXPECT=matched; output-sha256=12401cad9ad83f498072d9c58612ca39bd6222f38f101d95a8438e7035e36312; output-bytes=101992

- [ ] G4: the pull request has the ONM-80 prefix and CodeRabbit reports no issues
  EVIDENCE: pending
