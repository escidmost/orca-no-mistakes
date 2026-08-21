# Issue Tracker

Issues for this repository live in Linear team `orca no-mistaes` (`ONM`).

Team ID: `5ec56de8-bb06-44e6-b5be-f3edbad589b2`

Use Linear through:

```bash
npx -y @escidmore/linear-axi <command>
```

Authenticate first when needed:

```bash
npx -y @escidmore/linear-axi auth login
```

List repository issues with `issues list --team "orca no-mistaes" --all-projects`. Create issues with `issues create --team "orca no-mistaes"`; use native Linear blocking relationships for dependency edges.

Skills such as `to-spec`, `to-tickets`, `triage`, and `wayfinder` must treat Linear as the authoritative tracker. A Wayfinder map is an issue carrying the `wayfinder:map` label with child issues for its tickets. Existing `.scratch/` files are planning or migration artifacts unless explicitly published into Linear.

The triage-role labels in `triage-labels.md` and the `wayfinder:map` label are required repository configuration. If a required label is missing, request that it be provisioned rather than substituting a category label.

Pull requests are not a request surface for issue triage by default.
