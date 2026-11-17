# Reference study: zephium.app, and what a Bothy sky can learn from it

_Written 2026-11-17. A study, not a spec. Nothing here is built. It informs the real-sky landing described as a later
item in [future-website](future-website.md)._

## Scope and ground rules

The owner called https://zephium.app/ "a very very very good example for all of it" and its skyline "just so stunning".
This brief records **techniques, structure, timing, colour and component ideas** from that site so that Bothy can reach
the same quality with **its own original work**.

- **Nothing of theirs is reused.** No image, font, code, copy, logo or icon from that site goes into this repo or the
  Bothy site. Their sky photograph, product mock-ups, "ZEPHIUM" wordmark, copy and shader source stay theirs. Where
  this document gives numbers (a blur radius, an easing curve, a decay time) they are measurements of behaviour to
  learn from, not a recipe to paste; Bothy must pick its own values by looking at its own photographs.
- **No third-party images are embedded here.** Screenshots exist only in the study scratchpad and are named below by
  filename. They are not committed.
- The visit was read-only: no form was submitted, nothing was signed in to, no account was created, no download was
  started.
- **Honesty rule for Bothy copy.** The reference's copy is confident marketing. Bothy's brand is a free shelter in the
  Scottish hills: true claims only, and a claim the box cannot back is not written.

How it was captured: playwright-core driving Chromium, 1440x900 desktop and 390x844 phone (device scale 2), plus
reading the site's own shipped JS and CSS in a browser's normal way to understand its sky. Study date 2026-11-17.

Screenshot directory (scratchpad, not in the repo):
`/tmp/claude-1000/-home-devssh-stacks/050466a1-4f14-4f0e-bed9-f312c1d8ab44/scratchpad/zephium/`

### A capture caveat that matters

This box's headless Chromium has **WebGL off** with the usual no-GPU flags. In that state the reference silently falls
back to its flat still image, so the first set of captures showed **no cloud physics at all**. With
`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` WebGL works in software
(the first screenshot then takes about 70 s while the shader warms up; later ones take under a second; one frame came
out black, a compositing artefact of software GL). `requestAnimationFrame` itself ran at about 60 per second in this
capture, so the "one frame per 40 s" note in the box notes did not bite here. **The physics were therefore measured
by pixel difference and by reading the shader, not by watching frame-accurate motion.** See Risks.

## 1. What the site is

A free, open-source desktop browser with an AI side. One long landing page, ten ordinary pages, a dark near-black
ground (`#09090b`) with **one bright photographic sky** used as the opening and as a night sky at the footer. The sky
is the brand. Everything else is restrained dark UI.

Pages reachable from nav and footer: `/` (landing), `/docs`, `/workflows`, `/pricing`, `/roadmap`, `/changelog`
(plus an RSS feed), `/about`, `/download`, `/support`, `/privacy`, `/terms`.

## 2. Per-page structure

### Landing (`/`), about 18,750 px tall at 1440 wide

| Scroll (px, 1440x900) | What is on screen |
|---|---|
| 0 | Sky hero. Top bar (logo left, six links centre, star-count pill and split Download button right). Capsule "Available now for Mac and Windows". Two-line H1. One-line lede. Download + "Star on GitHub". The top of an app window peeks up from the bottom edge. |
| 450 to 1350 | The app window rises and grows to fill the viewport and **pins**. Its new-tab page shows a night sky with a live local clock. A caption sits under it: "Your browser, as it should be." |
| 1350 to 7650 | A **pinned, scroll-driven story**: the window stays, a caption under it changes and a row of eight progress dots advances. Inside the window a "Work" session plays out as real page content: a typed request, a clarifying question, helpers reading sites, a comparison, a written plan, five tasks. The scene is 8.75 screens tall (`--screens: 8.75` x 100svh). |
| 7650 | The sky is gone; the page turns near-black. "First, a great browser." Two glass cards over cropped sky (a blocker counter, an extension list). |
| 8100 to 9000 | Bento row: "Everything, one shortcut away." Then a typographic switcher "AI is optional. Disable anytime. Customize everything." with a vertical picker (LM Studio / Off / Zephium AI / Claude / GPT). |
| 9000 to 12600 | "Work, on a canvas." A prompt pill, a large framed canvas screenshot-as-DOM, a four-up feature grid, a second canvas with embedded video and attach menu. |
| 12600 to 14000 | "Your day, beside the page." Three tall glass cards over sky crops (tasks, notes, time). |
| 14000 to 14800 | "Native, all the way through." Three tech tiles (Rust, WKWebView, WebView2) and four large stats (40 MB, Instant, Lighter, Longer). |
| 14850 to 15700 | "See it in motion." One framed video poster; a click opens a dialog with an embedded video. |
| 15750 to 16500 | FAQ: "Questions, answered." Six `details` rows. |
| 16500 to 18750 | **Night sky returns.** "Built in the open." Contributor avatars, four link rows, a "Linux is coming" notify card in glass, footer columns, closing line "Your next browser. Your last AI workspace." |

Phone (390 wide): same story in a portrait window, same captions and dots; page height about 19,800 px. The menu is a
rounded glass sheet over the sky, not a full-screen takeover.

### Other pages

All other pages share one pattern: dark ground, centred H1 (about 56 px), a short grey lede, a quiet 1200 px
content column, the same footer. **Only `/pricing` has a sky** (a still image with blue glass plan cards over it);
no other page runs a sky.

| Page | Structure |
|---|---|
| `/docs` | H1 "Docs", lede, a 3x2 grid of bordered topic tiles with small line icons (Getting started, Browse, Ask, Work, Models, Extensions). Page weight 756 KB transfer (the heaviest of the plain pages). |
| `/workflows` | H1, chip row of audiences (Travel, Buying, Research, Job search, Founders, Marketing, Support, Developers), then eight alternating text/figure rows, each figure a glass card over a sky crop containing a mock request. |
| `/pricing` | Sky hero, H1 "Everything, free. More AI, on demand.", monthly/yearly toggle, three plan cards (Free $0, Pro $20/month, Max $100/month) in blue glass, then usage explainer in three columns, FAQ, "Run it yourself" strip. |
| `/roadmap` | H1, four grouped lists (left heading, right rows with a status word: In progress / Planned). Pure typography. |
| `/changelog` | H1, release list with version and date in the left gutter, headings per release, an RSS link. |
| `/about` | Long-form prose in a narrow column: who makes it, what we believe, so far, the people, follow along. |
| `/download` | One centred glass card ("Linux is coming", email notify) plus Mac and Windows buttons, an install section and "Next" steps. |
| `/support`, `/privacy`, `/terms` | Plain legal and help text. Privacy is written as plain statements ("The browser collects nothing"), 16 short sections. |

Plain pages weigh 130 to 180 KB transferred, 65 to 70 requests, except `/docs` and `/about` (more images).

## 3. How the sky is made (technical recipe, inferred from shipped code and measured)

**It is one photograph, a WebGL fragment shader, and nothing else.** There is no video, no layered cutout stack, no
three.js, no GSAP, no Lenis. The "layers in depth" the owner perceives are **synthesised from the single photo's
own colours**, which is why the whole sky costs about 45 KB.

### Assets and weight (measured, 1440 wide, cold cache, 2026-11-17)

| Item | Size |
|---|---|
| Desktop sky (AVIF) | about 45 KB |
| Phone sky (AVIF, under 900 wide) | about 21 KB |
| Night sky (AVIF, shown at about 1100 px) | about 59 KB |
| Whole landing page, transferred | 1.18 MB, 83 requests |
| JavaScript | 19 files, 264 KB transferred (726 KB decoded) |
| CSS | 13 files, 59 KB |
| Images | 16 files, 578 KB; the three hotel photographs in the story are 70 to 141 KB each and account for most of it |
| Fonts | Geist and Geist Mono variable, about 70 KB each |
| Time | first paint 480 ms, load event 585 ms (cold, from this box) |

So the hero sky is **under 5 % of the page and one request**. The weight is the product story, not the sky.

### The shader, in plain terms

1. **A depth map without a depth map.** For each pixel the shader judges "how cloud-like is this colour": bright and
   unsaturated means cloud, saturated blue means open sky. Cloud is treated as **near**, blue as **far**, and the
   lower part of the frame as nearer than the top. Cloud strength runs from a floor of about 0.22 to 1, scaled by a
   0.55 to 1 vertical factor. That one number, `depth`, scales every movement below, so clouds move more than sky
   without any layers being cut out.
2. **Ambient drift.** A three-octave noise field warps the lookup coordinates by about 1.1 % of the image, scaled by
   `depth`, moving at about 2 % of a noise cell per second, plus a slow sine sway under half a percent. Always on,
   barely visible, stops the sky looking like a still.
3. **Pointer lean (parallax).** The pointer position, normalised to minus one to plus one, is smoothed with an
   exponential approach at a rate of about 2.4 per second (a time constant of roughly 0.4 s), and shifts the lookup by
   about 1.4 % horizontally and 0.9 % vertically, times `depth`. The photograph is drawn at 1.07x with the anchor held
   low (50 %, 66 %) so the shift never reveals an edge.
4. **Pointer wake (the "physics").** The last ten pointer steps are kept in a ring buffer. Each carries the pointer's
   velocity (scaled by 0.12, clamped to plus or minus 2.5), lives 1.4 s and fades with a smoothstep. Every pixel sums a
   Gaussian bump around each recorded point (width factor about 26 in aspect-corrected screen units) and is pushed
   along that velocity by up to 5.5 % of the image times `depth`. Cloud pixels the pointer passes through also get
   up to about 35 % extra brightness, "a breath of light". Result: a fast sweep drags the cloud bank like a hand
   through smoke and it **settles back on its own in about 1.4 s** with no spring overshoot. Not a particle system and
   not a fluid solve.
5. **Grain.** A single hash per pixel, about plus or minus one 8-bit level, reseeded per frame. It exists to stop
   gradient banding in the blue; it is not visible as texture.
6. **Arrival.** The sky is not faded in. The page opens on the ground colour and the sky **develops as a halftone**:
   a grid of 7-pixel cells, each a dot whose radius follows the sky tone at that cell, bright cloud cells first and
   blue cells after, over about 1.9 s with a cubic ease-out. The load-event screenshot is solid near-black; at 400 ms
   the page is still dark with the chip visible; by 1000 ms the sky is fully in. The same dot grid is used in reverse
   as the **exit**: a CSS custom property on scroll dissolves the sky bottom-up into the ground colour, cloud last.
   That is the hand-off from bright hero to dark page, and it is what makes the transition read as designed rather
   than as a cut.
7. **Resolution scaling.** Canvas size is the element size times `min(devicePixelRatio, 1.5)` (times 0.85 under 900 px
   wide), and an in-page governor drops the scale towards 0.6 if more than 30 of any 90 frames run slow. The context
   is requested `alpha: false, antialias: false, powerPreference: low-power`. Drawing stops when the canvas is off
   screen or the tab hidden, and the loop idles at half rate when nothing is moving.
8. **Fallbacks, in order.** No WebGL: the same photo as a CSS background with a 1.2 s opacity arrival. Touch or hover:none
   or 720 px and narrower: no canvas at all, a CSS image at 1.07x with a short arrival animation, and a plain
   gradient "veil" for the exit. Reduced motion: the shader draws one still frame (time zero, no drift, no arrival)
   and the pointer listener is never attached. No JavaScript: the page is the dark ground with all text present and
   **no sky at all** (see the JS-disabled capture).

### What it does not do

It does not grade the sky to the visitor's local hour. The day photograph is the day photograph. The only time-aware
element found is the **live clock and date inside the mock new-tab page** (it showed the capture machine's local
time). A separate night photograph is used as the browser window's wallpaper and at the footer, so "day outside,
night inside the app" is a composition choice, not a grade. Bothy's local-hour grade is therefore **new work**, not
something to copy.

## 4. What makes the skyline stunning

Ranked by how much each technique contributes, from what was measured and seen.

1. **The photograph is excellent and is the whole show.** A tall, sharp cumulus bank, saturated deep blue overhead
   falling to pale at the horizon, strong sun-lit edges and cool blue-grey undersides. Everything that follows is
   subtle; the picture carries it. Spend the effort here first.
2. **The composition leaves a clean sky box.** The clouds crowd the left, right and bottom edges and the middle is
   open blue, so headline and buttons sit on the quietest part. Text never fights a cumulus edge except on the second
   headline line.
3. **Depth cue by colour, not by cut-outs.** Near cloud moves about 4x more than far sky (the depth floor of 0.22
   against 1). That single ratio is what sells "layers in depth" with one image.
4. **Heavy cursor response is brief and light.** Peak displacement about 5.5 % of the image and a 1.4 s life. Anything
   longer or stronger reads as a toy.
5. **A calm baseline.** Constant drift at roughly 1 % of the image. The sky is never dead but never competes with the
   headline.
6. **A slightly larger-than-screen photo** (1.07x) with the horizon anchored low, so there is always cloud mass
   under the app window and no edge ever shows.
7. **Soft light on cloud near the pointer** (up to +35 % brightness on cloud pixels only). It makes the interaction
   feel like light, not like a smudge.
8. **Grain at one level, vignette none.** No visible vignette in the hero; the corners stay bright. The depth comes
   from colour (dark navy blue up top, pale low) not from a darkened frame.
9. **Haze is in the photograph**, not added: the lower third washes pale, which also makes the app window's
   dark top edge pop.
10. **A staged arrival** (dark, then halftone develop, then headline words rising one by one) so the first second is
    an event, not a load.
11. **A dark hand-off.** The sky is dissolved by the same halftone, so the 8.75 screens of product story happen on a
    calm near-black, and the sky comes back once, at night, at the footer. The sky is a bookend, not wallpaper.
12. **Glass that takes its colour from the sky.** Every glass panel is a mid-to-dark tinted fill with a high blur and
    saturation over a cropped sky photo, with a 0.5 to 1 px light inset edge; the panels look lit by the sky behind
    them.

Layer count: **one** photograph, no separate cut-out layers. Parallax ratio between cloud and open sky: about 4.5 to 1
(`depth` 1.0 against 0.22). Sky-to-page ground difference: bright `~#3a7bd5` blue to `#09090b`.

## 5. Palette actually used

Colours below are computed values from the live page. Names are mine.

| Role | Value | Where |
|---|---|---|
| Ground | `#09090b` (`rgb(9,9,11)`) | body, theme-color, the sky's exit colour |
| Text | `#f4f4f6` | body copy on dark |
| Text, muted | `#f4f4f6` at 68 % (`#f4f4f6ad`) | ledes, descriptions |
| Text, faint | `#f4f4f6` at 44 % (`#f4f4f670`) | tertiary labels |
| Hairline | `#ffffff12` | borders, dividers |
| Control fill / hover | `#ffffff17` / `#ffffff21` | inputs, secondary buttons |
| Focus ring | `#ffffff80` token; observed 1 px `rgba(255,255,255,0.7)` outline | keyboard focus |
| "Lit" button | fill `#ededf0`, hover `#f7f7fa`, text `#161619` | primary on dark |
| Hero primary button | white fill, text `#0b1f36` (deep navy) | Download on the sky |
| Hero headline | white, line 1 `#fff` to `#eef5fd`, line 2 `#e2eefb` to `#b4cfee` (gradient text) | H1 on sky |
| Hero lede | `rgba(255,255,255,0.9)` | on sky |
| Hero chip | fill `rgba(255,255,255,0.14)`, 0.5 px inset `rgba(255,255,255,0.3)` | "Available now" |
| Glass over sky | fill `rgba(16,34,56,0.62)` to `rgba(26,30,40,0.58)`, blur 24 to 52 px, saturate 1.4 to 1.8 | product window, cards |
| Glass menu | fill `rgba(22,22,26,0.9)`, blur 24 px, saturate 1.8 | download menu, phone nav sheet |
| Glass shadow | `0 18px 50px rgba(8,20,40,0.22)` over sky, `0 18px 52px -12px rgba(0,0,0,0.55)` over dark | cards |
| Story card fill | `rgb(35,35,39)`, selected `rgb(41,41,46)` | canvas tiles |
| Headline shadow | `drop-shadow(0 2px 28px #143c6e38)` and lede `text-shadow 0 1px 24px rgba(20,60,110,0.35)` | legibility on sky |
| Agent accents | `#8db9f2` blue, `#e6cb80` amber, `#88d0b3` green, `#b7a6f0` violet | small helper characters |

The deliberate restraint: **no brand colour**. The only chroma on the page is the sky and four small agent hues.

## 6. Type

One family: **Geist** (sans, variable 100 to 900) and Geist Mono for code and numbers. All self-hosted woff2.

| Use | Size | Weight | Tracking | Line height |
|---|---|---|---|---|
| Hero H1 | `clamp(2.5rem, 1rem + 3.7vw, 4.8rem)` = 69 px at 1440, 40 px phone | 600 | -0.05 em | 0.98 |
| Section H2 | 56 px (48 and 68 variants for the emphasis sections) | 600 | -0.045 em | 1.02 |
| Card H3 | 32 px | 600 | -0.035 em | 1.1 |
| Hero lede | `clamp(1.06rem, 0.96rem + 0.35vw, 1.28rem)` = 20.4 px | 400 | -0.012 em | 1.5 |
| Nav link | 14 px | 450 | -0.006 em | 1.5 |
| Chip | 13.5 px | 500 | -0.005 em | 1.5 |
| FAQ question | 18 px | 550 | -0.015 em | 1.5 |
| Footer group heading | 13 px | 550 | normal | 1.5 |

The headline is balanced (`text-wrap: balance`), capped at 15 em, and set **tight** (-5 % tracking, 0.98 leading). It
sits centred on the open blue box between two cloud masses. Each word is its own span (it staggers in), the second line
is a gradient pale-blue, so the line is deliberately a little recessive.

## 7. Spacing, radius, shadow, icon

- **Layout:** `--content: 1200px`, `--gutter: clamp(20px, 4vw, 40px)`, `--nav-height: 64px`. A 16 px root with a
  `--u` multiplier so product mock-ups scale with the viewport.
- **Rhythm:** sections are separated by very generous space (headline blocks sit about 300 to 500 px apart on
  desktop). Gaps inside cards 14 to 26 px.
- **Radius:** capsules (999 px) for every nav link, chip and button; 12 px for list rows; 14 to 23 px for cards; 28 px
  for the largest panel. The pairing "capsule controls, soft-rounded panels" is the signature.
- **Shadow and edge:** panels use a **0.5 to 1 px inset white edge plus one soft deep shadow**, never a visible border
  colour. That is what makes glass read as glass.
- **Icons:** 1.5 px stroke, round caps and joins, `currentColor`, 16 to 20 px, a single line style throughout. Brand
  marks are small flat SVGs at 16 to 19 px, shown only inside the mock-ups.

## 8. Component inventory and anatomy

- **Top bar.** 64 px, transparent over the sky (no scrim, no blur). Left: mark + wordmark. Centre: six capsule links
  (14 px, `padding 6x12`, 85 % white). Right: star-count capsule (0.5 px inset edge) and a split Download button.
  On phone: logo, Download, menu button; the menu opens as a glass sheet.
- **Capsule chip.** 34 px high, fill 14 %, 0.5 px inset edge, and a **conic-gradient highlight that travels round the
  border** (4.5 s, linear, endless). Hover raises the fill and nudges the arrow 2 px.
- **Split Download button.** White capsule, label | divider | chevron. Chevron opens a glass menu: macOS, Windows,
  Linux (coming soon, Notify me), "All builds on GitHub", "Release notes".
- **Ghost button.** Same size, glass fill, light text and an icon.
- **Product window.** The app drawn **in HTML and CSS**, not as a screenshot: rounded 21 px frame, 52 px backdrop blur
  with saturation 1.5, a 0.5 px inset edge plus a 1 px top highlight, and two stacked shadows (a tight and a deep).
  Inside, a darker page (`#0d0d0f`) with a 13.7 px radius.
- **Story caption + dots.** One 14 px line centred under the window and eight dots; swaps with the chapter.
- **Glass tile over sky crop.** A rectangular sky photograph clipped as a card background with a glass panel holding
  a mini-UI (counter, toggles, list). Eight of these appear on the page.
- **Bento tiles.** Dark `rgba(255,255,255,0.024)` fill, 22 px radius, 24x26 padding, hairline inset.
- **Typographic switcher.** A vertical list where the centre item is large and white and the rest fade up and down.
- **Stat row.** Four large words/numbers (40 MB, Instant, Lighter, Longer) with a tiny grey unit under each.
- **FAQ.** Native `details/summary`, 71 px rows, plus icon, hairline between rows, 18 px text.
- **Video poster + dialog.** A framed poster with a glass play button (blur 18, white 18 % fill). Click opens a native
  `dialog` with a privacy-enhanced embedded video (autoplay, no related videos) and a close button.
- **Contributor avatars.** A row of overlapping circles, counts underneath.
- **Notify card.** Glass at 28 px radius over the night sky, email field and capsule button. JS is required to submit.
- **Footer.** Four columns (brand line, Product, Resources, Legal), 13 px headings, quiet 12 to 13 px links, a
  closing licence and credit line.

## 9. Motion table

Durations and eases are from the site's tokens: fast 0.12 s, base 0.2 s, slow 0.3 s, page 0.4 s; ease-out
`cubic-bezier(.22,1,.36,1)`, emphasised `cubic-bezier(.16,1,.3,1)`, in-out `cubic-bezier(.65,0,.35,1)`, exit
`cubic-bezier(.4,0,1,1)`, and one spring written as a sampled `linear()` list with about 2 % overshoot.

| Motion | Trigger | Duration and curve | What moves | Reduced motion |
|---|---|---|---|---|
| Sky arrival | page load | 1.9 s, cubic ease-out | halftone dots grow from ground colour; cloud first | skipped, drawn complete |
| Headline words | load | 1.1 s emphasised, delay 80 ms + 45 ms x word index | opacity 0 to 1, blur 12 px to 0, rise 0.22 em | animation removed |
| Chip, lede, buttons rise | load | 1.1 s emphasised, lede delayed 0.55 s | opacity and rise | removed |
| Chip border highlight | always | 4.5 s linear loop | conic highlight rotates | not verified; gate it in Bothy |
| Sky drift | always | continuous, about 2 %/s of a noise cell | cloud lookups | off |
| Sky lean | pointer move | exponential ease, about 0.4 s time constant | whole sky shifts, cloud 4.5x more | off, listener not attached |
| Sky wake | pointer move | 1.4 s smoothstep decay per sample, 10 samples | local push and brightening | off |
| Sky exit | scroll | scroll-linked, 0 to 1 | halftone dissolve bottom to top | stays (scroll-linked) |
| App window grow and pin | scroll | scroll-linked, native sticky, 8.75 screens | window scales and fixes, camera pans a canvas | scroll-linked; typing and fades are removed |
| Chapter state | scroll thresholds | state flips at fixed scroll values (about 0.15, 0.4, 1.15, 2.1, 3.05, 4.05, 5.05, 5.3, 6.1, 6.15) | typed request, helper cards, plan, tasks | content shown, not animated |
| Hover on capsule | pointer | 0.2 s ease-out | fill and arrow nudge | unchanged (cheap) |
| Menu and popover | click | 0.12 to 0.3 s ease-out | opacity, small translate | transition removed |
| Card reveal | scroll in view | opacity from 0 | fade and settle | removed |

## 10. Accessibility and performance, observed

Good:

- Skip link ("Skip to content") is the first tab stop, one `main`, six `nav` landmarks, `lang="en"`, every `img` has an
  `alt` attribute (decorative ones empty), no unnamed buttons or links.
- Heading outline is clean: one H1, then H2 per section (13 H1/H2 on the landing page).
- Focus ring is a visible 1 px 70 % white outline.
- Hero words are individual spans marked `aria-hidden`; whether a separate accessible copy of the sentence exists was not verified, so test this before copying the per-word split.
- The sky is `aria-hidden`. The photograph carries no information.
- FAQ is native `details`; the video is a native `dialog`; the form fails with a visible note when script is off.
- Reduced motion is honoured in the shader, the pointer listener and the CSS animations.
- Server-rendered HTML contains the text (about 490 KB), so JS off still shows every word.

Weak or to avoid:

- **Hero line 2 is low contrast.** Pale-blue gradient text (down to `#b4cfee`) over white cloud measures roughly 1.4:1
  at its worst and about 3:1 over mid blue. The drop shadow helps but does not rescue it. It fails WCAG on the
  cloud-heavy end. Bothy should not copy the gradient text.
- **JS off removes the sky entirely**: black ground, readable text. Fine, but not "graceful sky".
- The pointer wake has no keyboard or touch equivalent (touch gets a still).
- The pinned story is 7,900 px long. Anyone who scrolls with a keyboard or a screen reader goes through the whole
  story before the first normal section.
- Chip border highlight loops forever; no reduced-motion gate was found for it (not exhaustively verified).

## 11. How app UI is presented as part of the story

This is the second half of why the page works.

- The product is shown as **live HTML**, not screenshots, in the main story and the canvas sections (the DOM has only one launcher raster plus three hotel photographs inside it). That means it is crisp at any scale,
  tiny in weight, and can be animated by scroll state.
- It is **lit by the sky**: the window's glass takes the sky's blue, and its own new-tab page contains a second (night)
  sky. Product and brand are the same image.
- **One persistent object, many states.** The window pins and the story happens inside it (request, question,
  helpers, results, plan, tasks). Captions change under it. No cut to a new mock-up per feature.
- **A "camera" moves over a larger canvas** (per-chapter x, y and zoom, different tables for desktop and phone) so
  detail is shown at readable size inside a fixed frame.
- It shows **a real, specific job** (a founder planning a San Francisco trip) with real-looking numbers and sites
  rather than lorem ipsum.
- Supporting tiles use **the same window material** over different sky crops, so every figure feels like part of
  one world.
- Only the hotel photographs (three WebP files, 70 to 141 KB each) and one launcher image are raster.

## 12. What Bothy should adopt

Adopt the **techniques**, make every asset ours.

1. **One excellent photograph, a small shader, derived depth.** Our own cloud photograph(s), shot or licensed with a
   licence that permits shipping, AVIF at about 1700 px and about 900 px, 30 to 60 KB each. The depth-from-colour trick
   works on any cumulus picture.
2. **Pointer lean + short wake** with the same budget: a few percent of the image displacement, settle in about 1.5 s,
   no overshoot, off for reduced motion and for touch. Tune by eye on our own photo.
3. **Halftone or other deliberate arrival**, and the **same device as the exit**, so the hand-off from sky to dark
   page is designed. Our variant should be our own idea (see 13).
4. **Bright sky as a bookend, calm dark ground between**, with the sky returning once at the end.
5. **A flat CSS fallback and a no-canvas touch path from day one**, with the page complete and sized before the sky
   loads. The fallback must look finished, because on many machines it is the only version seen.
6. **Governed resolution** (cap DPR, step down on slow frames, stop when off screen or hidden).
7. **App UI as live DOM**, pinned, with captions swapping under it. Bothy has a real console (the portal, the
   `bothy` CLI, the control plane); the story can show the real screens rendered from fixtures, not drawings.
8. **Capsule controls and soft-rounded glass panels over cropped sky**, with a 0.5 px inset edge and one deep shadow.
9. **Type: one family, tight tracking at large sizes, balanced wrapping, a restrained palette with no brand colour.**
10. **Scroll-linked progress dots** and a short caption per chapter.

## 13. What Bothy should do differently (to stay original and true)

- **Different sky, different story.** Their sky is a tall, bright afternoon cumulus. Bothy's story is the **sky above
  hills down to one small lit shelter**: the sky should *change as you descend* (graded to the visitor's local hour,
  then dusk-blue and peat-brown at the bottom, one warm window at the end). A single photograph cannot do that.
  Plan on a short stack (two or three photographs, a grade per hour, a ridge silhouette) rather than copying their
  one-photo trick.
- **Do the hour-of-day grade properly.** They do none. Use the visitor's local hour (client clock, no network) to
  pick a colour grade, and say plainly on the page that it uses the local clock. Test dawn, midday, dusk, night and
  the in-between, and the case where the clock is wrong.
- **Different reveal.** Not a halftone dot grid. Something Bothy owns: for example **mist lifting off the glen**, or
  the cloud bank resolving from a low-contrast, cooler version of itself as it "clears". Same budget (about 2 s),
  different picture.
- **Palette from the place, not from a browser maker.** Ground not `#09090b` but a warm dark **peat** (near
  `#15110e` to `#1b1612`), panel fills from **granite** greys, accents from **heather** (a dusty purple) and a single
  **lit window** amber. Text off-white with a hint of warmth. Pick final values by eye against our photographs and
  check the contrast numbers.
- **Type:** no gradient text on the sky. Headline in solid off-white or deep ink, with a **measured scrim** (a soft
  local darkening of the photograph under the text block, not a drop shadow on the glyphs) so contrast is real and
  passes. Choose a self-hosted family with an open licence; do not use the same one by default.
- **Product UI is true.** Show the real console states from the actual `bothy` product, with real module names and
  real figures from a fixture the tests keep honest. No invented customer story, no hotel photographs, no fake
  numbers. Anything shown as live must be live, anything illustrative must be labelled.
- **Offline, self-hosted, no third parties.** Per [future-website](future-website.md): no CDN, no external fonts, no
  analytics, no embedded video from another site. A video, if any, is a local file with a poster.
- **No claims we cannot back.** Do not borrow "instant", "lighter", "longer" or any size claim. Every statement on the
  site should be checkable against the repo (and the repo's `doc-facts` check where a number appears).
- **Pointer physics with a keyboard story.** Add a visible, labelled control that does the same thing (nudge, a
  calm/lively toggle) so the sky is not mouse-only, and a **pause** for motion.
- **Pin less.** Keep the descent story to about 4 to 5 screens, with a real way to jump past it (a link at the top,
  and the page sections reachable by headings).

## 14. Risks

| Risk | Detail | Mitigation |
|---|---|---|
| **Weight creep** | The reference sky is about 45 KB because it is one image and a shader. A multi-layer, hour-graded Bothy sky can easily reach 500 KB to 1 MB. | Budget the hero at 150 KB for the first visit, lazy-load the other hours, AVIF with JPEG fallback, 900 px phone image, test on a throttled link. |
| **Headless cannot verify the physics** | On this box WebGL needs a software-GL flag; the first frame takes about 70 s, one frame came back black, and frame-by-frame motion cannot be trusted. Pixel-diff checks show *that* the sky moved (4.6 to 11.4 mean level difference over cloud strips) but not *how it feels*. | Verify by hand on a real GPU browser before sign-off; keep screenshot tests on the flat fallback; never claim motion quality from a headless run. |
| **Software-GL machines** | A visitor on a weak or blocklisted GPU takes the flat path. | Make the flat path pretty and complete; governor like theirs. |
| **Legibility over bright cloud** | The reference fails it on line 2. | Scrim by design, check contrast numerically against the brightest 5 % of pixels behind each text block. |
| **Reduced motion and touch** | Easy to forget; the pointer effects do nothing for half the audience. | Ship the still and the no-canvas path first; treat physics as an enhancement. |
| **A long pinned story hurts keyboard and screen-reader users and can feel hijacked** | 7,900 px in the reference. | Short story, skip link, headings, native scroll only, no scroll-jacking. |
| **Image licensing** | A stunning cloud photograph is a licence question. | Shoot our own or use a clear licence; record source and terms next to the file. |
| **Looking like a copy** | Same sky + window + dark page + glass structure. | Sections 12 and 13: different reveal, palette, story, and a descent not a bookend. |
| **JS-off page has no sky** | Black hero with text. | Give Bothy's hero a CSS-only sky (a gradient plus the photograph as a background) so it is never black. |
| **Third-party embed** | Their film is a remote embed. | Not in Bothy (offline rule). |

## 15. Screenshot index (scratchpad, not committed)

Directory: `/tmp/claude-1000/-home-devssh-stacks/050466a1-4f14-4f0e-bed9-f312c1d8ab44/scratchpad/zephium/`

| Files | Shows |
|---|---|
| `01-landing-d-loadevent.png` | the page at the load event: ground colour only, sky not yet developed |
| `140-arrival-d-t400ms.png`, `t700ms`, `t1000ms`, `t1500ms`, `t2300ms` | arrival timeline (flat-fallback render) |
| `03` to `40-landing-d-scrollNNNNN.png` | landing page every 450 px, desktop, WebGL on |
| `41` to `46-hero-d-mouse-*.png` | pointer rest, after a sweep, plus 500 ms, plus 2 s, corner leans |
| `47-nav-d-hover-workflows.png`, `48`, `49` | hover states |
| `50-hero-d-download-menu-open.png` | split-button menu |
| `51-hero-d-focus-tab4.png` | focus ring |
| `52-hero-d-FLAT-FALLBACK-no-webgl.png` | what visitors without WebGL see |
| `54-hero-d-webgl-rest.png` | hero with WebGL live |
| `60` to `99-*-d-y*.png` | docs, workflows, pricing, roadmap, changelog, about, download, support, privacy, terms, desktop |
| `100` to `115-landing-m-scrollNNNNN.png`, `130-menu-m-open.png` | phone landing and menu |
| `141-hero-d-JS-DISABLED.png`, `143-hero-d-REDUCED-MOTION.png`, `144-story-d-REDUCED-MOTION-y2500.png` | degraded modes |
| `145-faq-d-open.png`, `146-film-modal-d-open.png` | FAQ row, video dialog |

## 16. Not captured, and why

- True frame-by-frame cursor physics (headless software GL; see Risks).
- Dark/light colour-scheme alternates: the site is dark only (`color-scheme: dark`).
- Auto time-of-day behaviour: none exists on the site, so there is nothing to capture.
- No form was submitted, no download started, no sign-in, as instructed; the Linux notify form and checkout were
  therefore not exercised.
- No Lighthouse run (not installed). Observations above are from the DOM, the network log and computed styles.
