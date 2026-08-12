# Motion

_Status as of 2026-08-10._

How long, what easing, and what happens when a user asks for less of it.

## The rule

**Three durations and one easing curve, as tokens.** Fast for colour and hover,
standard for transform and elevation, slow for a page transition. A literal time
value in a component is a defect.

**Animate only compositable properties** — transform, opacity, filter.
Animating height, width, top or margin forces layout on every frame.

**The invariant that matters more than all of the above:**

> **Every entrance animation must start from a visible resting state.**

If an element's default style is `opacity: 0` and something else is responsible
for turning it on, then any failure of that something — a handler that does not
run, an observer that does not fire, a browser that skipped the animation —
leaves the content permanently invisible. And invisible content looks exactly
like content that was never rendered.

This is not theoretical. See the dead ends below; it shipped a blank page twice.

**Reduced motion collapses duration; it never hides.** A `prefers-reduced-motion`
block that sets `display: none` or `opacity: 0` on anything is the same bug in a
different costume. The correct shape is to shrink durations to near zero and
leave everything visible.

**Cap stagger.** A per-item delay multiplied by the index means item 60 waits
two seconds. Clamp the multiplier.

## Checklist

See [CHECKLIST.md § 9](../CHECKLIST.md#9-motion).

## What Bothy decided, and why

- **Tokens:** 120ms for hover and colour, 180ms for transform and elevation,
  260ms for the page transition, on one shared easing curve.
- **Page transitions** are a short fade and rise keyed on the path, with the
  outgoing page finishing before the next mounts so pages never overlap.
  Reduced motion collapses the offset to a plain fade.
- **Entrance animations belong to the components** and animate from a visible
  resting state, so a handler that never runs cannot hide anything.
- **Stagger is clamped** so a long list does not tail off into a wait.
- **The global reduced-motion block carries a comment** stating that nothing in
  it may hide content — because the obvious "fix" when killing transitions is to
  reach for a property that does.

## Dead ends

**The `Reveal` component, deleted 2026-07-29, and it must not come back.**

It defaulted content to `opacity: 0` and relied on an intersection observer to
switch it on. Anything the observer missed stayed invisible forever. It shipped
a near-blank page twice — most recently the entire Overview dashboard, roughly
700 pixels of panels, vanished on every *warm* return to the page, because it
renders below the fold and nothing re-checked. Cold loads escaped only by luck:
the first paint has no data, so the page was short enough for the panels to
start on screen.

Two things make this the most instructive failure in the system:

1. **The failure mode is silent and total.** Blank is not a state anyone tests
   for, and a DOM-only test cannot see it — jsdom has no layout, so "blank" and
   "perfect" are identical to it.
2. **The fix was structural, not a patch.** The rule "animate from a visible
   resting state" removes the entire class of bug, whereas fixing the observer
   would have left the next observer free to fail.

Also rejected: **a reduced-motion block that hides things.** The original one
had to be patched to force `opacity: 1`, which is the tell that the design was
inverted to begin with.

## How this is verified

- Grep for literal time values in transitions and animations, and for animated
  layout properties.
- Grep for any visibility gated on an intersection observer.
- Load every route with reduced motion emulated and assert each one still
  renders its content. This is the assertion that would have caught the blank
  page.
