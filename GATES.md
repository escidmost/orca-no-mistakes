# Gates: ONM-96 CI stage

OWNS: scripts/**, tests/**, docs/**, templates/**, skills/**, README.md, CONTEXT.md

Scope: Add the `ci` pipeline stage after `pr`: pr settles on an open PR binding, ci monitors checks/mergeability/PR state on the exact candidate, gates on failures or idle timeout, and settles the merged binding; config `ci.no_ci` and `ci.timeout_ms`; docs, template, and tests updated.

- [x] G1: The project typechecks with the new stage, config keys, and GitHub checks query.
  CHECK: npx tsc --noEmit && echo TYPECHECK_OK
  EXPECT: TYPECHECK_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=aaed0436a8a134c9687fb7ec2d8648b83af36dff37a59b0255ed6f8a5e003cf7; exit=0; EXPECT=matched; output-sha256=0d31cf08e125020004c508c562e62037cd1809c414d62a869bc1452c072c96f0; output-bytes=13; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/add-CI-stage; path=b0f69926f468/40 entries

- [x] G2: The full test suite passes.
  CHECK: node --test tests/*.test.ts > /dev/null 2>&1 && echo TESTS_OK
  EXPECT: TESTS_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=bf918e317e7984e07650ae968e927badbc749bbb9842f05ba1ec1f95a2854e88; exit=0; EXPECT=matched; output-sha256=248df82524633f6943bc2136126941223c3efee4cea57b1b749c1b64f1230789; output-bytes=9; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/add-CI-stage; path=b0f69926f468/40 entries

- [x] G3: The Release 2 plan ends with push, pr, ci and the legacy plan is unchanged.
  CHECK: node --input-type=module -e "import { PIPELINE_STEPS } from './scripts/config.ts'; import { LEGACY_STAGE_PLAN } from './scripts/ledger.ts'; if (PIPELINE_STEPS.slice(-3).join(',') !== 'push,pr,ci' || PIPELINE_STEPS.length !== 9 || LEGACY_STAGE_PLAN.length !== 6) process.exit(1); console.log('PLAN_OK')"
  EXPECT: PLAN_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=6bed4eae7009457265a0355dc61ca8c44f116ac7fd6b477700b2cfbbe23c7cf8; exit=0; EXPECT=matched; output-sha256=36d259cae5105b07a0aca5241472d0166641bd8b682a8b69155c3993119c3ac3; output-bytes=8; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/add-CI-stage; path=b0f69926f468/40 entries

- [x] G4: A full pipeline run settles nine stages, records an open then merged pull-request binding, and its exported attestation verifies.
  CHECK: node --test --test-reporter=tap tests/pipeline-release-2-integration.test.ts 2>&1 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=/# fail (\d+)/.exec(s);if(!m||m[1]!=='0'||!/nine stages/.test(s))process.exit(1);console.log('INTEGRATION_OK')})"
  EXPECT: INTEGRATION_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=802ad5860a8f3bca333582ce783df09d3081f2131f7cc582ea97ba5e37b1beee; exit=0; EXPECT=matched; output-sha256=b2e443cf1574344fe8e89ee7a3b903d2d9f135c7f51a8bc53ba182814ff05abd; output-bytes=15; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/add-CI-stage; path=b0f69926f468/40 entries

- [x] G5: The ci stage gates on failing checks with fix/stop, resumes monitoring on fix, and settles when the PR merges; it errors when the PR closes unmerged; it gates on idle timeout; it treats an empty check set as passing only with trusted no_ci.
  CHECK: node --test --test-reporter=tap tests/ci-stage.test.ts 2>&1 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=/# pass (\d+)/.exec(s),f=/# fail (\d+)/.exec(s);if(!p||Number(p[1])<4||!f||f[1]!=='0')process.exit(1);console.log('CI_STAGE_OK')})"
  EXPECT: CI_STAGE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=b2f1a39c2bb99d8785c3fad75457e5087bb6efdca2d918563f0f3f05619de62d; exit=0; EXPECT=matched; output-sha256=0013506281287849863456dcd5ec54e7dffe438439c249f1b5c884fc42d005b4; output-bytes=12; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/add-CI-stage; path=b0f69926f468/40 entries

- [x] G6: The GitHub authority observes pull-request checks exhaustively with bucket mapping and rejects a missing node.
  CHECK: node --test --test-reporter=tap tests/github-authority.test.ts 2>&1 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const f=/# fail (\d+)/.exec(s);if(!f||f[1]!=='0'||!/checks/.test(s))process.exit(1);console.log('CHECKS_OK')})"
  EXPECT: CHECKS_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=7e7c122e415182f941e34ac908e555cfda9444a1378df0ef89a5ae094df8f137; exit=0; EXPECT=matched; output-sha256=37aff8c1c5c17aa0f46ff415f40d5efa6b7384ae5a3175e9de6fba40ceb60743; output-bytes=10; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/add-CI-stage; path=b0f69926f468/40 entries

- [x] G7: A v2 attestation whose plan ends with push, pr still verifies and one ending push, pr, ci verifies; any other tail is rejected.
  CHECK: node --test --test-reporter=tap tests/ledger-completion-evidence-and-remote-provenance.test.ts tests/pipeline-completion-attestation.test.ts 2>&1 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const f=/# fail (\d+)/.exec(s);if(!f||f[1]!=='0')process.exit(1);console.log('ATTEST_OK')})"
  EXPECT: ATTEST_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=52bc794031a4bab91ddad1f775c210a66d426bc522a640c1c9f167790eeb65f8; exit=0; EXPECT=matched; output-sha256=6de305b41683ea9bccbae353c89b0e604285f9bf913f549c8faed5a8f32312b5; output-bytes=10; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/add-CI-stage; path=b0f69926f468/40 entries

- [x] G8: Config accepts `ci.no_ci` and `ci.timeout_ms`, honors no_ci only from repository config, and the shipped template documents both keys.
  CHECK: node --input-type=module -e "import fs from 'node:fs'; import { parseConfig, resolvePipelineConfig, DEFAULT_CONFIG_TEMPLATE } from './scripts/config.ts'; const u = parseConfig({ ci: { no_ci: true, timeout_ms: 0 } }); const r = parseConfig({ ci: { no_ci: true } }); const a = resolvePipelineConfig({ userGlobalConfig: u }); const b = resolvePipelineConfig({ repoGlobalConfig: r }); const d = resolvePipelineConfig({}); const t = fs.readFileSync('templates/config.yaml','utf8'); if (a.ci.no_ci !== false || a.ci.timeout_ms !== 0 || b.ci.no_ci !== true || d.ci.timeout_ms !== 604800000 || d.ci.no_ci !== false || !t.includes('no_ci') || !t.includes('timeout_ms') || !DEFAULT_CONFIG_TEMPLATE.includes('no_ci')) process.exit(1); console.log('CONFIG_OK')"
  EXPECT: CONFIG_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=ef3a68d237df2b2cd9988ec48f9e9a41c8b84186a89d2e5bea0087274897bbf6; exit=0; EXPECT=matched; output-sha256=4d939306a112cc72aeb5596651d4e6a3e0af29b6c457f4ac9658fe803a472645; output-bytes=10; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/add-CI-stage; path=b0f69926f468/40 entries

- [x] G9: Documentation no longer claims CI orchestration is future work and describes the ci stage, and an ADR records the decision.
  CHECK: node -e "const fs=require('node:fs');const r=fs.readFileSync('README.md','utf8');const a=fs.readFileSync('docs/current-architecture.md','utf8');const c=fs.readFileSync('CONTEXT.md','utf8');const adr=fs.readdirSync('docs/adr').find(f=>/^0016-.*ci.*\.md$/i.test(f));if(/CI and delivery-proof orchestration remain future work/.test(r)||!/\x60ci\x60/.test(a)||!/CI monitoring/.test(c)||!adr)process.exit(1);console.log('DOCS_OK')"
  EXPECT: DOCS_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=6f1378a9c5f87aa526323c8365c2dffdecd14d9f087d3d5b07a6f12422659dec; exit=0; EXPECT=matched; output-sha256=6d36de704b81554dfb84505a4da24630d2ffb6dc40ba29dd836d0c858704f7bc; output-bytes=8; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/add-CI-stage; path=b0f69926f468/40 entries

- [x] G10: Ponytail review of the full diff found nothing left to cut, and the SKILL.md stage list names ci.
  EVIDENCE: manual; ponytail-review on 2026-09-06 found 5 cuts (inlined unresolved, dropped now? seam, dropped CiConfig export, joined manifest tail check, used input.supersedesEvidenceSha256 directly), all applied and G1-G9 reverified; skills/orca-no-mistakes/SKILL.md lists ci in the stage list and gate guidance
