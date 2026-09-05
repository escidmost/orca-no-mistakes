# Gates: ONM-79 Release 2 acceptance

OWNS: GATES.md, .gitignore, scripts/acceptance/**, scripts/orca-no-mistakes.ts, tests/**, .github/workflows/**, README.md, docs/**, templates/config.yaml

Scope: Prove the agreed Release 2 contract through deterministic macOS/Linux acceptance and a protected live upstream/fork workflow, with retained evidence and operator documentation. Release completion requires all gates below.

- [x] G1: Acceptance scenarios agree with the accepted Release 2 contract
  EVIDENCE: User confirmed updated standards on 2026-09-05: current ADR-0010 owned title/body and matching MERGED settlement govern acceptance. Full CI/delivery proof remains withheld.

- [x] G2: The complete deterministic regression suite passes, including same-repository/fork pipeline completion, publication failure/resume and exact attestation export/verification
  CHECK: node scripts/acceptance/local.ts
  EXPECT: LOCAL ACCEPTANCE PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=a79f9a5a8942f2275da755c275892792599f3b9dc2351d087bf8e2961cbfa8ee; exit=0; EXPECT=matched; output-sha256=45c5c5bd927f062f2c81b80ef9d88b13285d78f4c99f58ebc6dcf33c96d9cbae; output-bytes=162; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/onm-79-prove-and-document-release-2-end-to-end; path=22fbc48c8e9e/40 entries

- [x] G3: The complete local acceptance matrix passes on macOS and Linux with retained logs and source identity
  CHECK: node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync,readdirSync} from "node:fs"; import {createHash} from "node:crypto"; const dirs=["acceptance-results/"+readdirSync("acceptance-results").filter(d=>d.startsWith("local-")).sort().at(-1),"acceptance-results/linux-fixture/result-final"]; const reports=dirs.map(d=>JSON.parse(readFileSync(d+"/result.json"))); assert.deepEqual(reports.map(r=>r.platform),["darwin","linux"]); assert.deepEqual(reports[0].source.files,reports[1].source.files); assert.equal(reports[0].source.commit,reports[1].source.commit); assert.deepEqual(reports[0].tests,reports[1].tests); for(const [file,hash] of Object.entries(reports[0].source.files)) assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"),hash,file); reports.forEach((r,i)=>{assert.equal(r.status,"passed"); assert.equal(r.exitCode,0); assert.notEqual(r.userId,0); const tap=readFileSync(dirs[i]+"/tests.tap","utf8"); assert.match(tap,/# tests 974\n/); assert.match(tap,/# pass 974\n/); assert.match(tap,/# fail 0\n/); assert.match(tap,/# cancelled 0\n/); assert.match(tap,/# skipped 0\n/)}); console.log("MACOS AND LINUX EVIDENCE VERIFIED")'
  EXPECT: MACOS AND LINUX EVIDENCE VERIFIED
  EVIDENCE: automatic-evidence=v1; definition-sha256=fff1a7bd20c1b58044c0755a22d603e42da5256c899550e8511d5fde9da8d8ee; exit=0; EXPECT=matched; output-sha256=be825cf4e82d9c115066962f3e9584d4c50ef62666673e467e8a5bfa8422a27c; output-bytes=34; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/onm-79-prove-and-document-release-2-end-to-end; path=22fbc48c8e9e/40 entries

- [ ] G4: A protected manual workflow uses real Orca, the installed gate, real Git and GitHub transport with dedicated upstream/fork repositories and unique per-run branches
  EVIDENCE: pending; fixture repositories and protected runner environment requested.

- [ ] G5: One live same-repository and fork acceptance run passes and exports fixture identities, run IDs, candidate OIDs, receipts, completion root, attempt outcomes, custody and cleanup results
  EVIDENCE: pending

- [ ] G6: Successful live fixtures are cleaned and failed fixture identities are retained and reported
  EVIDENCE: pending

- [x] G7: Operator documentation covers initialization, same-repository/fork credentials, live acceptance, partial effects, explicit failed-run resume, migration, pruning and the agreed Release 2 limitations
  EVIDENCE: Reviewed docs/release-2-acceptance.md against current README, CLI and ADR-0010. Initialization, credentials, current PR/merge contract, explicit failed resume, migration, custody/pruning and withheld later-release guarantees are covered; README/architecture link the runbook, CLI states boundaries, accepted ADR metadata records live proof pending. No configuration options added.

- [x] G8: TypeScript, workflow syntax and whitespace checks pass
  CHECK: npm run typecheck && actionlint .github/workflows/release-2-local.yml && git diff --check && node -e "console.log('STATIC CHECKS PASSED')"
  EXPECT: STATIC CHECKS PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=f4f0f25c84363378f3251d6ad376677146cd29b564dd1ac668a651cc06c77eeb; exit=0; EXPECT=matched; output-sha256=224db693f1bb7876bdb46f36baa5d8a483720fafee058d58528a38e85e42b9f8; output-bytes=73; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/onm-79-prove-and-document-release-2-end-to-end; path=22fbc48c8e9e/40 entries

- [ ] G9: Scenario coverage is reconciled against every updated issue requirement and the final complexity review has no unresolved findings
  EVIDENCE: Incomplete: the real live workflow and end-to-end live scenarios still need implementation/proof. Added a real Git receive/quarantine promotion control and simultaneous cross-process competing/replayed admission controls; these retain a controlled coordinator boundary. Reviewed changed runner, workflow, integration fixtures and timestamp positive control under ponytail-review; no production accounting guard or assertion was weakened. The Linux root-run failure is retained, and passing reruns use an unprivileged user and explicit UTF-8 locale.

Gate authoring note: this initial outcome inventory is not execution evidence. Runnable definitions replace pending manual entries once the acceptance commands exist; no release-completion claim may rely on this inventory alone.
