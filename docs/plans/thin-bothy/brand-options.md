# BothyBox brand options: a BB icon and an opening-box loader (exploration, 2026-11-18)

Status: **decided 2026-11-18: the owner chose option 6, the Cube icon with the Cube loader, and it is wired into the
site** (see [The decision](#the-decision-2026-11-18) and [(E)](#e-how-it-is-wired)). Every other concept and loader
was **not chosen** and stays in the gallery for the record. The gallery is a standalone page at
`site/public/brand-mock/` (open `index.html` over any static server); this note records what is in it, the
recommendation that was made, the decision and how it is wired. Related: [website-sky-design](website-sky-design.md) (the sky and the
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

| # | Concept | What it is | At 16 px | Verdict | Decision |
|---|---|---|---|---|---|
| 1 | Pair | Two heavy Bs on an ink tile | fair: counters close up | The literal brief; generic and common as a monogram | not chosen, kept in the gallery |
| 2 | Facing | A B and its mirror, bowls meeting into a box | fair | **Avoid**: close to a famous fashion house's BB | not chosen, kept in the gallery |
| 3 | Back to back | Two Bs sharing one stem | fair | **Avoid**: same reason; also reads as a bow | not chosen, kept in the gallery |
| 4 | Bothy B | A B with a pitched roof: window above, the hut's bowl below | **good** | Recommended icon | not chosen, kept in the gallery |
| 5 | Crate | A B in a box with its lid lifted | poor | Thin outline breaks at 16 px | not chosen, kept in the gallery |
| 6 | **Cube** | Isometric box, a B on each side, amber lid | poor at 16, fine at 32 | Rich at 180 and in the loader | **chosen 2026-11-18** |
| 7 | Open box | A carton, flaps open, two Bs rising | poor | The loader's middle frame as a still; too busy small | not chosen, kept in the gallery |
| 8 | Shelter | A roof over a pair of Bs | fair | The warmest BB idea; the roof shrinks the Bs | not chosen, kept in the gallery |

**(B) Three opening-box loaders**, about 2.0 s, pure inline SVG animated with the Web Animations API (no library):

* **Carton** (ends on the Pair): both flaps swing open, the pair rises, the carton flies to the icon slot. *Not
  chosen; kept in the gallery.*
* **Cube** (ends on the Cube): the amber lid pops, the pair rises, the faces take their Bs. **Chosen 2026-11-18.**
* **Bothy** (ends on the Bothy B): the roof lifts like a lid, the pair climbs out of the hut, the window lights. *Not
  chosen; kept in the gallery.*

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

## The decision (2026-11-18)

**The owner chose option 6: the Cube icon, with the Cube opening-box loader.** It differs from the recommendation in
(D) below, which is kept as it was written so the reasoning on both sides stays on record.

Why the Cube: it is the most literal BothyBox (a box with a B on its sides), it is the richest mark at the sizes people
actually look at (the 180 px home-screen icon, the share cards, the header at 32 px and up), and the Cube loader is the
one where the icon *is* the box that opens, so the splash and the mark tell one story. The amber lid is the site's
existing lit-window colour, so no brand colour is added. Its known weakness, the 16 px favicon (the sheared Bs blur to
texture), was accepted: the cube's silhouette and amber top still read at 16 px as a small lit box.

Not chosen, and kept in `site/public/brand-mock/` for the record: icons 1 to 5, 7 and 8, and the Carton and Bothy
loaders. The gallery is a dev page and is not linked from the site.

## (D) Recommendation (made before the decision; not followed)

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

## (E) How it is wired

All geometry has one source, `site/src/brand/cube.ts` (ported from `concepts.js`; the gallery keeps its own copy).

1. **Favicon**: `site/public/favicon.svg` is the Cube on its ink tile, written by `npm run og` from `iconSVG('favicon')`.
   In a dark browser theme a faint paper rim (an SVG `prefers-color-scheme` rule inside the file) keeps the tile's edge
   visible on a dark tab strip. No PNG fallback.
2. **apple-touch-icon** (180) and the **manifest icons** (192, 512): the full-bleed variant (`iconSVG('full')`, ink
   square, cube at 80 %), rendered by `npm run og`, recorded with sha256 in `site/public/og/PROVENANCE.json`.
3. **Open Graph**: each card carries the horizontal lockup top left; the home card's heading *is* the lockup, large.
4. **Header and footer**: `components/Brand.tsx` draws the horizontal lockup in `currentColor` (the lid in the amber,
   turning to the ink on a bright hour), cap height 18 px (16 px under 416 px wide), so 129 px wide (115 px), above the
   96 px minimum, with half a cap of clear space. The drawing is `aria-hidden`; the name is real text ("BothyBox",
   visually hidden) inside the link. The header draws it once per page; the footer reuses it with `<use>`. The giant
   faint BOTHYBOX footer wordmark is unchanged.
5. **Nav idle wiggle**: on hover or keyboard focus the header icon's lid lifts and settles on a 1.6 s loop; CSS only,
   inside `prefers-reduced-motion: no-preference`.
6. **The intro** (`site/src/brand/splash.ts`, a lazy chunk of about 3.5 KB gzip, its own row in `check-budgets`;
   sequence changed on the owner's feedback, 2026-11-19): a first visit opens on the sky alone. The Cube sequence
   plays centred (1.6 s), then the finished lockup travels into the header lockup's exact box (0.7 s), and while it
   travels the page assembles round it: header links and pills, the hero's badge, heading, lines and buttons, the
   console's peek, the story dots and the sky's control, each fading in and rising 14 px, 80 ms apart. Assembled at
   about 2.9 s.
7. **Hidden only visually, never for long**: an inline script in the home page's head (`introScript()` in
   `splash-gate.ts`, the gate's own source) decides before the first paint and sets `bb-intro` on `<html>`;
   `styles/intro.css` takes those elements to opacity 0, nothing else, so the content is in the HTML and nothing moves
   (CLS 0 is asserted). The same script removes the class at 3.5 s whatever happens, so a splash chunk that hangs or
   fails never leaves the page hidden (both asserted). Any key, click, tap, wheel or scroll jumps to the assembled page.
8. **Once per session**: a `sessionStorage` flag read, written and read back inside `try/catch`; if storage throws
   or forgets, it does not play. Only on the home page, only when it opens without a `#fragment`.
9. **No JavaScript, `prefers-reduced-motion`, or automation** (`navigator.webdriver`, so the site's own browser
   checks see the page): the whole page at once, the class is never set. `?splash=1` forces it (still never with
   reduced motion), `?splash=0` stops it, `?splash=hold` builds it paused for a screenshot harness.
10. **LCP**: the sky's still cannot be the LCP element; Chrome ignores an image that covers the whole viewport (even a
    plain background on `.sky-still` is not reported), so the normal page's LCP is the hero's big line. Hidden text
    is reported when it is revealed, so on a first visit LCP moves to the reveal, about 1.8 s in a real browser;
    `check:story` asserts it lands by the time the page is assembled.

## Verified, and not verified

Verified on this box: every concept and all three loaders rendered in headless Chromium and looked at, the loaders
frozen at ten moments each (WAAPI `currentTime`, since headless Chromium here has no frame clock), at desktop and phone
widths, with reduced motion (the lockup, no animation).

Verified for the wired site (2026-11-18): `check:story` forces the splash and asserts it is `aria-hidden`, fixed and
takes no pointer, moves nothing (CLS 0, the same header and hero rects during and after), is gone by itself within
about 2.4 s and within 0.5 s of a key, plays on a person's first visit and not on a reload, and never loads with reduced
motion; `splash-gate.test.ts` holds the gating (reduced motion, blocked or forgetful storage, repeat visits). The
splash was frozen at a dozen moments (`?splash=hold`, WAAPI `currentTime`) at 1440 x 900 and 390 x 844 and looked at.
The new sequence (2026-11-19) likewise: `check:story` asserts opacity 0 at the start and 1 at the end for the header and
hero, the same layout boxes during and after, no animation left behind, the 3.5 s failsafe with the chunk hung or
failed, the whole page with reduced motion and without script, and a repeat visit seeing the page at once.

Not verified: the loader's real-time smoothness on a real device (this box cannot measure frame rate); Safari and
Firefox rendering of CSS transforms on SVG groups; how the favicon looks in a real browser tab on a high-DPI screen
(the gallery's tab strip is a mock); any trademark register.
