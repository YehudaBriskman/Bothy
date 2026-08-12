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
- **Surfaces are opaque.** The backdrop blurs that used to sit on every card were
  removed along with the surface transparency on 2026-08-10 - with an opaque
  surface a blur is a no-op that still costs compositing. The only remaining
  blurs are the sticky topbar and the command-palette scrim, where translucency
  is the actual effect.

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
