# Scrolling

_Status as of 2026-08-10._

What happens when there is more content than fits. Four separate concerns:
position across navigations, knowing there is more, the scrollbar itself, and
progress through the page.

## The rule

### 1. Position across navigations

**A new navigation starts at the top. Going back returns you to where you
were.** That is what the browser does with real documents and what everyone
expects.

A single-page app breaks this by default, and the failure is subtle: nothing
resets the offset, so arriving at a page puts you wherever the *previous* page
was scrolled to. Scroll a long list to the bottom, click a row, and the detail
page opens 800 pixels down - on a page you have never scrolled. Worse, if the
new page is shorter the browser clamps, so the same click lands somewhere
different depending on what you were looking at before.

Take manual control of the browser's own scroll restoration while the app owns
it, and hand it back on unmount.

**Two traps, both of which produce a feature that looks implemented and is
not:**

**Trap 1 - the restore is clamped by a page that has not grown yet.** At the
moment you restore, the incoming page may not be as tall as it was when you
left. If the target is 509 and the document is momentarily 445 tall, the browser
clamps and the restore silently half-works. Re-apply for a few frames until it
sticks, with a deadline, and give up if the user starts scrolling - a restore
that keeps yanking the page back is worse than one that misses.

**Trap 2 - the programmatic scroll overwrites the value you are saving.** This
one is vicious. Scroll events are dispatched *asynchronously*, and a framework
typically runs passive effects after paint. So the scroll event caused by your
own reset-to-top arrives while the save listener is still associated with the
page you just left, and writes 0 over the offset you were about to need. The
symptom is that Back "restores" the top of the page and looks like the feature
never ran.

The fix is to track the current location in a mutable ref updated *before* the
programmatic scroll, so a stray event is attributed to the page being arrived at
- where 0 is the truth - rather than the one being left.

### 2. Knowing there is more

Put an inner shadow on the edge a container can still travel toward. Without it
a clipped list is indistinguishable from a complete one, which is the most
common reason people miss content in a fixed-height panel.

**It must be an inset shadow on the border box.** An absolutely positioned child
inside a scroll container scrolls away with the content - it would slide out of
view exactly when it became true. An inset shadow paints on the border box,
which does not move.

Two details that bite:

- **The neutral value must be a fully transparent shadow**, not `none` and not
  `0 0`. `0 0` resolves its colour to the current text colour and paints a hard
  ring.
- **An axis counts as scrollable only if it overflows *and* its computed
  overflow permits scrolling.** A horizontal scroller with `overflow-y: hidden`
  and a couple of pixels of vertical padding reports a vertical overflow it can
  never act on - and gets a permanent shadow across its bottom edge.

### 3. The scrollbar

Style it for both engines: the standard properties for one, the pseudo-elements
for the other. They are not alternatives, they are different rendering engines.

A hidden scrollbar is acceptable only where another affordance replaces it.

### 4. Progress

Optional. If present, hide it when the page does not scroll, and animate it with
a transform rather than a height - height is a layout property and would relayout
on every frame of a scroll.

## Checklist

See [CHECKLIST.md § 18](../CHECKLIST.md#18-scrolling).

## What Bothy decided, and why

- **Restoration** is implemented in `lib/scroll.ts`, mounted once by the shell.
  Both traps above were hit and fixed there; the comments in that file are the
  primary record.
- **Positions are indexed twice** - by history key and by path. The key is the
  right primary index because it distinguishes two visits to the same URL, but a
  hash router synthesises a default key for any entry it did not create itself,
  and those keys do not round-trip. Writing both and reading key-then-path
  survives it.
- **Edge shades** are driven by data attributes set from one document-level
  observer, so any scroller anywhere is covered by adding a class.
- **Scrollbars** are styled once, globally. Two earlier per-element copies had
  already drifted to different widths and thumb colours.
- **The progress rail** is a 3px accent gradient down the **left** edge. Left,
  not right, so it does not sit under the native scrollbar and read as a second,
  disagreeing scrollbar. Hidden entirely when the page does not scroll, and on
  small viewports where 3px of a 360px-wide screen is not worth it.

## Dead ends

- **A positioned overlay for the edge shade.** Scrolls away with the content.
- **`box-shadow: 0 0` as the neutral value.** Paints a ring in the text colour.
- **Trusting `scrollHeight - clientHeight` alone** to decide an axis is
  scrollable. Measured: it put a permanent shadow under the topbar.
- **Re-binding the save listener per route.** This is what creates trap 2.

## How this is verified

Assert all of these in a real browser, on a genuinely fresh load:

- A new navigation lands at 0.
- One-step Back restores the exact previous offset.
- Two-step Back restores the exact offset from two pages ago.
- A shade appears only on a side with somewhere to go, and only on an axis that
  can scroll.

**Verify against a fresh load.** A hash-only navigation is a same-document
navigation: it does not re-request anything, so the app keeps running the
bundle already in memory. Re-testing a fix that way will faithfully reproduce
the bug you just fixed. Change the path, or force a reload.
