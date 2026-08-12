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

**Known gap.** There is no declared type scale. Seventeen distinct font sizes
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
