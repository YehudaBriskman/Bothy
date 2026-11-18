# BothyBox brand options: a BB icon and an opening-box loader (exploration, 2026-11-18)

Status: **exploration for the owner to choose from. Nothing here is wired into the site.** The gallery is a standalone
page at `site/public/brand-mock/` (open `index.html` over any static server); this note records what is in it, the
recommendation and how it would be wired later. Related: [website-sky-design](website-sky-design.md) (the sky and the
ink look these marks must sit on), [zephium-study](zephium-study.md) (why there is no brand colour).

## The brief

The owner's idea: the site and app icon becomes **two Bs for BothyBox**, and the branding moment is **a box that opens,
two Bs that come out of it, and stretch into the full wordmark "BothyBox"**. Readable at 16, 32 and 180 px; one colour;
on black ink (`#09090c`) and on the bright sky.

## What was made

All marks are **hand-built geometric paths** in `concepts.js` (a B generator plus the six letters BothyBox needs). **No
font is converted or embedded**, so no font licence applies; the gallery's own text uses the platform's system font.
`export.mjs` writes `svg/` from the same module, so the files are exactly what the gallery draws.

**The wordmark.** "BothyBox" in a tight, heavy geometric grotesk drawn for this: cap height 100, stems 22, horizontals
18, square-cornered stems, half-round bowls, tracking set by eye to about -0.02 em. The two capitals are the same B as
the icons use, which is what lets the loader turn the icon's two Bs into the word's two capitals.

**(A) Eight icon concepts**, each shown at 180, 32 and 16 px, the 16 px one also as an enlarged raster (what a browser
actually draws), in one colour on ink and on the dusk sky, as an ink tile on the day sky, as a light tile, and as the
favicon in a light and a dark browser tab strip:

| # | Concept | What it is | At 16 px | Verdict |
|---|---|---|---|---|
| 1 | Pair | Two heavy Bs on an ink tile | fair: counters close up | The literal brief; generic and common as a monogram |
| 2 | Facing | A B and its mirror, bowls meeting into a box | fair | **Avoid**: close to a famous fashion house's BB |
| 3 | Back to back | Two Bs sharing one stem | fair | **Avoid**: same reason; also reads as a bow |
| 4 | **Bothy B** | A B with a pitched roof: window above, the hut's bowl below | **good** | **Recommended icon** |
| 5 | Crate | A B in a box with its lid lifted | poor | Thin outline breaks at 16 px |
| 6 | Cube | Isometric box, a B on each side, amber lid | poor at 16, fine at 32 | Rich at 180 and in the loader |
| 7 | Open box | A carton, flaps open, two Bs rising | poor | The loader's middle frame as a still; too busy small |
| 8 | Shelter | A roof over a pair of Bs | fair | The warmest BB idea; the roof shrinks the Bs |

**(B) Three opening-box loaders**, about 2.0 s, pure inline SVG animated with the Web Animations API (no library):

* **Carton** (ends on the Pair): both flaps swing open, the pair rises, the carton flies to the icon slot.
* **Cube** (ends on the Cube): the amber lid pops, the pair rises, the faces take their Bs.
* **Bothy** (ends on the Bothy B): the roof lifts like a lid, the pair climbs out of the hut, the window lights.

Shared choreography: box in (0 to 0.3 s), lid opens with a small overshoot (0.25 to 0.65 s), the two Bs rise out from
behind the front (0.5 to 1.0 s), the box leaves for the icon slot while the pair flies to where the word starts (to
1.25 s), then **the second B pulls away and "othy" spreads out between the two Bs like a bellows while "ox" unfolds out
of the second B's back** (1.25 to 1.65 s, the second B stretched wide mid-pull, a hair of overshoot), and the box turns
into the final icon (to 2.0 s). The SVG is authored in its final state, the static lockup, and the animation only runs
away from that state and back, so no JavaScript, reduced motion, or a failed animation all show the lockup. Each stage
has Replay, a scrubber (step it by hand), an "on the sky" toggle, and a strip of six frozen frames. Escape finishes it.
A nav mock shows the **idle micro-animation**: on hover or focus the icon's lid (the hut's roof, the cube's lid, the
pair's second B) gives a small wiggle on a 1.6 s loop; CSS only, off for reduced motion.

**(C) The lockup**: horizontal (icon 1.2 x cap height, gap 0.36 x cap height) and stacked (icon 2 x cap height over
the word). Clear space: half the cap height on every side of the mark's own box. Minimum sizes: horizontal 96 px wide,
stacked 64 px wide, icon alone 16 px; below those use the icon alone.

## (D) Recommendation

**Icon: Bothy B. Loader: Bothy. Runner-up: Carton with the Pair, if the owner wants both Bs in the icon itself.**

* **Legibility at 16 px.** The Bothy B is one solid shape with two clear holes; it survives the 16 px raster where the
  two-B concepts turn to texture (eight counters in 16 pixels is under 2 px each).
* **Distinctiveness.** A B with a pitched roof says *bothy* and *B* at once; a BB pair in a rounded square is a common
  monogram and is not ownable.
* **The sky and the ink.** One colour, so it sits on black ink and on every hour of the sky. The window may be lit amber
  (the site's focus colour, the lit window of the story); in one ink it still reads. No new brand colour is introduced,
  in keeping with the zephium study's "no brand colour" finding.
* **The BB idea is kept, where it is strongest:** in the loader, where two Bs climb out of the hut and pull out the
  word, and in the wordmark, whose two capitals are those Bs.
* The Carton plus Pair is the most literal version of the brief and animates best, but the final lockup reads "BB
  BothyBox", and the Pair is the weakest favicon of the BB family. The Cube is the richest at large sizes and the
  weakest favicon.

## Trademark sanity (not a search)

**No formal trademark search was done.** This was a quick look for obviously similar famous marks only. Before any mark
is adopted, run a real search (at least USPTO, EUIPO and the Israeli register) in the software and online-services
classes.

* **Avoided:** mirrored or back-to-back Bs (concepts 2 and 3) sit too close to a well-known fashion house's interlocked
  BB monogram. They are shown so the owner sees why they were dropped.
* **Kept clear of, and must stay clear of:** a blue open box drawn as rhombi (a well-known file-sync brand; the Cube and
  Carton must never be blue), a single letter in a rounded square (a well-known CSS framework's mark), the lowercase
  blue "box" wordmark of a cloud-storage company (our wordmark is a heavy capital-B grotesk in off-white), and letters in
  separate square blocks (a broadcaster's three-block logo; the Pair keeps both Bs in one tile).
* The Bothy B (a house-shaped letter) resembles no famous mark found in this pass; house-shaped icons are common, so the
  search should look at home and shelter marks in the same classes.

## (E) How it would be wired (later, not in this change)

1. **Favicon**: replace `site/public/favicon.svg` with the chosen icon's tile SVG (already linked as an SVG favicon by
   `prerender.tsx`); add a 32 px PNG fallback only if a supported browser needs one.
2. **apple-touch-icon**: a 180 x 180 PNG of the full-bleed variant (`svg/<id>-touch.svg`; iOS rounds the corners),
   generated once, checked in with a provenance entry, linked with `rel="apple-touch-icon"`.
3. **Open Graph**: the 1200 x 630 card sets the horizontal lockup on a sky still, so share image and hero agree.
4. **Header and footer**: the inline `<Mark />` becomes the chosen icon in `currentColor`; the visible name can stay live
   text or become the drawn wordmark with an accessible name.
5. **The loader plays on the first visit only**, over the hero, at most about 2 s, and never blocks: the page is fully
   rendered and usable underneath, and any key, click, tap or scroll skips it.
6. **Never again that session**: a `sessionStorage` flag read and written inside `try/catch`; if storage throws, it
   does not play.
7. **No layout shift**: the loader draws in an overlay sized to the lockup's own box, where the lockup will be, and ends
   exactly as the static lockup.
8. **No JavaScript or `prefers-reduced-motion`**: the static lockup, already in the HTML.
9. **Nav idle wiggle**: CSS only, off for reduced motion.

## Verified, and not verified

Verified on this box: every concept and all three loaders rendered in headless Chromium and looked at, the loaders
frozen at ten moments each (WAAPI `currentTime`, since headless Chromium here has no frame clock), at desktop and phone
widths, with reduced motion (the lockup, no animation).

Not verified: the loader's real-time smoothness on a real device (this box cannot measure frame rate); Safari and
Firefox rendering of CSS transforms on SVG groups; how the favicon looks in a real browser tab on a high-DPI screen
(the gallery's tab strip is a mock); any trademark register.
