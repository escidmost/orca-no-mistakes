# Release 2 acceptance

Release 2 acceptance is **not complete**. A local test run is not proof of real Orca or GitHub behavior. Completion requires passing macOS and Linux local results plus a clean protected live run against dedicated persistent GitHub.com upstream and fork repositories.

The current contract is ADR-0010: the pipeline owns the PR title and body, not a managed comment, and remains active until an authoritative matching `MERGED` observation. That wording described Release 2 as proven on 2026-09-05; ONM-96 afterwards split the merge wait into a ninth `ci` stage that settles `pr` on an open binding and monitors CI checks and mergeability until merge (ADR-0016). Human comments, labels, reviewers and other fields are outside that report ownership. ONM-79's original managed-comment/no-merge wording has been superseded. Observing a merged PR does not prove CI completeness, non-bypass merge, or delivered-tree integrity.

## Local matrix

Requires Node 24+, npm and Git, running as an unprivileged user (the suite exercises permission denial). From the package checkout:

```sh
npm ci
npm run typecheck
node scripts/acceptance/local.ts
```

The runner sets an explicit UTF-8 locale for terminal rendering tests and records it with the user ID. The runner executes every `tests/*.test.ts` file with Node's test runner and four concurrent test processes. It creates a fresh directory under `acceptance-results/` containing `tests.tap` and `result.json`. An existing output directory is refused. A failure returns a nonzero exit code and retains the log. An interrupted runner can leave `status: running`; that is not successful evidence. The result records OS, architecture, Node/Git versions, commit, tracked diff digest and TypeScript source/test hashes, including untracked TypeScript files. Retain both files together.

The `Release 2 local acceptance` workflow runs this same command on macOS and Linux with Node 24 and retains each platform's artifact even after test failure. A workflow definition alone does not prove either platform passed. The local runner uses controlled Orca/provider implementations and local bare Git repositories; it does not use real GitHub credentials or certify a live Orca installation.

Coverage entry points (the runner includes all regression files, not just this list):

| Requirement | Evidence entry point |
| --- | --- |
| Installed gate rejects unsafe admission | `tests/local-gate.test.ts` exercises the real pre-receive hook and malformed/ref-shape rejection |
| Quarantine environment isolation and exact accepted OID | `tests/receive-quarantine-and-concurrent-admission.test.ts` exercises a real receive, quarantine-only visibility, promotion and anchoring with a controlled coordinator; `tests/admission-boundary.test.ts` checks detached environment removal and supersession |
| Replay and competing submissions | `tests/receive-quarantine-and-concurrent-admission.test.ts` synchronizes independent processes before competing/replayed acquisition; `tests/submission-admission.test.ts`, `tests/admission-default-branch-and-replay.test.ts` cover other replay states |
| Same-repository/fork exact publication and CAS races | `tests/candidate-publication.test.ts` uses real local Git transport; stale creation/movement/deletion must preserve the competitor |
| PR ambiguity, owned report and matching merge settlement | `tests/pull-request-binding.test.ts`, `tests/pull-request-binding-reconciliation-and-artifact-safety.test.ts` |
| Publication failure, explicit resume and no duplicate push/PR | `tests/pipeline-release-2-integration.test.ts` runs same-repository and fork routes, counts mutations and exports/verifies completion evidence |
| Migration interruption and retry | `tests/ledger-migration-cleanup-and-repository-resolution.test.ts` injects failure between destination commit and source cleanup; `tests/ledger-concurrent-migration-and-completion-retry.test.ts` opens concurrently |
| v1.3 and v2 evidence, offline and retained verification | `tests/pipeline-completion-attestation.test.ts`, `tests/repository-ledger-migration.test.ts` |
| Custody divergence, cancellation and stranded cleanup | `tests/orca-no-mistakes.test.ts`, `tests/abort-reap.test.ts`, `tests/resume-generation-custody-pruning.test.ts` |

These entry points identify assertions to inspect; test names are not substitutes for results. The real receive test controls the coordinator entrypoint and invokes production admission primitives; it does not certify real Orca launch. Concurrent admission tests synchronize four processes against the same SQLite ledger; they do not simulate simultaneous full pipelines. The live acceptance record must state precisely which boundary it exercised.

## Recorded local result

On 2026-09-05, all 974 tests passed on macOS (Node 26.8.1) and in an unprivileged Linux container (Node 24.20.0) against matching TypeScript source/test hashes. Retained local evidence is `acceptance-results/local-1788645661523/` and `acceptance-results/linux-fixture/result-final/`; GATES.md verifies both reports against the current hashed files. These ignored evidence directories must be retained separately from a Git commit. This is local platform evidence, not an executed hosted Actions matrix or a live acceptance pass.

The initial root/locale-misconfigured Linux failure remains in `acceptance-results/linux-fixture/result/`. Permission-denial tests require an unprivileged user. Exact log-accounting controls establish distinct birth/change timestamps; the zero-birthtime regression still requires unknown accounting.

## Live fixture prerequisites

Use two dedicated persistent fixture repositories in one GitHub.com fork network. Never use a product repository as the mutation fixture. The upstream needs a committed default branch and trusted validation policy; the fork must permit the authenticated actor to publish a feature branch. Configure an environment with required reviewers, restricted deployment branches and dedicated credentials before enabling a manual live workflow. Merely naming an Actions environment does not protect it.

The runner must have a running Orca app, the package checkout installed, Node 24+, Git, authenticated worker agents, `gh` and `gh-axi`. `GithubAuthority.connect` prefers `gh-axi` when its supported API transport is available, otherwise uses `gh`; record the selected transport. Git push authentication must also work independently of API authentication. Use a fixture-scoped token with content and pull-request write access to both repositories; store it as an environment secret, never in evidence or repository files.

Use a distinct namespace such as `onm-79/<workflow-run-id>-<attempt>/` for every run, including base branches where fixture merges must not alter the persistent default branch. Record upstream/fork stable repository IDs, namespace and exact initial branch OIDs before mutation. The live workflow and fixture identities remain outstanding until provisioned and exercised; no live passing result is recorded by this document.

## Operator sequence

Install from the exact package checkout being accepted. Keep its source identity with the evidence. Before initializing, create a per-run base branch in the upstream fixture for each scenario from the recorded default-branch OID and record each base branch name and OID with the evidence. Without an explicit `--base-branch`, `init` persists the upstream default branch as the publication base, so the fixture merge below would mutate the persistent default branch:

```sh
git -C /path/to/same-repository-checkout push origin "$default_oid:refs/heads/onm-79/run/base-same"
git -C /path/to/fork-checkout push upstream "$default_oid:refs/heads/onm-79/run/base-fork"
```

Check out the exact clean committed feature branch each example submits before initializing: `onm-79/run/same` in the same-repository checkout and `onm-79/run/fork` in the fork checkout. Without `--head-branch`, `init` persists the currently checked-out branch as the head route, gate admission requires a checked-out worktree on exactly the submitted ref and candidate, and direct `run` submits the checked-out branch rather than the init override. An arbitrarily named feature branch therefore fails admission or route matching. Then initialize each checkout against its recorded base branch:

```sh
git -C /path/to/same-repository-checkout switch -c onm-79/run/same
git -C /path/to/fork-checkout switch -c onm-79/run/fork
/path/to/package/bin/orca-no-mistakes init --repo /path/to/same-repository-checkout --base-branch onm-79/run/base-same
/path/to/package/bin/orca-no-mistakes init --repo /path/to/fork-checkout --upstream upstream/fixture --fork contributor/fixture --base-branch onm-79/run/base-fork --head-branch onm-79/run/fork
```

Before submitting, verify that the persisted route's base branch matches the recorded per-run base branch and that its head branch equals the branch currently checked out in that checkout (`git branch --show-current`): `onm-79/run/same` and `onm-79/run/fork` respectively.

The same-repository installed-gate scenario is **blocked pending isolated-base gate support**. The gate launches the admitted pipeline without `--base`, so the run detects `origin/HEAD` (or `main`/`master`) as its base, does not match the persisted isolated-base route, and fails closed before publication. Do not work around this by initializing against the persistent default branch; that would let the fixture merge mutate it and lose fixture isolation. Once the gate can pass the persisted base through to the run, the intended submission is:

```sh
intent=$(node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64url"))' 'ONM-79: accept same-repository publication')
git -C /path/to/same-repository-checkout push --push-option="no-mistakes.intent=$intent" orca-no-mistakes HEAD:refs/heads/onm-79/run/same
```

Submit the fork fixture through direct ingress with an explicit `--base`. A local fetch of the upstream base is not sufficient: trusted policy reads its configuration from `origin/<base>`, and the rebase stage fetches `<base>` from `origin`, and the fork checkout's `origin` is the fork. The isolated base branch must therefore also exist on the fork at the recorded upstream OID and be fetched into the fork's remote-tracking ref:

```sh
git -C /path/to/fork-checkout push origin "$default_oid:refs/heads/onm-79/run/base-fork"
git -C /path/to/fork-checkout fetch origin onm-79/run/base-fork
/path/to/package/bin/orca-no-mistakes run --repo /path/to/fork-checkout --base onm-79/run/base-fork --intent 'ONM-79: accept fork publication'
```

Confirm that `origin/onm-79/run/base-fork` and upstream `onm-79/run/base-fork` both equal the recorded base OID before running, and record the fork-side base branch as a fixture identity so cleanup accounts for it. Omitting `--base` selects the default branch, which does not match the stored isolated-base route and fails closed. Do not pass `--allow-local-config` to bypass trusted policy.

Retain the returned admission/run identity. Detached runs return immediately; handle their notifications and decisions through Orca. Do not infer completion from command return, PR creation or readiness notification. Verify the exact base/head repositories, branches and candidate OID on the created PR. Exercise a later candidate against that same still-open PR, checking PR identity reuse and owned report replacement, then merge only the exact fixture PR as part of the test driver. Record the authoritative matching merged observation. A later run against an already merged PR is a different scenario.

For remote-head movement, advance the isolated fixture branch with a competing commit after the pipeline records its expected head and before publication. Require rejection and independently confirm that the competing OID remains at the remote. For partial publication failure, interrupt a controlled PR operation after publication has settled, require a durably failed attempt with its publication receipt intact, then explicitly resume:

```sh
/path/to/package/bin/orca-no-mistakes run --repo /path/to/checkout --resume failed-run-id
```

Resume must reconcile the existing candidate, retain the failed attempt outcome, and complete PR binding without repushing. A killed coordinator still marked `in-progress` is not an eligible substitute for that failed-run scenario. Do not impose a total-run or human-decision timeout; worker-attempt deadlines may follow explicitly configured policy.

Export and verify each completed run by exact run ID, not an ambiguous commit selector:

```sh
/path/to/package/bin/orca-no-mistakes attestation export run-id --repo /path/to/checkout --out completion.json
/path/to/package/bin/orca-no-mistakes attestation verify completion.json --repo /path/to/checkout
```

Keep fixture identities, admission/run IDs, accepted and final candidate OIDs, publication and PR receipts, the v2 pipeline evidence/completion roots, all attempt outcomes, custody result, and cleanup result with the workflow artifact. Export failures and failed fixture identities must survive a failed test. An unsigned portable manifest proves internal integrity, not authorship; verification with the originating ledger also checks retained evidence.

Only clean fixture branches/PRs, including the per-run base branches on upstream and the fork-side copy of `onm-79/run/base-fork`, after all scenario assertions and evidence export succeed. Before deleting any branch, compare its current OID with the exact recorded owned OID and use an exact lease; retain a moved branch. Close only PRs whose recorded repository and immutable identity match this run. Preserve all failed or uncertain identities for diagnosis, and report cleanup failure as failure, not a clean live pass.

## Recovery, migration and limits

Migration opens the repository-local ledger under the Git common directory and copies eligible historical state before cleaning the legacy source. Active historical runs or live semantic leases block migration. Retrying after interrupted source cleanup must preserve the committed destination. Migrated Release 1 failures retain their frozen six-stage plan and emit v1.3 local manifests; they do not silently acquire Release 2 publication requirements.

Use `prune --stranded --repo <checkout>` to reconcile provably dead owned resources. It retains custody on liveness, identity or ownership uncertainty. Ordinary `prune` removes eligible terminal ledger/artifact history but preserves Git recovery refs and refuses to discard undelivered recovery commits. Export evidence before pruning. See [the retention guide](../README.md#attestations-and-retention) for the exact retention rules.

As proven on 2026-09-05, Release 2 withheld CI reconciliation; ONM-96 afterwards added the `ci` stage's CI monitoring (ADR-0016), which reports check failures but still does not prove completeness. Release 2 continues to withhold trusted check-set completeness, non-bypass merge/delivery proof, delivered-tree integrity, `checks-passed`, target `Passed`, GitHub Enterprise Server and Windows support. It observes matching merge state but does not claim to implement the later delivery proof. Release 4 crash adoption, parked-gate reattachment and three-way custody recovery remain unavailable: a hard crash can strand pipeline-created commits, and automatic adoption of an abandoned `in-progress` run is not supported. Recovery refs and conservative stranded cleanup do not remove that limitation.
