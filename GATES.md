# Gates: ONM-93 TUI usability

OWNS: scripts/tui.ts, tests/**, docs/**, README.md, GATES.md

Scope: Independent finding decisions in the Run TUI, verified locally and delivered through Orca No-Mistakes and CodeRabbit.

- [x] G1: Operators can choose Fix or Approve for individual open findings and submit one canonical decision
  CHECK: node --test tests/tui*.test.ts > /tmp/onm-93-tui-tests.log 2>&1 && node -e "console.log('finding decision verification passed')"
  EXPECT: finding decision verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4312f84241634c6191eb4680e120162a23a3adca5b74d94837fcb36625669bd7; exit=0; EXPECT=matched; output-sha256=dc99c141b449f5c46adfd50764161065df700004f5f094eb5375350b2d7243d6; output-bytes=37; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/onm-93-tui-usability; path=22fbc48c8e9e/40 entries

- [x] G2: TypeScript project typechecks
  CHECK: npm run typecheck && node -e "console.log('typecheck verification passed')"
  EXPECT: typecheck verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=3bc48c288b10f22ca8a5117c21b0ea5718b83c8f6bc62922cb9d78fa89608faf; exit=0; EXPECT=matched; output-sha256=a426ef3f522e707297d02b63c25b7b52e67838f7d7c8fe151ad013e82828b8a5; output-bytes=82; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/onm-93-tui-usability; path=22fbc48c8e9e/40 entries

- [x] G3: Full regression suite passes
  CHECK: npm test > /tmp/onm-93-full-tests.log 2>&1 && node -e "console.log('full regression verification passed')"
  EXPECT: full regression verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=86326e2dc2848d8458a8f4ab0295e5c75b8a0041b56b99a24edd5868e450d2af; exit=0; EXPECT=matched; output-sha256=b3312093ec9eb7690d53672c0c92fafa73b4ce510f418d483bedf27ca5600b14; output-bytes=36; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/onm-93-tui-usability; path=22fbc48c8e9e/40 entries

- [x] G4: Local changes pass available whitespace and ledger lint checks
  CHECK: git diff --check && node /Users/host/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=559f4bf13c5614172139732e5975431e9d1588da6499be1cdaf4fc95f9649d53; exit=0; EXPECT=matched; output-sha256=68079f8fc1098b623ff7e741fa0e7a108cb392e737bc65ecccfeaea7c392f379; output-bytes=569; shell=/bin/sh; cwd=/Users/host/repo/orca-no-mistakes/.orca/workspaces/onm-93-tui-usability; path=22fbc48c8e9e/40 entries

Complexity review: shared finding rendering replaces duplication; canonical selective-fix protocol is reused. No dependencies or configuration added. No configured code linter exists in package.json or repository configuration.

- [ ] G5: Exactly one local CodeRabbit review is assessed and valid findings are fixed and tested
  EVIDENCE: pending

- [ ] G6: Worktree-local Orca No-Mistakes gate delivers the committed changes and creates the PR
  EVIDENCE: pending

- [ ] G7: PR title starts with ONM-93 and remote CodeRabbit review reports no issues after one request per cycle
  EVIDENCE: pending
