# Iconography

_Status as of 2026-08-10._

## The rule

**One icon library, pinned.** Mixing two sets is immediately visible — stroke
weights and optical sizes do not match — and it doubles the bundle.

**No emoji as interface iconography.** Emoji render differently per platform,
cannot inherit colour, cannot be sized reliably, and are read aloud by screen
readers with names you did not choose.

**Icons inherit the current colour.** A hardcoded fill is a token violation and
breaks in forced-colours mode.

**Decorative versus meaningful is a real distinction.** A decorative icon beside
a text label is hidden from assistive technology. An icon that *is* the control
needs an accessible name, and an icon-only control needs a tooltip as well —
sighted users need the name too.

**Every status needs a distinct glyph, not just a distinct colour.** This is
where the colour-is-never-alone rule becomes concrete. Unit-test the mapping for
uniqueness, because two statuses quietly sharing a glyph is invisible in review.

**The icon mapping is a data table, not a conditional chain**, and specific
product names are matched before vendor names — otherwise a rule for "google"
swallows "google-cloud-storage".

**Always have a fallback glyph**, so an unmapped entity renders as something
rather than as a gap.

## Checklist

See [CHECKLIST.md § 10](../CHECKLIST.md#10-iconography).

## What Bothy decided, and why

- **lucide only**, pinned. Chosen for a consistent stroke weight and a
  tree-shakeable per-icon import.
- **No emoji.** The original portal used emoji for service icons; they were
  replaced. Container labels can still supply one, and that is a legacy affordance
  rather than a recommendation.
- **Status glyphs are distinct** per state and paired with the reserved status
  colours — never colour alone.
- **The service-icon mapping is a table** matched most-specific-first.
- **Three container sizes** — small, default and large — with the glyph size
  chosen per call site.

## Dead ends

- **Emoji as service icons.** Inconsistent across platforms, uncontrollable
  size, and unhelpful screen-reader output.

## How this is verified

- Grep the emoji unicode ranges in source.
- Grep for hardcoded fill and stroke colours in icon components.
- Unit-test that no two statuses share a glyph.
