# Shape and elevation

_Status as of 2026-08-10._

## The rule

**A radius ladder, mapped to size classes.** Small radii for chips and inline
controls, medium for buttons and inputs, larger for panels and cards, full for
pills. A numeric literal in a component means the ladder was ignored.

**One border-width token.** Mixed hairline widths read as a rendering bug.

**Shadow recipes are theme-specific.** A shadow is not "black at low alpha" - on
a dark surface that is nearly invisible, and on a light surface a dark-theme
shadow reads as dirt. Declare a recipe per theme.

On dark themes a shadow alone cannot separate a surface from its background,
because there is not enough contrast beneath it to cast onto. Pair it with an
inset hairline.

**Map each shadow step to a meaning**: at rest, lifted on hover, floating
overlay. Three steps is enough.

**Shadows never indicate state.** Elevation is depth, not health.

**Elevation must not vary with page position.** If the ladder sits on a tinted
or position-dependent backdrop, the same card is a different colour in different
places, which defeats the ladder. See [colour](colour.md).

## Checklist

See [CHECKLIST.md § 8](../CHECKLIST.md#8-shape-and-elevation).

## What Bothy decided, and why

- **Five radius steps**, from extra-small through full, mapped to size classes.
- **One border width.**
- **Three shadow steps per theme.** The dark recipes include an inset white
  hairline for the reason above; the light recipes use a dark-blue-grey rather
  than black, because pure black on white reads as grime.
  _2026-09-21 (design audit decision 8): a fourth step is added for modal
  surfaces - dialog, drawer, palette. **Done 2026-09-22:** `--shadow-1` rest,
  `-2` raised, `-3` popover, `-4` modal, mixed from `--shadow-color` (whose alpha
  is the strength) and `--shadow-hairline`. A theme sets those two colours and
  `--scrim`, never the geometry. `--scrim` darkens the page in every theme -
  in light it used to be 72% of white._
- **Surfaces are opaque.** The backdrop blurs that used to sit on every card were
  removed along with the surface transparency on 2026-08-10 - with an opaque
  surface a blur is a no-op that still costs compositing. The only remaining
  blurs are the sticky topbar and the command-palette scrim, where translucency
  is the actual effect.
  _2026-09-21 (design audit decision 4, owner-approved): translucent material is
  allowed on exactly two surfaces, the top bar and the command palette, and each
  needs a solid fallback under `prefers-reduced-transparency: reduce`. Every
  other surface - cards, dialogs, menus, the drawer - stays opaque, and the
  dialog overlay's undocumented blur is to go (batch 2, SYS-12)._

## Dead ends

- **Semi-transparent surfaces over a coloured glow.** Covered in
  [colour](colour.md); the consequence for elevation is that the ladder stopped
  being a ladder.
- **A hardcoded black shadow shared by both themes.** It was the only
  token-independent colour in the background system and it washed the top of
  every page grey in light mode.

## How this is verified

- Grep for numeric radius and border-width literals.
- Grep the light palette for a hardcoded black shadow.
