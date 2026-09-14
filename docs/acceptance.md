# Acceptance

Full acceptance is **not complete**. Completion requires passing macOS and Linux local results plus a clean protected live run against dedicated persistent GitHub.com upstream and fork repositories. Local tests exercise controlled Orca/provider implementations; live evidence must exercise the real services.

The pipeline owns the PR title and body. The `pr` stage settles an open binding, and the `ci` stage monitors checks and mergeability until an authoritative matching `MERGED` observation ([ADR-0016](adr/0016-ci-stage-monitoring-and-merge-settlement.md)). Human comments, labels, reviewers and other fields are outside that report ownership. Observing a merged PR does not prove CI completeness, non-bypass merge, or delivered-tree integrity.

## Local matrix

Requires Node 24+, npm and Git, running as an unprivileged user (the suite exercises permission denial). From the package checkout:

```sh
npm ci
npm run typecheck
node scripts/acceptance/local.ts
```

The runner sets an explicit UTF-8 locale for terminal rendering tests and records it with the user ID. The runner executes every `tests/*.test.ts` file with Node's test runner and four concurrent test processes. It creates a fresh directory under `acceptance-results/` containing `tests.tap` and `result.json`. An existing output directory is refused. A failure returns a nonzero exit code and retains the log. An interrupted runner can leave `status: running`; that is not successful evidence. The result records OS, architecture, Node/Git versions, commit, tracked diff digest and TypeScript source/test hashes, including untracked TypeScript files. Retain both files together.

The [Local acceptance workflow](../.github/workflows/local-acceptance.yml) runs this same command on macOS and Linux with Node 24 and retains each platform's artifact even after test failure. A workflow definition alone does not prove either platform passed. The local runner uses controlled Orca/provider implementations and local bare Git repositories; it does not use real GitHub credentials or certify a live Orca installation.

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
| Completion evidence and historical manifests, offline and retained verification | `tests/pipeline-completion-attestation.test.ts`, `tests/repository-ledger-migration.test.ts` |
| Custody divergence, cancellation and stranded cleanup | `tests/orca-no-mistakes.test.ts`, `tests/abort-reap.test.ts`, `tests/resume-generation-custody-pruning.test.ts` |

These entry points identify assertions to inspect; test names are not substitutes for results. The real receive test controls the coordinator entrypoint and invokes production admission primitives; it does not certify real Orca launch. Concurrent admission tests synchronize four processes against the same SQLite ledger; they do not simulate simultaneous full pipelines. The live acceptance record must state precisely which boundary it exercised.

## Recorded local result

The historical record reports 974 passing tests on 2026-09-05 on macOS (Node 26.8.1) and in an unprivileged Linux container (Node 24.20.0), with matching TypeScript source/test hashes. Its evidence locations are `acceptance-results/local-1788645661523/` and `acceptance-results/linux-fixture/result-final/`. Those ignored directories and the local, untracked `GATES.md` are not distributed with this checkout; the claim requires those retained artifacts to verify. Produce fresh evidence for the current source with the Local matrix procedure above. This record does not establish an executed hosted Actions matrix or a live acceptance pass.

The initial root/locale-misconfigured Linux failure remains in `acceptance-results/linux-fixture/result/`. Permission-denial tests require an unprivileged user. Exact log-accounting controls establish distinct birth/change timestamps; the zero-birthtime regression still requires unknown accounting.

## Live fixture prerequisites

Use two dedicated persistent fixture repositories in one GitHub.com fork network. Never use a product repository as the mutation fixture. The upstream needs a committed default branch and trusted validation policy; the fork must permit the authenticated actor to publish a feature branch. Configure an environment with required reviewers, restricted deployment branches and dedicated credentials before enabling a manual live workflow. Merely naming an Actions environment does not protect it.

The runner must have a running Orca app, the package checkout installed, Node 24+, Git, authenticated worker agents, `gh` and `gh-axi`. `GithubAuthority.connect` prefers `gh-axi` when its supported API transport is available, otherwise uses `gh`; record the selected transport. Git push authentication must also work independently of API authentication. Use a fixture-scoped token with content and pull-request write access to both repositories; store it as an environment secret, never in evidence or repository files.

Use a distinct namespace such as `onm-79/<workflow-run-id>-<attempt>/` for every run, including base branches where fixture merges must not alter the persistent default branch. Record upstream/fork stable repository IDs, namespace and exact initial branch OIDs before mutation. The live workflow and fixture identities remain outstanding until provisioned and exercised; no live passing result is recorded by this document.

## Operator sequence

Install from the exact package checkout being accepted. Keep its source identity with the evidence. Before initializing, create a per-run base branch in the upstream fixture for each scenario from the recorded default-branch OID and record each base branch name and OID with the evidence. `init` persists one repository publication route per repository (see CONTEXT.md "Repository publication route"); each run snapshots that route with its own head and base branches, so the branch a run publishes against is decided by the run, not by `init`. A run whose base is the persistent default branch would let the fixture merge below mutate it:

```sh
git -C /path/to/same-repository-checkout push origin "$default_oid:refs/heads/onm-79/run/base-same"
git -C /path/to/fork-checkout push upstream "$default_oid:refs/heads/onm-79/run/base-fork"
```

Check out the exact clean committed feature branch each example submits before initializing: `onm-79/run/same` in the same-repository checkout and `onm-79/run/fork` in the fork checkout. Gate admission requires a checked-out worktree on exactly the submitted ref and candidate, and direct `run` submits the currently checked-out branch, so an arbitrarily named feature branch fails admission. Then initialize each checkout:

```sh
git -C /path/to/same-repository-checkout switch -c onm-79/run/same
git -C /path/to/fork-checkout switch -c onm-79/run/fork
/path/to/package/bin/orca-no-mistakes init --repo /path/to/same-repository-checkout --base-branch onm-79/run/base-same
/path/to/package/bin/orca-no-mistakes init --repo /path/to/fork-checkout --upstream upstream/fixture --fork contributor/fixture --base-branch onm-79/run/base-fork --head-branch onm-79/run/fork
```

Before submitting, verify that the branch currently checked out in each checkout (`git branch --show-current`) is the branch the run must publish: `onm-79/run/same` and `onm-79/run/fork` respectively. The `init` branch overrides do not constrain the run.

The same-repository installed-gate scenario is **blocked pending isolated-base gate support**. The gate launches the admitted pipeline without `--base`, so the run detects `origin/HEAD` (or `main`/`master`) as its base and would publish and merge against the persistent default branch, losing fixture isolation. Do not run it. Once the gate can pass an isolated base through to the run, the intended submission is:

```sh
intent=$(node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64url"))' 'ONM-79: accept same-repository publication')
git -C /path/to/same-repository-checkout push --push-option="no-mistakes.intent=$intent" orca-no-mistakes HEAD:refs/heads/onm-79/run/same
```

Submit the fork fixture through direct ingress with an explicit isolated `--base`; nothing else keeps the run off the persistent default branch. A local fetch of the upstream base is not sufficient: trusted policy reads its configuration from `origin/<base>`, and the rebase stage fetches `<base>` from `origin`, and the fork checkout's `origin` is the fork. The isolated base branch must therefore also exist on the fork at the recorded upstream OID and be fetched into the fork's remote-tracking ref:

```sh
git -C /path/to/fork-checkout push origin "$default_oid:refs/heads/onm-79/run/base-fork"
git -C /path/to/fork-checkout fetch origin onm-79/run/base-fork
/path/to/package/bin/orca-no-mistakes run --repo /path/to/fork-checkout --base onm-79/run/base-fork --intent 'ONM-79: accept fork publication'
```

Confirm that `origin/onm-79/run/base-fork` and upstream `onm-79/run/base-fork` both equal the recorded base OID before running, and record the fork-side base branch as a fixture identity so cleanup accounts for it. Omitting `--base` selects the default branch and the run proceeds against it. Do not pass `--allow-local-config` to bypass trusted policy.

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

Keep fixture identities, admission/run IDs, accepted and final candidate OIDs, publication and PR receipts, pipeline evidence/completion roots, all attempt outcomes, custody result, and cleanup result with the workflow artifact. Export failures and failed fixture identities must survive a failed test. An unsigned portable manifest proves internal integrity, not authorship; verification with the originating ledger also checks retained evidence.

Only clean fixture branches/PRs, including the per-run base branches on upstream and the fork-side copy of `onm-79/run/base-fork`, after all scenario assertions and evidence export succeed. Before deleting any branch, compare its current OID with the exact recorded owned OID and use an exact lease; retain a moved branch. Close only PRs whose recorded repository and immutable identity match this run. Preserve all failed or uncertain identities for diagnosis, and report cleanup failure as failure, not a clean live pass.

## Recovery and limits

Historical ledger imports, frozen plans, and manifest formats follow the [retained-run compatibility contract](current-architecture.md#retained-run-compatibility).

Use `prune --stranded --repo <checkout>` to reconcile provably dead owned resources. It retains custody on liveness, identity or ownership uncertainty. Ordinary `prune` removes eligible terminal ledger/artifact history but preserves Git recovery refs and refuses to discard undelivered recovery commits. Export evidence before pruning. See [the architecture reference](current-architecture.md#entry-points) for the exact retention rules.

The pipeline reports CI failures and observes matching merge state. It does not establish trusted check-set completeness, non-bypass delivery, delivered-tree integrity, `checks-passed` proof, or target `Passed`. GitHub Enterprise Server and Windows are outside this acceptance contract.

Crash adoption, parked-gate reattachment, and three-way custody recovery remain unavailable: a hard crash can strand pipeline-created commits, and automatic adoption of an abandoned `in-progress` run is not supported. Recovery refs and conservative stranded cleanup do not remove that limitation.
