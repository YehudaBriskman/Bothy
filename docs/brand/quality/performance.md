# Performance

_Status as of 2026-08-10._

## The rule

**Publish a budget with numbers**, and enforce it somewhere that can fail the
build. A budget nobody checks is a preference.

**Lazy-load anything heavy behind the route that needs it**, and assert it is
absent from the initial chunk.

**Adding a dependency requires its transferred size** and a note on why it is
not hand-written. This is the single highest-leverage performance rule, because
bundle weight is almost entirely a series of individually reasonable decisions.

**Shape-matched skeletons** so nothing jumps when data lands. Layout shift is a
design bug with a performance name.

**Zero font requests**, or a preloaded subset within budget.

**One shared data poll.** Per-component fetch loops multiply load on the
upstream and desync the interface against itself.

**Stop polling while the document is hidden.** A dashboard lives in a background
tab for days.

**Animate only compositable properties.** See
[motion](../foundations/motion.md).

**Coalesce high-frequency handlers.** Scroll and resize fire far more often than
they can be seen; a frame-coalesced handler is a one-line change.

**Cache static assets far-future; never cache the HTML entry point.**

## Checklist

See [CHECKLIST.md § 29](../CHECKLIST.md#29-performance).

## What Bothy decided, and why

- **Zero font requests.** System stacks only.
- **No charting library.** The charts are hand-written SVG; a library was
  rejected at roughly 40KB for what a polyline does.
- **The command palette is hand-written**, rejecting roughly 14KB for a 27-item
  list.
- **Radix Dialog is the one behavioural dependency taken**, because focus
  management is the thing hand-rolling gets wrong. See
  [components](../patterns/components.md).
- **The 3D scene is lazy-loaded** behind its route and stays out of the main
  bundle. It is roughly twice the size of the entire rest of the app, which is
  exactly why it is not in the entry chunk.
- **One shared poll** for the whole application, lifted into context. Every page
  reads the same loop rather than mounting its own — which would multiply load on
  the container socket proxy and desync the freshness indicator between pages.
- **Polling pauses when hidden**, refreshes on focus, and backs off after
  repeated failures.
- **Scroll progress is frame-coalesced** and animates a transform rather than a
  height.
- **The entry point is served no-cache** so a redeploy is visible immediately;
  hashed assets are immutable.

**Known gaps**, tracked in
[reference/open-questions.md](../reference/open-questions.md): no budget is
published and nothing enforces one. The main chunk is over the default warning
threshold. No measurement has been taken on a slow device.

## Dead ends

- **A framework, to fix a flicker.** The page once jumped on every fetch because
  the render path emptied a container and rebuilt every card, re-running the
  entrance animation. The fix was to stop destroying the DOM — key each card and
  patch in place — not to adopt a library. Measured afterwards: zero cards added
  or removed across three polls, twenty of twenty nodes reused. A framework would
  have added a toolchain and fixed none of it, because a framework that rebuilds
  its list every poll jumps identically.

  (The product later adopted a framework anyway, for unrelated reasons — a richer
  multi-page interface. The reasoning above is still the right reasoning about
  flicker.)

## How this is verified

- Assert heavy dependencies are absent from the initial chunk.
- Once a budget exists, enforce it in CI.
- Measure on the slowest device in the support matrix.
