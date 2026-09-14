# ONM-100 historical live acceptance fixture

This directory retains the controlled CI-repair fixture used for ONM-100. The procedure below applies to its dedicated disposable branch and pinned external runner, not an ordinary run from this checkout. Fixture PRs must be closed after evidence collection rather than merged.

The initial `total.mjs` deliberately adds a unit price and quantity. Running
`node acceptance/onm100-live/total.mjs` initially prints `5`. The real GitHub
Actions oracle requires multiplication and therefore fails with expected `6`.
The initial failure is the intended starting state, not a production change.

That oracle only runs when the pull request's head branch is exactly
`evs/onm100-live-acceptance` (`.github/workflows/onm100-live-acceptance.yml`).
Publishing the fixture from any other head branch skips the `exact-total` job,
so the intended failure and repair gate never appear. Publish from that exact
branch name; do not relax the workflow restriction to work around it.

The fixture supplies no repair capability. This package's `ci` gate `fix`
resolution merely resumes monitoring after external
action (see the repository-root `README.md` and `docs/current-architecture.md`),
so the drill requires an external runner: `.orca/workspaces/onm-100-integrate-ci-review-feedback-and-guarded/bin/orca-no-mistakes`
at revision `0f280639e5135265c8f436f5759e4a613af35aa9`, launched with `--repo`
pointing at this fixture checkout.

Under that runner, the controlled acceptance procedure is: the supervising
operator selects that exact failed check in the CI gate; a real isolated fixer
changes only the implementation to multiplication; Review, Test, Document and
Lint then rerun, and the coordinator publishes the new candidate using the prior
publication receipt as its lease baseline. Running the same CLI now prints `6`;
the unchanged remote oracle passes.

The operator retains the exact source executable revision, initial and repaired
candidate OIDs, check/job IDs and logs, selection audit, worker dispatch, stage
evidence, and superseding publication and PR receipts. Genuine Greptile feedback
is a separate prerequisite: neither this README nor a human comment substitutes
for the supported App and Bot identities.

Close the PR after collecting evidence. Keep all recovery references until the
shipping run has consumed the evidence. Do not merge this fixture into `main`.
