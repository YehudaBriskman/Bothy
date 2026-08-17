# Navigation and information architecture

_Status as of 2026-08-10._

## The rule

**Keep a route table** and assert it matches the router.

**Mark the current location differently from a control.** `aria-current` plus a
visual marker that reads as a statement rather than an invitation. See
[component-states](component-states.md).

**No dead ends.** Every detail page has a way back up.

**An unknown route renders a not-found page**, and leaves the bad URL in the
address bar. Silently rendering the home page at a typo'd URL makes a broken
link look like it worked.

**Deep links must survive.** If a URL has ever been shared, breaking it is worse
than carrying a redirect forever.

**Drive overflow behaviour by actual overflow, not by a width breakpoint.** A
breakpoint guesses; a measurement knows. The same width with four nav items and
with twelve needs different treatment.

**A search affordance that opens a surface is a button**, not an input. An input
that pushes a route per keystroke fills the history with one entry per character.

**Decide whether filter and tab state lives in the URL.** It determines whether
a view is shareable, and it is very hard to retrofit.

**The skip link is the first tab stop** and becomes visible on focus.

## Checklist

See [CHECKLIST.md § 13](../CHECKLIST.md#13-navigation-and-information-architecture).

## What Bothy decided, and why

- **Three destinations in a topbar** (2026-08-17, was four). Five is roughly
  where a topbar stops working, but the count was never the real rule. The rule
  is that **a top-level slot belongs to a DATASET, not to a view of one**:
  Services, Access and Topology were three renderings of the same merged node
  list and held three slots, while Files - a different dataset entirely - held
  one. They now sit behind `Control`, which owns that dataset and navigates
  itself. Overview · Control · Files.
- **The current item is underlined**, not filled.
- **Responsive behaviour is a hybrid**, because the two problems are different.
  Below roughly 1080px the labels collapse to zero width and expand on hover
  *and* keyboard focus - focus matters as much as hover, or a keyboard user tabs
  through four unlabelled squares. Independently, whenever the row actually
  overflows it scrolls horizontally with a fade on whichever edge has more
  content. The fade is driven by measurement, not by a breakpoint. A `title`
  attribute is the third fallback, for touch, where neither hover nor focus
  fires.
- **Two retired routes keep permanent redirects.** They were bookmarked and
  linked from notes, and a dashboard people deep-link into should not break those.
- **Tab state lives in the query string** on the merged access page, so a view is
  shareable.
- **The command palette** opens on the platform shortcut or `/`, keeps focus in
  its input, drives selection with `aria-activedescendant` so arrow keys never
  move focus, closes on Escape, and returns focus to whatever opened it.
- **A single-key refresh shortcut** is guarded so it is not swallowed while
  typing in any input.

## Dead ends

- **A sidebar AS THE TOP-LEVEL NAVIGATION.** See
  [space-and-layout](../foundations/space-and-layout.md). Still a dead end, and
  worth keeping distinct from what shipped on 2026-08-17: a sidebar *within a
  section*, subordinate to a topbar entry. The rejected version competed with the
  topbar for the same job; this one does a job the topbar cannot do, which is
  hold the five-odd destinations of one dataset without spending five top-level
  slots on them. Bothy Files had already proved the pattern.
- **A search input in the topbar that routed on every keystroke.** One history
  entry per character.
- **Rendering the Overview for an unknown route.** A typo'd deep link looked
  like it had worked.

## How this is verified

- Assert the skip link is the first tab stop and becomes visible on focus.
  **This item was listed and not actually verified, and it hid a real defect for
  months.** Under `HashRouter` the fragment IS the route, so `href="#content"`
  set `location.hash = "content"`, which react-router resolved to `/content` -
  the not-found page. The application's first tab stop navigated away from the
  application. Found 2026-08-17 while restructuring the nav. An item on a
  checklist is a claim; only a check is evidence.
- Assert the current item carries `aria-current`.
- Crawl for detail pages with no way back.
- At a narrow width, assert the nav overflows, that the fade appears on the side
  with more content, and that it swaps when scrolled to the other end.
