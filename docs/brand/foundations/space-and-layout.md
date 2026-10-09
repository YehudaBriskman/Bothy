# Space and layout

_Status as of 2026-08-10._

## The rule

**One closed spacing scale.** Every gap, padding and margin comes from it. The
value of a scale is not that the numbers are prettier; it is that "how much
space goes here" stops being a decision made 400 separate times.

**One content width per layout family.** If two different maxima exist, they
disagree about how wide the product is, and the disagreement shows up as a
misaligned edge somewhere.

**Name the z-index ladder.** Numeric literals scattered across files are how you
end up with a tooltip behind a dialog. Enumerate every layer and every sticky
element with its offset.

**Grids should be content-driven.** A minimum column width and automatic fill
adapts to the container it is in; a breakpoint guesses at a width the component
may not have been given.

**Dashboard cards need a tile unit.** Columns can be content-driven; *heights*
must not be. If each card sizes to its own content, a four-row list beside a
nine-row list puts the row's bottom edge wherever the taller one happens to end,
and a grid of cards stops reading as a grid. Declare one tile height, make every
card exactly one unit or an exact multiple, and let a card that needs more room
span two - so it still lands on the same baseline.

The corollary is that **a card's footer is structural, not decoration.** A card
with a summary strip is taller than one without, so either every card in a row
has one or none does. This is why a chart with a legend and a chart without were
visibly different heights until both got a footer.

**`min-width: 0` on flex and grid children that contain truncatable text.**
Without it the default minimum content size stops the child from shrinking, and
the text overflows instead of ellipsing. This is the single most common
mysterious-overflow bug in flex layouts.

**Apply the footprint rule.** See [principles](principles.md). A full-width row
must carry at least three information dimensions.

**Do not let layout depend on a JavaScript-measured height.** A measurement race
is a layout bug waiting for a slower device.

**A grid of equals needs a primary, and the reader picks it - but nothing
moves.** A strip or a card row whose cells are uniform by construction has no
most-important thing, so one is marked. Two rules come with it, and both are
about the same failure:

- **The choice is the reader's and it persists.** Never derived from the numbers.
  A dashboard that promotes whatever is currently worst re-draws itself under the
  reader, and the thing they came for is wherever the box's mood put it - which
  is this document's own rule about layout depending on measured state, arriving
  by a different door.
- **The emphasis is contrast, not geometry.** A spine, a step of surface, the next
  type step. Not a wider cell: the row's worth is that its cells share one shape
  and can be read against each other, and a cell of a different size has left that
  set. A degraded metric is badged where it stands and does not move.

See [reference/decisions.md](../reference/decisions.md), 2026-10-07, for the
rejected two-column version and what it would have cost.

## Checklist

See [CHECKLIST.md § 7](../CHECKLIST.md#7-space-and-layout).

## What Bothy decided, and why

- **Grids are content-driven** throughout, with the minimum column width chosen
  per density - for example the vitals charts use a 280px minimum, because below
  roughly 900px three charts sharing the width put their axis labels on top of
  each other.
- **One tile unit, `--tile: 316px`**, on the Overview's card grid, with
  `grid-auto-rows` and an `is-tall` modifier that spans two. Added 2026-08-10
  after the dashboard row read as ragged: the panels were `align-items: start`
  with a `max-height` on their bodies, so all three ended at different heights.
  Every card also gained a footer strip in the same change, which pins the bottom
  edge and carries a summary of what is in the card.
- **The footprint rule is applied literally** on the Overview: one service is
  one cell, one system is a name plus a row of cells. See
  [principles](principles.md) for the measurement that produced the rule.
- **Safe-area insets** are a known gap - most fixed chrome does not yet apply
  them. Closed for the two surfaces at the bottom of the screen (2026-10-08): the
  update activity dock and the "Bothy updated" banner both add
  `env(safe-area-inset-*)` to their offsets, because a round target in a phone's
  bottom corner is exactly where a home indicator or a rounded corner eats it.
  The top bar and the scroll rail still do not.

**Known gaps**, tracked in
[reference/open-questions.md](../reference/open-questions.md):

- **~~No spacing scale.~~ Closed and migrated 2026-09-22.** `--sp-0_5` 2px
  through `--sp-16` 64px, rem: every 2px to 16, then 4 and 8. `--sp-3_5`
  (14px) joined in batch 4 because it was the most common off-grid value - the
  inset of nearly every panel. Every padding, margin and gap in the app is a
  step (975 literals were); the one literal left is a 1px hairline nudge.
  Indents that must line up with a px icon are `calc()`s of the tokens they
  depend on, in CSS and in the inline styles that indent trees.
  `checks/design-tokens.mjs` §9 holds it.
- **Two content widths disagree** - a 1180px wrap token and a 1320px content
  maximum. One of them should win, or each should be given a named role.
- **The z-index ladder is half named.** Four tokens - `--z-activity` 70 (the
  fixed status surfaces: the update banner and the activity dock, added
  2026-10-08), `--z-modal` 90, `--z-popover` 95, `--z-tooltip` 96 - and the
  page's own chrome still literal: the top bar 20, the scroll rail 30, a sticky
  table head 1, the skip link 100. `checks/a11y-contract.mjs` § 5 fails any new
  literal at 40 or above, with the skip link as the one exception, so the
  remaining literals cannot grow upwards into the floating range.

## Dead ends

- **A 236px sidebar.** Deleted. It carried five navigation items and measured
  roughly 793 pixels of empty column beneath them - about 13 percent of the
  viewport width spent on nothing, at every width, on every page. Five
  destinations is a topbar's job. Deleting it also deleted the mobile drawer, the
  scrim, the hamburger and a focus-order workaround, which is the more general
  lesson: a layout choice drags a whole responsive branch behind it.

## How this is verified

- Grep for spacing literals once a scale exists, and for numeric z-index values.
- Assert no horizontal page scroll at any width in the support range.
