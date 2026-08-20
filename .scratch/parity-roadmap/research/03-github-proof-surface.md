# 03 - The GitHub Proof Surface

**Wayfinder question.** Which GitHub API facts and transitions can deterministically prove pull-request
identity, exact head and base, check-set completeness, mergeability, terminal CI state, closure, and
merge - and which races must a coordinator defend against?

**Method.** Material claims are cited to official GitHub REST, GraphQL, Actions, and webhook
documentation, or to the comparator implementation at `/Users/host/repo/no-mistakes` by file and line.
The GraphQL fields and enums used below were also verified by live schema introspection against
`api.github.com` on **2026-08-20**; the corresponding official references are
[PullRequest](https://docs.github.com/en/graphql/reference/pulls#object-pullrequest) and
[StatusCheckRollup](https://docs.github.com/en/graphql/reference/checks#object-statuscheckrollup).

---

## 1. Executive answer

GitHub exposes exact current facts for PR identity, refs, commits, mergeability, checks, closure, and
merge. Those reads are not one atomic snapshot, however, and several facts are current-state
observations rather than proof that GitHub enforced policy during a transition.

| Property | Provable? | The fact that proves it |
|---|---|---|
| PR identity | **Yes** | Repository node ID + PR node ID/number; also bind head/base repository identities |
| Exact current head / base | **Yes, as a read snapshot** | `headRefOid` / `baseRefOid` plus repository IDs and ref names |
| Mergeability | **Yes, once settled** | `mergeable` proves conflict status; `UNKNOWN` means computation is pending |
| Terminal observed CI | **Yes, per exact commit and context** | Paginated `StatusCheckRollup` or REST check runs + legacy statuses |
| Check-set completeness | **No, in the open-world sense** | Existing contexts can be classified; GitHub exposes no "all intended checks registered" fact |
| Closure | **Yes, as current state** | `state == CLOSED && merged == false`; closure is reversible |
| Merge record | **Yes** | `merged`, `mergedAt`, `mergeCommit`, retained head OID, and `mergedBy` when present |
| Policy-enforced merge of an exact candidate | **Conditionally** | Successful non-bypass merge with expected head, or merge queue; post-read the merged tuple |

The decisive distinction is between **facts** and **transitions**. A fresh API read can prove what
GitHub reports now. The strongest proof that current required policy was satisfied is GitHub accepting a
merge under an identity that cannot bypass those rules, or a merge queue completing after testing a fresh
merge-group commit. A bare `merged: true` is weaker: GitHub documents indirect merges, where a PR is
marked merged after its commits reach the base through another PR or direct push, without proving that
this PR traversed its own protection gate
([About pull request merges](https://docs.github.com/en/pull-requests/reference/pull-request-merges)).

Direct merge provides an atomic expected-**head** guard through the `sha` parameter and returns `409`
when it does not match. It provides no caller-supplied expected-**base** SHA, so a coordinator cannot
atomically require that the base observed before the call is still the base GitHub merges against
([REST: Merge a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#merge-a-pull-request)).

---

## 2. The smallest GitHub-first proof surface

### 2.1 Minimal authoritative surface

The smallest surface is one reconciliation query shape, one guarded transition, and one post-transition
read. Pagination may require more than one request; pretending otherwise creates a completeness bug.

1. Resolve the PR once from canonical base repository + number/URL, then retain repository and PR node
   IDs.
2. Reconcile a PR snapshot containing head/base repository IDs, ref names, OIDs, state, merge fields,
   `mergeable`, `mergeStateStatus`, `potentialMergeCommit`, and check rollups for the exact candidate
   commit. Follow every `contexts.pageInfo.hasNextPage` cursor.
3. Use signed webhooks only to wake reconciliation. GitHub says deliveries can be delayed or arrive out
   of order; verify `X-Hub-Signature-256` and deduplicate `X-GitHub-Delivery`
   ([Webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks),
   [out-of-order deliveries](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks#webhooks-deliveries-are-out-of-order)).
4. Prefer merge queue when the repository requires latest-base validation. Otherwise call direct merge
   with the expected head SHA under a non-bypass identity, then re-read the PR and resulting commit.

Relevant wakeups are `pull_request` actions such as `opened`, `closed`, `reopened`, `synchronize`,
`enqueued`, and `dequeued`; `check_run` `created`/`completed`/`rerequested`/`requested_action`;
`check_suite` `completed`/`requested`/`rerequested`; and `merge_group`
`checks_requested`/`destroyed`. None is acceptance evidence by itself
([Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)).

The repeated GraphQL read can use this shape (abridged):

```graphql
query Proof(
  $owner:String!, $name:String!, $number:Int!, $expectedHead:GitObjectID!,
  $headAfter:String, $mergeAfter:String
) {
  repository(owner:$owner, name:$name) {
    id
    pullRequest(number:$number) {
      id
      number url
      state closed closedAt
      merged mergedAt
      mergedBy { login }
      mergeCommit { oid }
      headRepository { id nameWithOwner }
      headRefName headRefOid
      baseRepository { id nameWithOwner }
      baseRefName baseRefOid
      mergeable
      mergeStateStatus
      isInMergeQueue
      potentialMergeCommit {
        oid
        statusCheckRollup {
          state
          contexts(first:100, after:$mergeAfter) {
            totalCount pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun {
                id name status conclusion startedAt completedAt detailsUrl
                isRequired(pullRequestNumber:$number)
                checkSuite { id status conclusion app { id slug } workflowRun { databaseId } }
              }
              ... on StatusContext {
                id context state createdAt targetUrl creator { login }
                isRequired(pullRequestNumber:$number)
              }
            }
          }
        }
      }
    }
    object(oid:$expectedHead) {
      ... on Commit {
        oid
        statusCheckRollup {
          state
          contexts(first:100, after:$headAfter) {
            totalCount pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun {
                id name status conclusion startedAt completedAt detailsUrl
                isRequired(pullRequestNumber:$number)
                checkSuite { id status conclusion app { id slug } workflowRun { databaseId } }
              }
              ... on StatusContext {
                id context state createdAt targetUrl creator { login }
                isRequired(pullRequestNumber:$number)
              }
            }
          }
        }
      }
    }
  }
}
```

After initial resolution, a production query can address the PR through `node(id:$prId)` rather than
relying on the repository slug and number again. The slug-keyed form above keeps the repository-scoped
commit lookup visible
([Using global node IDs](https://docs.github.com/en/graphql/guides/using-global-node-ids)).

GitHub has two status systems: Checks API runs and legacy commit statuses. `StatusCheckRollup.contexts`
combines both as `CheckRun` and `StatusContext`; a REST implementation must call both APIs
([GraphQL: StatusCheckRollup](https://docs.github.com/en/graphql/reference/checks#object-statuscheckrollup),
[REST: check runs](https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28#list-check-runs-for-a-git-reference),
[REST: combined status](https://docs.github.com/en/rest/commits/statuses?apiVersion=2022-11-28#get-the-combined-status-for-a-specific-reference)).

The relevant tested OID is not always the PR head. GitHub Actions `pull_request` workflows ordinarily run
on `refs/pull/<number>/merge`, and `GITHUB_SHA` is that synthetic merge commit; the event's
`pull_request.head.sha` is the source head
([Actions: pull_request](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)).
GitHub's required-status documentation says that when the test merge commit has statuses, that commit
must pass; otherwise the head commit is used. Preserve whether evidence belongs to `headRefOid`,
`potentialMergeCommit.oid`, or a merge-queue group SHA
([Troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)).

Then, for direct merge:

```
PUT /repos/{owner}/{repo}/pulls/{number}/merge     body: { "sha": "<expectedHead>", "merge_method": ... }
```

`sha` is documented as "SHA that pull request head must match to allow merge", and the endpoint returns
**`409` when it does not match**
([REST: Merge a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#merge-a-pull-request)).

`isRequired(pullRequestNumber:)` authoritatively classifies an **existing** check or status context for
that PR. It cannot reveal a required context that has not registered yet. For auditability or to explain
why a merge is blocked, snapshot active branch rules and legacy branch protection as additional evidence:
`GET /repos/{owner}/{repo}/rules/branches/{branch}` and
`GET /repos/{owner}/{repo}/branches/{branch}/protection`. Rules may require status checks, workflows,
reviews, deployments, code scanning, or merge queue, and branch protection exposes strictness and admin
enforcement
([REST: rules](https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28),
[REST: branch protection](https://docs.github.com/en/rest/branches/branch-protection?apiVersion=2022-11-28)).
Those policy and PR reads are not transactional, so the successful non-bypass transition remains the
authoritative policy gate.

### 2.2 Verified live

Run against `cli/cli#14207` on 2026-08-20 (abridged):

```json
{ "pullRequest": {
    "id": "PR_kwDODKw3uc8AAAABAcHtKw", "number": 14207, "state": "OPEN",
    "merged": false, "mergeCommit": null,
    "headRefOid": "5c44f6ca008f0f03aa88d086243eecf1c6b62f77",
    "baseRefOid": "a0a1392e61fc6cac9aa720d2151c787c7d285e46", "baseRefName": "trunk",
    "mergeable": "MERGEABLE", "mergeStateStatus": "BLOCKED", "isInMergeQueue": false },
  "object": { "statusCheckRollup": { "state": "PENDING", "contexts": { "totalCount": 16, "nodes": [
      { "__typename":"CheckRun", "name":"build (ubuntu-latest)", "status":"IN_PROGRESS",
        "conclusion":null, "isRequired":true },
      { "__typename":"CheckRun", "name":"CodeQL-Build (go, manual, ...)", "status":"COMPLETED",
        "conclusion":"SUCCESS", "isRequired":false },
      { "__typename":"CheckRun", "name":"build (windows-latest)", "status":"IN_PROGRESS",
        "conclusion":null, "isRequired":true } ] } } } }
```

No preview `Accept` header was supplied; `mergeStateStatus` returned normally through `gh api graphql`.

This snapshot demonstrates an important distinction:

> **`mergeable: MERGEABLE` and `mergeStateStatus: BLOCKED` simultaneously.**

`mergeable` answers *"do the trees conflict?"*. `mergeStateStatus` is a useful aggregated readiness
signal, but values such as `BLOCKED` are intentionally generic and are not a durable policy proof. A
coordinator that gates on `mergeable` alone can call the merge endpoint and receive `405` when GitHub
cannot perform the merge
([REST: Merge a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#merge-a-pull-request)).
The snapshot also shows required and advisory checks interleaved in one rollup with required checks still
running. `isRequired` separates existing contexts; it does not close the missing-context race.

---

## 3. Property by property

### 3.1 PR identity

Anchor identity on **repository node ID + `PullRequest.id`** (`ID!`, non-null), retaining the
repository-local number and canonical URL for human audit. `number` is only unique within a repository,
so `(repository.id, number)` is an acceptable locator; a bare number or branch name is not identity
([GraphQL: PullRequest](https://docs.github.com/en/graphql/reference/pulls#object-pullrequest)).

Do **not** derive identity from a branch name. `gh pr list --head <branch>` can legitimately return more
than one PR (different bases, fork heads). The comparator handles this explicitly: `FindPR` iterates
candidates and, for fork PRs, matches on `headRepositoryOwner.login` before accepting one
(`internal/scm/github/github.go:186-217`). It also refuses to let the CLI infer a PR from the working
directory at all - `prSelector` fails closed rather than let `gh` resolve the cwd's branch, because the
daemon runs from a detached bare gate repo whose HEAD is the default branch and an inferred selector
would silently target the wrong PR (`internal/scm/github/github.go:106-116`).

Also bind both head and base repository IDs, not only ref names: fork PRs can reuse the same branch name.

**Proved by:** base repository ID + PR ID/number + head/base repository IDs.

### 3.2 Exact head and base

`headRefOid` and `baseRefOid` are both **`GitObjectID!`** and expose exact commit OIDs in the current PR
snapshot; REST exposes the same facts under `head.sha` and `base.sha`
([GraphQL: PullRequest](https://docs.github.com/en/graphql/reference/pulls#object-pullrequest),
[REST: Get a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request)).

`baseRefOid` is the tip of the base branch *as GitHub currently sees it*, not the merge base of the PR.
It moves when the base advances. If the question is "what was this diff computed against", also record
the merge base
(`GET /repos/{o}/{r}/compare/{base}...{head}` -> `merge_base_commit`,
[REST: commits](https://docs.github.com/en/rest/commits/commits?apiVersion=2022-11-28)).

For CI, additionally identify the exact candidate SHA GitHub evaluated: `headRefOid`,
`potentialMergeCommit.oid`, or the merge-group SHA. For delivery, direct merge cannot atomically pin the
previously observed base because its request has no expected-base parameter. Merge queue is GitHub's
native latest-base mechanism: it creates a merge-group commit from the current base plus queued changes,
runs required checks on that commit, and recreates the group when membership/order changes
([Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).

**Proved by:** head/base repository IDs, ref names, and OIDs in a timestamped snapshot. Exact-base
continuity through direct merge: not atomically provable before the transition.

### 3.3 Mergeability

Three fields, three different questions. Conflating them is the most common design error here.

| Field | Question it answers | Values |
|---|---|---|
| `mergeable` | Do the trees conflict? | `MERGEABLE`, `CONFLICTING`, `UNKNOWN` |
| `mergeStateStatus` | What aggregated readiness state does GitHub currently report? | `CLEAN`, `BLOCKED`, `BEHIND`, `UNSTABLE`, `DIRTY`, `HAS_HOOKS`, `UNKNOWN` |
| `isInMergeQueue` | Is a queue going to merge this instead of me? | `Boolean!` |

Introspected descriptions of `MergeStateStatus`: `DIRTY` "The merge commit cannot be cleanly created";
`BLOCKED` "The merge is blocked"; `BEHIND` "The head ref is out of date"; `UNSTABLE` "Mergeable with
non-passing commit status"; `HAS_HOOKS` "Mergeable with passing commit status and pre-receive hooks";
`CLEAN` "Mergeable and passing commit status"; `UNKNOWN` "The state cannot currently be determined."

`UNKNOWN` is not a failure and must never be read as one. The REST documentation is explicit about the
mechanism:

> "The value of the `mergeable` attribute can be `true`, `false`, or `null`. If the value is `null`,
> then GitHub has started a background job to compute the mergeability. After giving the job time to
> complete, resubmit the request."
> - [REST: Get a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request)

The comparator encodes exactly this: `normalizeMergeableState` folds both `"UNKNOWN"` and the empty
string into `MergeablePending` (`internal/scm/github/github.go:547-558`), and `MergeableState.Resolved()`
admits only `MERGEABLE` or `CONFLICTING` as terminal (`internal/scm/host.go:124-127`). The CI loop
blocks on anything else and records why (`internal/pipeline/steps/ci.go:312-329`).

For a *readiness signal*, `mergeStateStatus == CLEAN` is useful; `BLOCKED`, `BEHIND`, `UNSTABLE`, and
`UNKNOWN` must not be promoted. It is not a durable or independently auditable proof of every active
rule. For a *conflict* fact, `mergeable == CONFLICTING` is the right predicate. The authoritative policy
decision is the merge/queue transition under a non-bypass identity.

**Proved by:** `mergeable` (conflicts), once settled. `mergeStateStatus` is a current readiness signal;
the merge/queue transition is the policy decision.

### 3.4 Terminal CI state

Per-check terminality is unambiguous. `CheckRun.status` is a `CheckStatusState`
(`REQUESTED`, `QUEUED`, `IN_PROGRESS`, `COMPLETED`, `WAITING`, `PENDING`) and only `COMPLETED` is
terminal. `CheckRun.conclusion` is a `CheckConclusionState`, introspected as:

`ACTION_REQUIRED`, `TIMED_OUT`, `CANCELLED`, `FAILURE`, `SUCCESS`, `NEUTRAL`, `SKIPPED`,
`STARTUP_FAILURE`, and `STALE` - the last documented as "marked stale by GitHub. Only GitHub can use
this conclusion."

Three of these are traps for a naive `conclusion != SUCCESS => broken code` rule:

- **`CANCELLED`** is terminal but is *not a verdict on the code*. Something cancelled the job.
- **`STALE`** is GitHub disowning the result; it is not a failure either.
- **`SKIPPED`/`NEUTRAL`** are terminal non-failures.

The comparator separates these deliberately. `normalizeCheckBucket` maps
`FAILURE|ERROR|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE` -> fail, `CANCELLED` -> its own `cancel` bucket,
and `SKIPPED|NEUTRAL|STALE` -> skip (`internal/scm/github/github.go:560-579`). The CI loop then maintains
*two* distinct pending notions: `checksPending` (only running/queued work blocks a rerun) and the broader
`readinessPending`, where "any state that is not a conclusive pass, failure, or skip must keep the PR
non-ready" - cancelled and unrecognized states included (`internal/pipeline/steps/ci.go:339-347`). A
cancelled check is routed to a human gate rather than to the fix agent, on the reasoning that no code fix
can clear it (`internal/pipeline/steps/ci.go:450-458`).

The aggregate `statusCheckRollup.state` is a `StatusState`
(`EXPECTED`, `ERROR`, `FAILURE`, `PENDING`, `SUCCESS`). For legacy statuses, REST documents this
aggregation rule:

> "**failure** if any of the contexts report as `error` or `failure`; **pending** if there are no
> statuses or a context is `pending`; **success** if the latest status for all contexts is `success`"
> - [REST: Get the combined status for a specific reference](https://docs.github.com/en/rest/commits/statuses?apiVersion=2022-11-28#get-the-combined-status-for-a-specific-reference)

That REST endpoint does **not** include Checks API runs, so it cannot be used alone. Required checks may
be either check runs or legacy statuses; if both share the same required name, GitHub requires both.
GitHub accepts required-check results `success`, `skipped`, or `neutral`; cancelled, stale, failed,
timed-out, action-required, or nonterminal results do not prove required-policy satisfaction
([About status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks)).

**Proved by:** `status == COMPLETED` plus `conclusion`, per context, read against a pinned `oid`.

### 3.5 Check-set completeness - the one that cannot be proved

There are three different questions hiding under this heading.

**Answerable: "what check/status contexts does GitHub currently know for this exact commit, and are they
terminal?"** Fully paginate `StatusCheckRollup.contexts` or both REST status systems, retain context/run
IDs and app identity, and evaluate terminality.

**Partly answerable: "which existing contexts are required for this PR?"**
`isRequired(pullRequestId:)` / `isRequired(pullRequestNumber:)` answers that for an existing `CheckRun`
or `StatusContext`. It cannot emit a node for a required workflow or context that has not registered.
Active branch rules and protection can describe configured requirements, but those reads race with both
policy changes and check registration
([REST: rules](https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28),
[REST: branch protection](https://docs.github.com/en/rest/branches/branch-protection?apiVersion=2022-11-28)).

**Authoritatively answerable only as a transition: "did GitHub accept the currently required set?"** A
successful merge under an identity that cannot bypass rules, or a successful merge-queue transition,
proves GitHub's current required policy was satisfied at that transition. It does not prove the intended
or advisory check set.

**Unanswerable: "will any further check ever appear for this commit?"** This is an open-world question and
GitHub exposes no fact that closes it. Concretely:

- A workflow that has not yet been scheduled contributes nothing to the rollup. An empty rollup and a
  repository with no CI are **indistinguishable** at the API.
- Any GitHub App with `checks:write` may create a check run against any commit at any time
  ([REST: Create a check run](https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28#create-a-check-run)),
  and any token with `repo:status` may post a commit status
  ([REST: commit statuses](https://docs.github.com/en/rest/commits/statuses?apiVersion=2022-11-28#about-commit-statuses)).
  Nothing bounds when.
- Re-requesting resets state *backwards*: "When a check run is `rerequested`, the `status` of the check
  suite it belongs to is reset to `queued` and the `conclusion` is cleared"
  ([REST: Rerequest a check run](https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28#rerequest-a-check-run)).

So a fully-green rollup at time *T* is a statement about *T*, never about *T+1*. **Elapsed time is not
evidence of completeness**, and any "we waited 60 s and nothing appeared, so we're green" rule is
unsound - it converts a timeout into a proof.

The comparator refuses this inference outright, and is unusually explicit about it. An empty check list
is never green unless a **trusted default-branch** config declares `no_ci: true`; a feature branch cannot
self-declare it (`internal/pipeline/steps/ci.go:34-37`, `:534-546`). The code comment states the rule
directly: *"Elapsed time is not evidence; there is no grace-period promotion path"*
(`internal/pipeline/steps/ci.go:538-539`). The log vocabulary carries the same warning:
*"An empty check list WITHOUT that declaration must never produce this line"*
(`internal/cimonitor/cimonitor.go:27-30`).

That is the correct shape of the answer: **open-world completeness is supplied out-of-band by a trusted
declaration because GitHub cannot supply it.** A GitHub-first coordinator can delegate required-policy
acceptance to a non-bypass merge transition, but still needs a repo-owned manifest when "Passed" means
that named advisory checks must also appear.

**Proved by:** current observed-set terminality; required-policy acceptance at a non-bypass merge/queue
transition. Open-world intended-set completeness: not provable.

### 3.6 Closure

`state: PullRequestState!` is introspected as exactly three values: `OPEN` ("still open"), `CLOSED`
("closed without being merged"), `MERGED` ("closed by being merged"). `closed: Boolean!` and `closedAt`
are separate fields.

The trap: **`CLOSED` is not monotonic.** A closed PR can be reopened, moving `state` back to `OPEN`.
A coordinator that latches "closed => run over" will mis-handle a reopen. Note also that `closed` is true
for a merged PR; `merged`/`state` distinguish merged from closed-unmerged.

The comparator treats closure as run-ending but re-derives it on every poll rather than caching it, and
its gate reconciler re-reads live state so that a merge or close occurring *after* a gate was recorded
supersedes the stale gate; open/unknown/error states stay parked rather than guessing
(`internal/pipeline/steps/ci.go:61-124`, `:297-302`).

**Proved by:** `state == CLOSED && merged == false` - as a current-value fact, not a latch.

### 3.7 Merge

GitHub exposes a strong **merged record**: `merged: Boolean!`, `mergedAt`, nullable `mergedBy`, and
`mergeCommit`. That proves GitHub currently records the PR as merged and retains the PR's last head OID
([GraphQL: PullRequest](https://docs.github.com/en/graphql/reference/pulls#object-pullrequest)). It does
not by itself prove that this PR passed its protection gate: GitHub documents indirect merges, and privileged
actors may bypass branch protection or rulesets unless enforcement forbids it
([About pull request merges](https://docs.github.com/en/pull-requests/reference/pull-request-merges),
[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).

The critical subtlety is that REST **`merge_commit_sha` changes meaning with state and merge method**:

> "The value of the `merge_commit_sha` attribute changes depending on the state of the pull request.
> Before merging a pull request, the `merge_commit_sha` attribute holds the SHA of the *test* merge
> commit." ... "If `mergeable` is `true`, then `merge_commit_sha` will be the SHA of the *test* merge commit."
> - [REST: Get a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request)

After merging, its meaning depends on the merge method (merge commit / squash / rebase), per the same
section. GraphQL avoids that overload: `potentialMergeCommit` is the disposable test merge before merge,
while `mergeCommit` is the resulting commit after merge
([GraphQL: PullRequest](https://docs.github.com/en/graphql/reference/pulls#object-pullrequest)).

**A merged-record proof is a tuple, not a boolean.** The comparator makes this structural: `MergedProof{Merged,
Number, URL, HeadSHA, MergeCommitSHA, MergedAt, MergedBy}` (`internal/scm/host.go:189-198`), and its
Forgejo backend *rejects* a claimed merge whose evidence is incomplete - if `MergeCommitSHA` is empty, or
`MergedAt` is zero, or `MergedBy` is empty, the proof is refused rather than accepted as a bare `merged:
true` (`internal/scm/forgejo/forgejo.go:365-367`). GitHub GraphQL exposes every field that tuple needs.

For a coordinator-issued direct merge, retain the successful response to
`PUT /pulls/{number}/merge` with `sha == expectedHead`, then fresh-read the tuple and resulting commit.
That proves the exact head accepted by the call. It proves required policy only if the authenticated
identity cannot bypass it. It does not atomically pin the prior base. For merge-commit delivery, the
result commit's parents can establish the actual base/head inputs; squash and rebase rewrite lineage, so
compare resulting trees/content rather than requiring the original head SHA as an ancestor. GitHub's
`merge_commit_sha` meaning varies by merge method
([REST: Get a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request)).

`GET /repos/{owner}/{repo}/pulls/{number}/merge` returning `204` is a REST alternative for the narrow
fact that GitHub currently records the PR as merged; like `merged=true`, it does not prove how the PR
became merged
([REST: Check if a pull request has been merged](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#check-if-a-pull-request-has-been-merged)).

**Proved by:** current merged record: `merged == true` + expected retained head + merge result facts.
Exact policy-mediated transition: successful expected-head merge/queue under a proven non-bypass
identity + post-transition reconciliation.

---

## 4. Races a coordinator must defend against

| # | Race | Why it bites | Defense |
|---|---|---|---|
| 1 | **Wrong PR selected** | Branch names and PR numbers are not global; fork heads collide | Bind base repo ID + PR ID/number + head/base repo IDs; never infer from cwd |
| 2 | **Head moves between read and merge** | Force-push or new commit lands after the green read | Direct merge `sha` guard returns `409` ([REST merge](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#merge-a-pull-request)) |
| 3 | **Base moves after evidence** | Previously observed test merge/checks may no longer describe what lands | Invalidate `baseRefOid`/`potentialMergeCommit`; prefer merge queue for latest-base validation |
| 4 | **Wrong CI target** | PR workflows may test synthetic merge SHA while the coordinator reads only head checks | Record and query the exact head, test-merge, or merge-group OID ([Actions pull_request](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)) |
| 5 | **GraphQL/REST pagination drifts** | Page 1 and page N can observe different check sets | Fully paginate, retain stable IDs, then re-read anchor OIDs/state; restart if they changed |
| 6 | **Missing required context** | `isRequired` classifies existing nodes but cannot emit a check that has not registered | Do not infer completeness from existing nodes; use active rules for explanation and the non-bypass merge/queue transition as policy authority |
| 7 | **Late check or status registration** | A green snapshot can gain a new context later | Advisory/intended-set completeness requires a trusted manifest; merge only through expected-head guard |
| 8 | **Re-request clears suite but not run** | Suite becomes queued while an old run object can still look terminal | Read suite and run state/IDs; reconcile on `check_run`/`check_suite` rerequest events ([REST rerequest](https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28#rerequest-a-check-run)) |
| 9 | **`filter=latest` hides attempts** | A rerun can replace the result being reasoned about | Use `filter=all` when attempt history matters; preserve run IDs/timestamps ([REST check runs](https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28#list-check-runs-for-a-git-reference)) |
| 10 | **Checks and statuses share a name** | Reading only one status system misses a required result | Enumerate both; GitHub may require both ([About status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks)) |
| 11 | **Policy changes during polling** | Rules and check snapshots are not transactional | Snapshot rules for audit, but treat the successful non-bypass transition as the current-policy verdict |
| 12 | **Bypass identity merges blocked PR** | Successful merge then proves actor privilege, not policy satisfaction | Use a service identity with no bypass; inspect admin enforcement/ruleset bypass facts where visible ([REST rules](https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28)) |
| 13 | **Webhook duplicate, delay, loss, or reorder** | Event order is not API-state order | Verify signature, dedupe delivery ID, use events only as wakeups, then fetch fresh state ([Webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)) |
| 14 | **Close -> reopen or concurrent merge** | A previously observed closure can reverse; merge can occur mid-poll | Reconcile fresh state before deciding; verify expected head even after observing merged |
| 15 | **Indirect merge** | `merged=true` can be set after commits arrive through another path | Require the coordinator's successful expected-head transition when policy-gated custody matters ([About PR merges](https://docs.github.com/en/pull-requests/reference/pull-request-merges)) |
| 16 | **Merge queue rebuilds candidate** | Base advance, failure, or reorder produces a new merge-group SHA | Bind evidence to each `merge_group` head SHA; invalidate destroyed/replaced groups ([Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)) |
| 17 | **Fork head force-push** | Head repo is outside base-repo control | Bind head repository ID + `headRefOid`; re-verify with merge expected-head guard |
| 18 | **Result is an assertion, not execution proof** | An authorized app/token can report a result without GitHub observing the build | Trust only configured app/context provenance; GitHub cannot prove external execution |

The merged-state/head race deserves emphasis because it is the one most designs miss. The comparator's interface comment
states it outright: *"The expected head must be checked even when the PR is already merged, because merge
and monitor polling can race"* (`internal/scm/host.go:200-205`), backed by a dedicated sentinel
`ErrHeadChanged` - *"It prevents a late status or already-merged race from proving the wrong commit"*
(`internal/scm/host.go:183-186`). Observing `merged: true` is not sufficient; you must confirm *which head*
was merged.

---

## 5. What GitHub cannot authoritatively provide

1. **Open-world check-set completeness.** Section 3.5. No fact bounds future check/status registration or says
   every intended workflow has registered.

2. **An atomic snapshot across PR, policy, and checks.** GraphQL can group many PR/check fields, but
   active rules, pagination, and mutations still create separate observation windows. Reconcile and
   invalidate; do not label a set of reads transactional.

3. **An expected-base compare-and-swap for direct merge.** The merge request accepts expected head only.
   Merge queue is the GitHub-native answer when current-base validation is required
   ([REST merge](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#merge-a-pull-request),
   [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).

4. **That a merged record traversed this PR's policy gate, or always names an actor.** Indirect merges
   and bypass identities make `merged=true` insufficient, and GraphQL's `mergedBy` field is nullable.
   Retain the authenticated coordinator-issued guarded transition or merge-queue custody
   ([GraphQL: PullRequest](https://docs.github.com/en/graphql/reference/pulls#object-pullrequest),
   [About pull request merges](https://docs.github.com/en/pull-requests/reference/pull-request-merges)).

5. **That CI actually executed.** A check run is an *assertion by an App*, and a commit status is an
   assertion by any token holding `repo:status`. GitHub records **who** asserted (`CheckSuite.app`,
   `StatusContext.creator` - both introspected) and **which commit** the assertion targets. It does not
   verify that a build ran, that it ran this code, or that the reported conclusion reflects it. Green is
   attested provenance, not executed proof
   ([REST: check runs](https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28),
   [REST: commit statuses](https://docs.github.com/en/rest/commits/statuses?apiVersion=2022-11-28)).

6. **That head-only CI tested what will land.** PR workflows may run on a synthetic merge commit, and
   loose required checks can permit merge without retesting the latest base. Strict checks or merge queue
   strengthen this guarantee
   ([About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).

7. **Original-commit lineage across squash/rebase merges.** After a squash or rebase merge,
   `mergeCommit.oid` does **not**
   have `headRefOid` as a parent. "Was my exact reviewed commit merged?" is therefore *not* answerable
   from git ancestry afterwards - it is answerable only from the PR's own record (`merged` + `headRefOid`
   captured at transition time) plus content/tree comparison where needed
   ([About pull request merges](https://docs.github.com/en/pull-requests/reference/pull-request-merges),
   [REST: Get a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request)).

8. **Whether the pushed head equals the reviewed head.** This is a local-git fact. The comparator proves it
   locally rather than asking the forge: `assertPipelineHeadContinuity` compares the recorded head to live
   `HEAD` and requires `git merge-base --is-ancestor`, failing closed on a non-ancestor *or any git error*
   (`internal/pipeline/steps/common_fix.go:95-116`).

9. **Whether an advisory workflow *should* have run.** Absence of a check is indistinguishable from
   correctly-configured absence. Requires a repo-owned declaration (Section 3.5).

10. **Intent conformance.** Whether the change does what was asked is outside the API entirely.

---

## 6. Comparator delta - `/Users/host/repo/no-mistakes`

The comparator's provider-agnostic interface was designed around exactly the proof surface above, and
then its **GitHub backend implements only a fraction of it**. This is the central parity finding.

`scm.Capabilities` declares ten capability bits (`internal/scm/host.go:163-176`), with the contract that
"Callers must consult Capabilities before invoking optional methods" (`:164-165`). What each backend
actually declares:

| Capability | GitHub (`github.go:135-137`) | Forgejo (`forgejo.go:129-145`) |
|---|---|---|
| `MergeableState` | Yes | Yes (derived: `CommitStatuses && BranchProtection`) |
| `FailedCheckLogs` | Yes | Yes (requires four sub-capabilities) |
| `MergedProof` | No | Yes |
| `ExpectedHeadMerge` | No | Yes |
| `CommitStatuses` | No | Yes |
| `BranchProtection` | No | Yes |
| `ActionsRuns` / `ActionsRunJobs` / `ActionsJobLogs` | No | Yes |

The consequence is concrete and load-bearing. `verifyMergedProof` opens with:

```go
if !host.Capabilities().MergedProof {
    return nil
}
```
(`internal/pipeline/steps/ci.go:126-128`)

**For GitHub this function is a no-op.** The pipeline accepts `GetPRState() == MERGED` - which is
`gh pr view --json state`, a bare three-valued string (`internal/scm/github/github.go:254-267`) - as
sufficient evidence of merge, and never binds it to a head SHA. Every downstream guard is skipped: the
PR-identity check (`ci.go:141-143`), the `!proof.Merged` check (`:138-140`), and the `ErrHeadChanged`
comparison (`:144-146`). This race is undefended on GitHub, and defended on Forgejo.

The merged-head gap is not a GitHub field limitation. **GitHub GraphQL exposes the full query shape** -
`merged`, `mergedAt`, nullable `mergedBy`, `mergeCommit.oid`, `headRefOid` - all verified by
introspection. The Forgejo backend obtains the same tuple from a purpose-built
`forgejo-axi pr merged` command and validates identity, number, and expected head before returning it
(`internal/scm/forgejo/forgejo.go:325-369`, `:789-797`), refusing an empty expected head outright
(`:331-333`). An equivalent GitHub query would close the merged-head race. If `mergedBy` is absent, a
comparator-equivalent proof must fail closed or use the retained authenticated transition actor. The
query would not, by itself, prove that an indirect or bypass merge traversed required policy.

Two further gaps follow from the backend's choice of transport (`gh` CLI rather than the API):

- **Checks are never bound to a SHA.** `GetChecks` shells out to
  `gh pr checks --json name,state,bucket,completedAt,link` (`internal/scm/github/github.go:269-311`),
  which reports no head SHA. The pipeline compensates with a reasoned argument rather than a fact - *"a
  status rollup is per commit, so a cancellation in it belongs to the commit under test and cannot be a
  leftover from a head this run already replaced"* (`internal/pipeline/steps/ci.go:404-406`). That
  reasoning is correct, but it is an inference about an unobserved value where `object(oid:)` would
  return the observed one. Note the backend *does* SHA-scope its log fetch
  (`gh run list --commit <headSHA>`, `github.go:416-466`) - so the capability is present, just not applied
  to the checks read.
- **`PR.HeadSHA` is never populated.** `FindPR` requests only `number,url`
  (`internal/scm/github/github.go:159-202`), leaving the field the interface documents as "populated when
  the provider exposes the exact source commit" (`internal/scm/host.go:93`) empty - even though
  `headRefOid` is `GitObjectID!` and always available.
- **Base and policy readiness are not bound into evidence.** The CI loop notices base-branch advancement
  but only re-arms its monitoring timeout (`internal/pipeline/steps/ci.go:255-274`), and the GitHub
  backend asks only for GraphQL `mergeable`, not `baseRefOid`, `potentialMergeCommit`, or
  `mergeStateStatus` (`internal/scm/github/github.go:401-414`).

What the comparator gets **right**, and a GitHub-first coordinator should copy verbatim:

- Empty checks are never green without a trusted, out-of-band, default-branch declaration; elapsed time
  is explicitly rejected as evidence (`ci.go:534-546`, `cimonitor.go:27-30`).
- Unresolved mergeability blocks rather than resolving either way (`host.go:124-127`, `ci.go:312-329`).
- Cancelled is terminal-but-not-a-verdict and routes to a human, not to a fix agent
  (`ci.go:450-458`, `github.go:560-579`).
- Re-runs between polls are detected via per-check `completedAt` moving forward
  (`host.go:150`, `ci.go:364-367`).
- Capability probes fail closed rather than being inferred from a version string
  (`forgejo.go:123-125`) - the same discipline a GitHub backend needs for GHES.
- PR selection refuses cwd inference (`github.go:106-116`).

---

## 7. Recommendations for a GitHub-first coordinator

1. **Adopt the reconciliation query shape in Section 2.1.** Bind repository/PR identity, head/base OIDs, and the
   exact tested candidate; paginate every context and restart if anchor facts change.
2. **Implement `MergedProof` for GitHub.** Populate `PR.HeadSHA` and compare it even after observing
   merged. This closes the comparator's current merged-head race.
3. **Read both check systems on the exact candidate SHA.** Preserve check/status IDs, app provenance,
   suite state, timestamps, and attempt history; do not rely on `gh pr checks` without a SHA.
4. **Use a non-bypass service identity.** Treat successful expected-head merge as the required-policy
   transition. Treat `409` as a lost race, not a blind retry. If non-bypass cannot be proved, do not claim
   the transition proved policy.
5. **Prefer merge queue for latest-base guarantees.** Bind evidence to the current merge-group SHA and
   discard it whenever GitHub recreates the group.
6. **Define completeness explicitly.** Required-policy completeness comes from the non-bypass GitHub
   transition. Advisory/intended checks require a trusted default-branch manifest; preserve the
   comparator's fail-closed `no_ci: true` rule (`internal/pipeline/steps/ci.go:34-37`, `:534-546`).
7. **Use `mergeable` for conflict status and `mergeStateStatus` as a readiness signal, not a durable
   proof.** The actual merge/queue decision is authoritative.
8. **Treat webhooks as latency reduction only.** Verify signatures, deduplicate delivery IDs, and fetch
   fresh API state after every relevant event.
9. **Persist the transition evidence.** Record the pre-action snapshot, authenticated actor/bypass
   assumption, guarded merge or merge-group result, post-action merged tuple, and resulting commit/tree.

The smallest honest GitHub-first surface is therefore: a fully paginated reconciliation snapshot over
the exact PR and candidate commit, a non-bypass expected-head merge or merge-queue transition, and a
post-transition merged/commit snapshot. GitHub cannot close the open-world check set, atomically pin a
direct merge to a caller-specified base SHA, or prove from `merged=true` alone that this PR traversed its
policy gate.
