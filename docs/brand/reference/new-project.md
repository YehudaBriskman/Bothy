# Starting a new project

_Status as of 2026-08-10._

The same items as [CHECKLIST.md](../CHECKLIST.md), ordered by when they block
you rather than by category. Work down it. Anything you skip, write down that
you skipped it and why.

## Day 0 - before the first component

These are the ones that are cheap now and expensive to retrofit.

**Identity**

- Pick a name and **check it is not taken** - as a software project, on the
  package registries you would publish to, and as a product. Record where you
  looked and the date.
- Write the one-line description. Use the identical string in the page
  description, the manifest and the repository description.
- Choose three voice adjectives and three anti-adjectives.
- Add a licence.

**Colour, before any component exists**

- Copy the token block from [tokens.md](tokens.md) as a starting shape: four
  surface steps, three foreground steps, two line weights, an accent set, a
  reserved status set, a chart palette.
- Pick your accent and your status hues.
- **Measure the contrast and record the numbers beside the tokens**, at the
  smallest size each is used at.
- **Run the chart palette through the five checks**, per theme. Do not eyeball
  it.
- Write the two reserved-colour rules somewhere the team will see them.

**The document shell**

- Language, character set, viewport (zoom not blocked).
- The pre-paint theme stamp, and one `theme-color` per scheme.
- `color-scheme` per theme.

**The accessibility floor**

- Skip link as the first tab stop.
- Landmarks, one `h1` per page.
- A global `:focus-visible` ring.
- A reduced-motion block that collapses durations and hides nothing.
- A `forced-colors` block.

**The scales you will otherwise never have**

- A closed spacing scale.
- A closed type scale.
- A named z-index ladder.

Bothy has none of these three, and adding them later is the largest outstanding
item in its own system. This is the single most valuable thing on this page.

## Day 1 - before the second screen

**Icons and platform**

- Define the mark as one set of coordinates, and generate every raster from it
  with a checked-in script.
- Ship: SVG favicon, 180px touch icon, 192 and 512 PNGs, **a maskable icon**.
- A manifest with name, short name, description, **id**, start URL, scope,
  display, and colours equal to the token values.

**The states, before you need them**

- Empty state, filtered-empty state, error state with retry, shape-matched
  skeleton, partial state.
- A not-found route that keeps the shell and shows the bad URL.
- **An error boundary.** Bothy does not have one; do not repeat that.

**The data shape**

- One shared poll or query layer, not per-component fetches.
- Settled promises, never all-or-nothing: decide which source is the skeleton
  and which is enrichment.
- Never clear data on a failed refresh.

## Before the first link you share with anyone

- A unique title per route.
- A description per route, and Open Graph tags with a social image.
- A `robots.txt` stating the policy, including "do not index" if that is the
  policy.
- Security headers, and a secret scan in CI.
- No credential committed - generate and gitignore anything that must carry one,
  and make the committed example **comments-only** if a loader merges the
  directory.
- An accessibility audit with zero serious findings.
- A pass at the narrowest supported width with no horizontal scroll.
- A keyboard-only pass of the core flows.
- Screenshots in both themes, at your declared widths.

## Before a second person touches it

- Start the decision log. Record alternatives and dead ends, not just outcomes.
- Start the open-questions table, and put the things you skipped above into it.
- Name the owner of the token file.
- Write the definition of done for an interface change.

## The five rules worth carrying over verbatim

1. **Colour is never the only encoder.**
2. **Blank is not a state.** Every failure path renders something.
3. **Entrance animations start from a visible resting state**, so a handler that
   never runs cannot hide content.
4. **Every verification must be able to fail.** Break it deliberately and watch
   the check go red before you trust it.
5. **A front-end change is not done until a real screenshot of it exists.**
