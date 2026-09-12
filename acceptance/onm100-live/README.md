# ONM-100 disposable live acceptance

This branch is a controlled CI-repair fixture. **Never merge it.**

The initial `total.mjs` deliberately adds a unit price and quantity. Running
`node acceptance/onm100-live/total.mjs` initially prints `5`. The real GitHub
Actions oracle requires multiplication and therefore fails with expected `6`.
The initial failure is the intended starting state, not a production change.

This checkout is only the disposable fixture; it supplies no repair capability.
Its own `ci` gate `fix` resolution merely resumes monitoring after external
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
