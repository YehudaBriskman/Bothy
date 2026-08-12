# Design brief — RETIRED 2026-08-10

**Superseded by [`docs/brand/`](../../docs/brand/README.md)** — the design and
brand system, with a checklist, per-topic documents and a token reference.

## Why this file is retired rather than deleted

It was never a design system. It was a one-off **orchestration contract**: a
scheduling document written so three agents could rebuild disjoint parts of the
portal in parallel without colliding. It listed which files each agent owned,
which files not to touch, and what the shared library exported at that moment.

That is a document with a short useful life, and treating it as durable is
exactly the failure the new tree's
[governance](../../docs/brand/quality/governance.md) section exists to prevent.
Its token names went stale within weeks — it referenced `--ink`, `--dim`,
`--primary` and `--surface`, none of which exist any more, plus a `Reveal`
component and a `SystemCard` that were both deleted for reasons now recorded in
the [decision log](../../docs/brand/reference/decisions.md).

## The one part still worth reading

**The mental model**, which is unchanged and still correct:

- A **system** is one compose group (`n.group`): a project (`tals`, `cvops`), a
  stack service (`monitoring`, `kafka`, `postgres`, `redis`), or infrastructure
  (`edge`, `portal`). One system maps to one row on the Overview and one domain
  page at `/systems/:group`.
- A **service** is one `PortalNode` — a routed container, an unrouted container,
  or an `@file` host process. Clicking one opens `/services/:id`.

The rollup logic for that model lives in `web/src/lib/systems.ts` and is pure.

## Where everything else went

| You wanted | Now in |
|---|---|
| Tokens, palettes, contrast | [foundations/colour.md](../../docs/brand/foundations/colour.md), [reference/tokens.md](../../docs/brand/reference/tokens.md) |
| What components exist | [patterns/components.md](../../docs/brand/patterns/components.md) |
| Rules for adding a page | [CHECKLIST.md](../../docs/brand/CHECKLIST.md) |
| Why something is the way it is | [reference/decisions.md](../../docs/brand/reference/decisions.md) |
| What is still wrong | [reference/open-questions.md](../../docs/brand/reference/open-questions.md) |
