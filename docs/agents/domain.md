# Domain Docs

Before exploring the repository, read root `CONTEXT.md` and any ADRs under `docs/adr/` relevant to the work. If either is absent, proceed silently.

This is a single-context repository:

```text
/
|-- AGENTS.md
|-- CONTEXT.md
|-- README.md
|-- bin/
|-- scripts/
|-- tests/
|-- skills/
`-- docs/
    |-- current-architecture.md
    `-- adr/
```

`docs/current-architecture.md` describes implemented behavior. ADRs describe accepted target architecture and carry explicit implementation metadata. Do not infer that an accepted ADR is implemented.

Use terminology defined in `CONTEXT.md`. If a needed domain concept is missing, reconsider whether the term is necessary or note the gap for `/domain-modeling`.

If proposed work contradicts an ADR, surface that conflict explicitly instead of silently overriding it.
