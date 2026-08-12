# Print

_Status as of 2026-08-10._

## The rule

**Decide whether print is in scope, and write the answer down.** "Out of scope"
is valid and common. What is not valid is having no answer, because the default
behaviour is to print the screen - including fixed chrome overlapping content,
a dark background that empties a toner cartridge, and every inner scroller
clipped to its first visible rows.

If it is in scope:

- Remove fixed chrome, navigation, scroll rails and scrollbars.
- Force the light palette on white.
- Expand truncated text and inner scrollers to their full content - this is the
  one people forget, and it means a printed table silently loses most of its
  rows.
- Avoid page breaks inside cards and rows; repeat table headers across pages.
- Check charts are legible in greyscale.

## Checklist

See [CHECKLIST.md § 27](../CHECKLIST.md#27-print).

## What Bothy decided, and why

**Out of scope, explicitly.** There is no print stylesheet.

The reasoning: the product is a live view of machine state. Its value is that it
is current, and a printed copy is stale the moment it leaves the printer.
Nothing in it is a document, a report or a record. Anything worth keeping is
better captured as a screenshot with a timestamp.

**The consequence is accepted:** printing the page today produces the dark
interface with its fixed topbar and clipped scrollers. If that ever becomes a
real need, the list above is the work.

## Dead ends

None recorded.

## How this is verified

Not verified - out of scope. If it comes into scope, print to PDF and look at
it, which is the only check that works here.
