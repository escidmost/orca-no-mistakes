# Test Organization

Keep test suites flat in `tests/` as `<domain>-<behavior>.test.ts`. Alphabetical
domain prefixes group related suites, for example `admission-`, `artifact-`,
`config-`, `gate-`, `ledger-`, `pipeline-`, `presentation-`, `publication-`,
`pull-request-`, `resume-`, `tui-`, and `worker-`. Existing descriptive core
filenames can stay.

Name suites for the behavior they cover, not a fixer/review run, run hash, or
review round. Use a short compound name for an existing mixed-topic suite rather
than a numerical suffix. Keep the current runner and relative import depths.

From the repository root:

```sh
npm test
npm run typecheck
node --test tests/publication-worker-identity.test.ts
```

`npm test` runs `node --test --test-concurrency=4 tests/*.test.ts`; `npm run typecheck` runs
`tsc --noEmit`. The last command is a focused-file example.

Organization-only changes must preserve coverage: do not delete tests, change
assertions or test logic, split or merge suites, or extract fixtures as part of
a naming cleanup.
