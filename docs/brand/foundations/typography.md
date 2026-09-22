# Typography

_Status as of 2026-08-10._

## The rule

**Two family tokens: one sans, one mono.** No component names a family
directly.

**Default to a system stack.** A webfont costs bytes, a render-blocking
request and a layout shift, and buys a look. If you add one it must be
self-hosted, subset, preloaded, swap-configured, and inside the byte budget in
[performance](../quality/performance.md).

**Close the type scale.** Enumerate the sizes and the role of each. A size that
is not on the list is a defect, not a judgement call. An open scale is how a
product ends up with seventeen font sizes that nobody chose.

**Tabular numerals on every number that updates, is compared, or sits in a
column.** Proportional digits make a counter jitter as it changes and make a
column of numbers fail to align - both are distracting in exactly the places
numbers matter.

**Mono is for identifiers only** - hostnames, ports, paths, container names,
keys, hashes. Mono for prose is a costume; mono for an identifier is a signal
that the string is exact and copyable.

**Cap the measure.** Prose beyond about 90 characters per line is measurably
harder to read.

**Every truncation needs an escape** - a title, a tooltip, or a detail view
that shows the full value. A truncated string with no way to see the rest is
lost data.

## Checklist

See [CHECKLIST.md § 6](../CHECKLIST.md#6-typography).

## What Bothy decided, and why

- **System stacks, no webfont.** Zero font requests. The product is a dashboard
  on a personal box; a typeface would cost real bytes for no information.
- **Tabular numerals** on stat cells, table numbers, chart axes and readouts.
- **Mono** for hostnames, ports, paths, volume names, container ids and log
  lines.
- **Break-anywhere wrapping** is used only for opaque identifiers, never prose.

**Closed 2026-09-22 (design audit batch 2).** Nine rem steps - `--fs-2xs` 11px
through `--fs-2xl` 28px and a clamped `--fs-display` - each with its own
`--lh-*` leading and `--tr-*` tracking (positive on the smallest, negative on
display), five weights, `--label-tracking` and one `.eyebrow` class. The root is
never given a px size, so the browser's text setting reaches every step. The
shared primitives use the scale now; the rest of the app moves page by page in
batch 4. Form controls inherit the type (a Services heading was rendering in
Arial). The table is in [reference/tokens.md](../reference/tokens.md).

**Migrated 2026-09-22 (design audit batch 4).** Every font size in the app is
a scale token now - 420 px declarations moved to the nearest step, each with
its step's leading and tracking (uppercase labels take `--label-tracking`).
40 distinct sizes became the 8 steps in use, and 421 px font sizes became 2:
the chart tick labels (an SVG laid out in JS px) and the 3D nameplates
(scaled by the scene), both at a step's px value. Inline code keeps an `em`
size relative to its text. The reader's sizes are rem tokens on the scale,
and the reading-size setting writes rem, so the browser's text size reaches
the document too. The measure is capped again at `75ch`, as the column's
padding (see `--read-measure` in index.css). Weights 550/650/750 are gone.
`checks/design-tokens.mjs` §9 fails on any size, weight or inline size off the
list. At a 125% browser text size every page's text scales and the layout
holds (screenshots in `~/.local/state/bothy/design-audit/batch4/`).

**Was the known gap.** There was no declared type scale. Seventeen distinct font sizes
are in use, from 10.5px to 68px, chosen individually. This is the largest
outstanding item in the foundations and is tracked in
[reference/open-questions.md](../reference/open-questions.md). The suggested fix
is to close the list to roughly nine steps and migrate.

## Dead ends

None recorded. This area was never wrong in an interesting way; it is simply
under-specified, which is a different problem.

## How this is verified

- Grep for font-family declarations outside the token block.
- Once a scale exists, grep for sizes not on it.
- Check the layout at 200 percent zoom and with a user font-size override.
