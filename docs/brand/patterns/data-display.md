# Data display and tables

_Status as of 2026-08-10._

## The rule

**State the row height and the reason.** Vertical padding that carries no
information is a cost paid on every row.

**A sticky header requires a bounded max-height on its scroll container.** This
is the one that surprises people: `position: sticky` on a `th` only works if the
wrapper is itself the scroll container. With no height cap the wrapper never
scrolls, the *page* scrolls, and the header simply scrolls away and never comes
back — looking exactly like sticky is unsupported.

**Sortable headers are controls.** Keyboard-activatable, `aria-sort`, and a
visible direction indicator.

**The default sort on anything about health is exception-first.** Alphabetical
order is a filing decision; on a status page the thing that is wrong goes first.

**Numbers right, text left, nothing centred.** Numbers get tabular figures.

**"Nothing here" and "nothing matches" are two states.** Different message, and
only the second offers to clear a filter.

**A clickable row still contains a real link**, so it can be middle-clicked,
copied and opened in a new tab.

**Say when the data was last updated.** A table of live data with no freshness
signal invites someone to trust a stale screen.

## Checklist

See [CHECKLIST.md § 15](../CHECKLIST.md#15-data-display-and-tables).

## What Bothy decided, and why

- **32px rows** — 6px padding plus a 20px line box. The previous 47px rows meant
  the routes table needed two viewports to show 21 routes, and the extra 15px per
  row carried nothing.
- **The scroll wrapper has a max-height**, which is what makes the sticky header
  work at all. The comment explaining that lives beside the rule, because the
  failure mode is invisible.
- **Exception-first sorting** on the system matrix and the attention list.
- **The scroll container is focusable** with a region label, so a keyboard user
  can scroll it.
- **Filtered-empty names the active filters** and offers a clear; genuinely-empty
  does not.

## Dead ends

- **A sticky header without a height cap.** Looked implemented, did nothing.
- **47px rows.** Halved the visible content for no information.

## How this is verified

- Assert every sticky-header table's scroll container has a bounded height.
- Assert `aria-sort` is present and correct after a sort.
- Assert the two empty states render different messages.
