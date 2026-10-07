# Logo and app icons

_Status as of 2026-10-07._

The mark, and every icon file that has to ship with a web product.

## The rule

**One source of truth for the geometry.** The mark is a set of coordinates.
Every raster is generated from those coordinates by a checked-in script, and
re-running it produces the same output. The moment a PNG is hand-edited, the SVG
and the PNG are two different logos and nothing will tell you.

**A second rendering is allowed; a second rendering nobody declared is not.** A
16px favicon and a large on-page mark have genuinely different constraints - a
2px stroke fills in at 16px, a filled mark cannot inherit `currentColor` - so one
mark drawn two ways is a legitimate answer. What is never legitimate is the two
drifting apart without anybody being able to say which numbers they still share.
So: name one rendering the source, state what both must have in common, state
every difference with its reason, and put a check on both halves. A comment that
says "if you change one, change the other" is not that check; it is a wish.

**Ship the whole set, not just a favicon.** The minimum for a web product:

| File | Why it exists |
|---|---|
| SVG favicon | Every current desktop browser prefers it; scales perfectly |
| 180x180 PNG | iOS home screen. Cannot be an SVG. Needs an opaque background |
| 192x192 PNG | Manifest / Android |
| 512x512 PNG | Manifest / splash |
| Maskable variant | Android crops icons to a platform shape; without this, yours gets clipped |
| Social image | Link previews. 1200x630 |

**Design it at 16px.** Render it at 16 pixels and look. Do not zoom out of a
512px version - that is a different rendering path and it flatters the mark.

**Do not bake a background into a mark meant to sit on your own page**, but do
give the app icons an opaque tile, because the OS puts them on unknown
wallpaper.

**A favicon cannot know the page theme.** It sits in the browser's tab strip.
Pick one treatment that works on both light and dark chrome rather than trying
to invert it - a mark that changes is a mark nobody recognises at a glance.

## Checklist

See [CHECKLIST.md § 3](../CHECKLIST.md#3-logo-and-app-icons).

## What Bothy decided, and why

**The mark** is a gabled shelter with the door open and the light on. The lit
doorway is the only coloured element, which makes the logo say the same thing
the page says: something is running in there.

**`apps/bothy-web/web/public/favicon.svg` is the source of the geometry**, and
nothing else is. It is the silhouette rendering: a solid white gable on a dark
rounded tile with one blue doorway, in a 24-unit box. `icon-maskable.svg` holds a
character-for-character copy of its two paths under a single
`translate/scale(0.72)/translate` transform, and `scripts/gen-icons.py` at the
repo root rasterises those two files into all four PNGs:

| PNG | from | why |
|---|---|---|
| `icon-192.png`, `icon-512.png` | `favicon.svg` | the manifest's `purpose: any`; keeps the rounded tile and its transparent corners |
| `icon-maskable-512.png` | `icon-maskable.svg` | `purpose: maskable`; full bleed, so Android's own shape does the rounding |
| `apple-touch-icon.png` | `icon-maskable.svg` | iOS ignores `purpose` and masks whatever it is given, so it takes the full-bleed art too - otherwise the tile is rounded twice and sits visibly inset |

**There is a second rendering, and it is declared.** `src/components/Brand.tsx`
draws the same mark as a 2px `currentColor` **outline**, with the door on
`--accent`. It exists for exactly one surface: the 72px watermark at 13% opacity
in the Files empty state. The topbar lockup carries no mark at all - it is the
wordmark alone, since 2026-08-18 - so the outline has one job and the silhouette
has the rest.

The two are **not** derived from each other, and an offset of one does not
produce the other: the roofs are at different pitches (31.6° filled, 37.6°
stroked) because the filled roof is a shape and the stroked one is a line with a
1-unit halo. What they share, and what differs, is the table below, and
`apps/bothy-web/checks/mark-geometry.mjs` holds every row of it.

**Shared - a change to any of these is a changed mark and fails the check:**

| | both |
|---|---|
| canvas | `viewBox="0 0 24 24"` |
| apex | exactly `(12, 4.2)` |
| symmetry | every path mirrors about `x = 12` |
| door | centred on `x = 12`, standing on that rendering's own ground line |
| arch | a semicircle: radius is exactly half the door's width |
| accent | exactly one accent-coloured element, and it is the door |

**Declared differences - each is pinned to its current value, so changing one
fails the check until this table is updated too:**

| | silhouette (`favicon.svg`) | outline (`Brand.tsx`) |
|---|---|---|
| paint | `fill` only, no stroke anywhere | `stroke-width="2"` on `fill="none"`, plus the one filled door |
| colour | literals `#09090b` / `#fafafa` / `#60a5fa` | `currentColor` and `var(--accent)` |
| eaves | `(1.6, 10.6)`, with a blunt 1.2-unit face | `(2.4, 11.6)`, a bare line end |
| walls | `x` 5 to 19, foot `20.2` | `x` 5.6 to 18.4, foot `20.4` |
| door | 6 wide, arch radius 3, springline `17.2` | 3.7 wide, arch radius 1.85, springline `15.3` |
| its job | 16px tab strip, OS launcher, PWA tile | one 72px watermark at 13% opacity |

**The colour literals in `public/*.svg` stay literals, deliberately.** Those
files are served as static assets, are never imported by the app and have no
theme to read: a favicon sits on the browser's tab strip, not on the page.
`checks/stray-colour.mjs` scans `web/src` only, so it never sees them, and that
is the right scope rather than an oversight - `checks/mark-geometry.mjs` asserts
the three values instead, against the tokens they are a snapshot of.

**The rasters are generated through headless Chromium**, which this box already
has for the screenshot checks. It has no ImageMagick, no rsvg-convert, no
inkscape, no cairosvg and no sharp. Rendering with the same engine that will draw
the favicon also means what is written is what a browser would paint.

**A hand-rolled Python rasteriser was tried and is gone.** It supersampled 4x and
wrote PNGs with the standard library, which was a real answer to "no converter on
this box" - but it could only do it by holding its own copy of the coordinates,
and that copy is what drifted: it was still drawing the **outline** mark long
after every shipped icon had become the silhouette, in RGB where two of the
shipped icons are RGBA, so running it would have overwritten three live icons
with a different logo. Deleted 2026-10-07. The lesson is the general one: a
generator that re-declares the geometry is a second source of truth wearing a
build step's clothes.

**The first attempt was rejected**, and it is worth recording why: a house
outline with a centred dot read as a generic "home" glyph with a dot on it - it
was indistinguishable from the icon library's own `house`. Making the opening a
doorway rather than a window, and squatting the proportions with a deeper roof
overhang, is what separates it from the stock glyph. The lesson generalises: a
mark built from the same primitives as a common icon will read as that icon.

**The favicon tile is dark in both themes**, deliberately, per the rule above.

**Known gap**, tracked in
[reference/open-questions.md](../reference/open-questions.md): there is no social
image. The maskable icon that used to be listed beside it now ships.

## Dead ends

- **A house with a window.** Reads as the stock home icon. See above.
- **Hand-exported rasters.** Rejected before it was tried, on the grounds that
  nothing would detect them going stale.
- **A second generator that re-declares the coordinates.** Tried, shipped, and
  it drifted into drawing a different mark. See above. The fix is not "keep the
  copies in step", it is "do not keep a copy".
- **Forcing the outline and the silhouette into one geometry.** Considered and
  rejected 2026-10-07: at 16px the stroke fills in, and at 13% opacity on seven
  themes the fill is a slab. Two renderings is the right answer; what was wrong
  was that nobody had written down that there were two.

## How this is verified

`apps/bothy-web/checks/mark-geometry.mjs`, in the suite, with no build and no
browser:

- Both SVGs and `Brand.tsx` are parsed, and every row of the shared table above
  is asserted on each.
- Every declared difference is pinned to the exact value in the table above, so
  a coordinate moved in either file fails until this document is updated too.
- `icon-maskable.svg`'s two paths are compared to `favicon.svg`'s as text.
- Each committed PNG is decoded and its ink and accent bounding boxes are
  measured and compared with what its source SVG says they should be, at the
  declared dimensions, with the declared colour type. That is what catches a
  hand-edited or stale raster, and it is a stronger claim than "re-run the
  generator and diff", which needs a browser and which nobody runs.
- No file but `favicon.svg` and `icon-maskable.svg` may carry the mark's
  coordinates.
- `scripts/checks/mutants.sh` plants three breakages - the arch radius, the
  apex, a re-hardcoded coordinate - and requires the check to catch all three.

By hand, once, when the mark changes: render at 16px and look at it.
