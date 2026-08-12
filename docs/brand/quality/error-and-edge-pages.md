# Error and edge pages

_Status as of 2026-08-10._

## The rule

**Blank is not a state.** Every failure path renders something. This is the
governing rule of the whole document, and it is violated by accident far more
often than by decision — a component that throws, an animation that never runs,
a fetch that clears state before it fails.

**A not-found page keeps the shell** and offers a way out, with the bad URL
still in the address bar.

**A top-level error boundary** catches render crashes and offers a reload plus a
copyable diagnostic. Without one, a single component error unmounts the entire
application.

**One failing data source degrades the page; it never blanks it.** Decide in
advance which source is the skeleton and which is enrichment.

**Empty, zero and unknown are three different screens.** "There is nothing",
"the value is zero" and "we have not checked" mean different things and must not
share a message.

**Stale data shows its age.**

**A missing capability falls back to a static render**, not an empty box.

**This is the page people open when things are broken.** It must be the most
robust surface in the product, not the least.

## Checklist

See [CHECKLIST.md § 25](../CHECKLIST.md#25-error-and-edge-pages).

## What Bothy decided, and why

- **A not-found route exists**, renders inside the shell, shows the bad path and
  links home. It was added after a typo'd deep link silently rendered the
  Overview, which made a broken link look like it had worked.
- **Partial failure is the normal case.** The data layer uses settled promises,
  never all-or-nothing. The route table is the skeleton, container data is
  enrichment, disk sizes are a pure overlay. The page names which source is
  missing rather than hiding what still works.
- **A both-upstreams-down floor.** If everything fails, the page still renders a
  static list of known service names with working links. If the data API is down
  but a dashboard is fine, its link must still work.
- **Never clear on failure.** A failed poll bumps a counter and keeps the last
  good data; the freshness pill goes amber and states the age. A stale page with
  working links beats a blank one.
- **Metrics degrade to a sentence.** With no metrics route the vitals section is
  replaced by one line naming the command that would enable it — never an empty
  chart frame.
- **A dangling route is shouted about**, not hidden. A route with no backend is
  exactly what this page exists to surface.
- **No WebGL, or reduced motion, falls back** to a static layered diagram rather
  than an empty canvas.

**Known gap:** there is no error boundary. A render crash still takes the page
down. Tracked in
[reference/open-questions.md](../reference/open-questions.md).

## Dead ends

- **Clearing data on a failed poll.** Produced a blank page during a transient
  failure — the exact moment the page is most needed.
- **Rendering the home page for an unknown route.** Made broken links invisible.
- **An animation system that defaulted content to invisible.** The canonical
  blank-page failure; see [motion](../foundations/motion.md).

## How this is verified

- Load a bad URL and assert the not-found page renders with the bad path intact.
- Block each upstream in turn and confirm the page degrades rather than blanks.
- Remove the metrics route and confirm the vitals section states the reason.
