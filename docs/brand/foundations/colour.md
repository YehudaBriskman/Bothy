# Colour

_Status as of 2026-08-10._

What colours exist, what each one is for, and how you prove they are legal.

## The rule

Colour in an interface does five separate jobs, and mixing them is the single
most common way a design system rots.

| Job | What it is | Rule |
|---|---|---|
| **Surface** | The elevation ladder - page, card, header, popover | A fixed number of named steps. No component invents an in-between. |
| **Status** | State: up, warn, down, unknown, off | Reserved. Never decoration. See [principles](principles.md). |
| **Chrome accent** | Telling panels apart | Decoration. Never encodes state. |
| **Chart series** | Identity in a graph | A validated categorical palette, assigned by fixed slot order. |
| **Brand** | The product's own mark | Identity. Not chrome, not state, and not the accent. |

### Brand is its own job, and the mistake is subtle

The brand mark is the easiest of the five to get wrong, because pointing it at
the accent looks like good token hygiene. It is not: the accent's job is "this is
interactive", and every theme is entitled to repaint it. Point the mark at it and
the one element on the page whose whole purpose is to say *which product this
is* restates whichever hue the current theme picked for its buttons. Bothy's
wordmark dot did exactly that until 2026-08-19 - it was blue on the default
theme, blue-grey on Gruvbox, and lavender on Catppuccin.

Two properties fall out of it being identity rather than chrome:

- **A brand colour is theme-tunable, not fixed.** It has to remain visible on
  every palette, and no single value does that across light and dark grounds. So
  a theme may override it - and the contrast rule measures whatever it resolves
  to, per theme, rather than blessing one hex.
- **A brand colour is exempt from the status hue-separation rule, and must be.**
  Chrome is kept 45° away from any chromatic status hue so that a coloured
  control cannot be misread as a state. A mark is never adjacent to a status
  glyph, never changes with state, and encodes nothing - so the rule protects
  nothing here, and applying it would only forbid a brand from being green.
  Write the exemption down where the rule lives, or someone will "fix" it.

### The elevation ladder

Declare four steps, not two. Systems that declare two invent the third and
fourth ad hoc, wherever a hover row or a popover needed something "slightly
lighter" - and then the same intended colour exists at five different values.

Two constraints that are easy to get wrong:

- **Surfaces should be opaque.** A translucent surface takes its colour partly
  from whatever is behind it, so the same card renders differently in different
  places on the page. That is precisely what an elevation ladder may not do.
- **No tinted, position-dependent backdrop.** A large coloured glow behind the
  page has the same effect for the same reason.

### Contrast, measured not assumed

Record the measured ratio beside every foreground token, against each surface it
is used on. Not "this looks fine" - the number.

Then re-check every muted or subtle token **at the size it is actually used
at**. A grey that passes at 16px is often being used at 11px for hostnames and
counts, where it does not.

Thresholds: 4.5:1 for body text, 3:1 for large text and for the boundary of any
component or meaningful graphic.

### The categorical chart palette

This is the part people eyeball, and eyeballing does not work. A categorical
palette has to pass five checks, per theme:

1. Every hue inside the lightness band for that mode.
2. A chroma floor, so no hue is nearly grey.
3. Adjacent-pair separation under simulated colour-vision deficiency.
4. Adjacent-pair separation under **normal** vision - the check people forget.
5. At least 3:1 against the surface the chart sits on.

Two consequences that surprise people:

- **The light and dark palettes are different selections, not tints of each
  other.** The bands differ, so the same hue cannot serve both.
- **Slot order is part of what was validated.** The checks are on *adjacent*
  pairs, so reordering the palette invalidates the result. Assign series to slots
  1, 2, 3 in a fixed order, and never cycle by array index - a filter that
  changes the series count must not repaint the survivors.

## Checklist

See [CHECKLIST.md § 4](../CHECKLIST.md#4-colour).

## What Bothy decided, and why

The full token table is in [reference/tokens.md](../reference/tokens.md). The
decisions behind it:

**The scheme is neutral, not navy.** It was repainted on 2026-08-10 to match
shadcn's dark scheme. The old surfaces were blue-tinted - the darkest card was
about 12 percent more blue than red - and every one of them was semi-transparent
over a blue radial glow. So a "grey" panel was never actually grey, the accent
had to fight its own backdrop to read as a different colour, and the same
`surface-1` card rendered differently at the top of the page than at the bottom.
Repainting fixed all three at once, and the two coloured background orbs were
deleted rather than re-tinted.

**Four surface steps**, opaque, with the backdrop blurs removed along with the
transparency. The only remaining blurs are on the sticky topbar and the command
palette scrim, where translucency is the point.

**Foreground tokens carry their measured ratios in the CSS**, per surface. The
subtle grey is deliberately lifted above the obvious choice: zinc-500 measures
3.85:1 on the card surface, below AA at the 11px sizes it is used at for
hostnames and volume counts.

**Status is a set of volumes, not a set of labels.** The page has a finite
amount of attention; anything that shouts spends budget another signal then
cannot have. Loudness is reserved for `down`. `unknown` is deliberately the
quietest of the meaningful states, because it is a statement about the portal's
knowledge, not about a service's health. `stopped` is quieter still and never
looks like a fault.

**Light mode remaps every status, and two values are deliberately off-ramp.**
Amber-500 is *lighter* than the green, which inverts the warn-versus-up weight,
so warn uses amber-600. And `unknown` uses a custom grey rather than slate-400,
which sat at nearly identical weight to `up`. Before this, `unknown` was the
only status token that had never been remapped for light: it lived in the dark
block and in neither light block, which made it the visually heaviest colour on
the light page - so light mode shouted loudest about the seven `@file` routes
that are honestly unknown rather than broken.

**Three status fills deliberately fail 3:1** in light mode (up, unknown,
stopped). That is safe only because they are large solid areas beside a track,
never a small glyph or a 1px border, and because status is never encoded by
colour alone. This is written down so that if one of them is ever used for a
glyph, the exemption is visibly void.

**The wordmark's dot is `--brand`, not `--accent`.** Split out on 2026-08-19: it
is the only piece of pure identity in the chrome, and following the accent meant
it changed colour with every theme. Green `#3fb950` on dark (7.48:1 on
`--surface-1`), stepped to `#238636` on light, where the dark green measures
2.54:1 and the dot is simply not there. The floor is 3:1 rather than 4.5:1
because it is a 4.5px filled circle - a mark, not text - and the check measures
it on `--surface-1` **and** `--surface-2`, because the header and the card are
different grounds.

**Tints come from two percentages**, declared once, replacing 53 ad-hoc mixes
that had drifted to five different fill strengths. Mixing happens in a
perceptual space because sRGB interpolation of a saturated hue toward
transparent dips through a muddier, darker midpoint.

**The chart palette was validated, and the obvious answer failed.** The natural
blue → teal → amber → purple → rose ramp fails on dark: every hue sits above the
dark band's ceiling and glares. The passing dark set is indigo, teal, orange,
purple, rose. Reordering to separate teal from amber was tried and is worse - it
puts orange next to rose, which collapses to ΔE 9 for *normal* vision.

The shipped palette has one caveat, recorded in the CSS: slots 2 and 3 sit at
ΔE 6.3 under tritanopia, inside the floor band that is only legal with secondary
encoding. So every multi-series chart ships a legend and direct end-labels. The
network chart, which only needs two series, uses slots 1 and 3 instead - measured
ΔE 31.5, rather than relying on the mitigation.

## Dead ends

- **Blue-tinted neutrals.** See above. They make an elevation ladder
  position-dependent and force the accent to compete with its own background.
- **Deriving a light palette by inverting the dark one.** The lightness bands
  differ; an inversion lands outside the band and inverts the urgency order.
- **Eyeballing a categorical palette.** Every intuitive ordering tried here
  failed at least one check. The validator takes seconds and is not optional.
- **Brightening the dark-mode red** so `down` outweighs `up`. Destroys the
  warn/down distinction, which is worth more.

## How this is verified

- The contrast ratios recorded in the CSS comments can be recomputed from the
  token values and compared - drift is machine-detectable.
- The categorical palette is re-run through the five checks whenever it or its
  order changes, for both themes.
- A grep for raw hex outside the token declaration blocks catches the most
  common regression.
