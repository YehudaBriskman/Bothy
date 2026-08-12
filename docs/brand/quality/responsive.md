# Responsive and touch

_Status as of 2026-08-10._

## The rule

**A closed breakpoint set.** A media query at a width that is not on the list is
a defect. Overlapping breakpoints with unclear intent are how a layout becomes
impossible to reason about.

**Prefer content-driven layout.** A grid with a minimum column width adapts to
the container it actually got; a breakpoint guesses at a viewport. Add a
breakpoint only where content genuinely cannot decide.

**Drive behaviour by measurement where you can.** Whether a row of items
overflows is a fact you can measure, and it depends on how many items there are -
not only on the viewport.

**Test at real widths:** 320, 360, 390, 768, 1024, 1280, 1440, 1920. And assert
no horizontal page scroll at the narrowest.

**Target sizes:** 24x24 minimum, 44x44 for frequent or primary actions, with
separation between adjacent targets.

**Every hover-only affordance needs a focus and touch equivalent.**

**Never block zoom.** No `user-scalable=no`, no `maximum-scale`.

**Use dynamic viewport units** where the mobile URL bar changes the viewport,
and apply safe-area insets to fixed chrome.

**Downgrade heavy content on small and low-power devices.**

## Checklist

See [CHECKLIST.md § 19](../CHECKLIST.md#19-responsive-and-touch).

## What Bothy decided, and why

**The navigation uses both approaches, because they solve different problems.**
Below roughly 1080px the labels collapse and expand on hover or focus - that is a
density decision and a breakpoint is the right tool. Independently, the row
scrolls horizontally with an edge fade *whenever it actually overflows*, which is
measured. A box with four destinations and a box with twelve behave correctly at
the same width without a second breakpoint.

**Other decisions:**

- Below roughly 900px the brand text and the freshness pill are dropped and the
  search trigger collapses to its icon.
- Below 560px the topbar tightens and the scroll rail is hidden - 3px of
  decoration on a 360px screen is not worth the width.
- Chart grids use a 280px minimum column, because below roughly 900px three
  charts sharing a row put their axis labels on top of each other.
- Verified: no horizontal page scroll at 380px, and the nav overflow fade
  correctly swaps sides when scrolled.

**Known gaps**, tracked in
[reference/open-questions.md](../reference/open-questions.md): four breakpoints
are in use (560, 640, 900, 1080) and two of them overlap in intent; dynamic
viewport units and safe-area insets are not used.

## Dead ends

- **A mobile drawer.** It came with the sidebar and was deleted with it, along
  with its scrim, hamburger and focus-order workaround. A denser topbar replaced
  the entire responsive branch.
- **`display: none` to hide nav labels.** It cannot be animated, which is why the
  labels collapse by width instead.

## How this is verified

- Assert no horizontal page scroll at the narrowest supported width, per route.
- At a narrow width, assert the nav overflows and the fade is on the correct
  side before and after scrolling.
- Screenshot at each width in the list above.
