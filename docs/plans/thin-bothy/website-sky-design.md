# The Bothy site: a real sky, and a story told from the shelter (design, rewritten 2026-11-18)

Status: **design, direction approved by the owner; the sky technique is proven by a spike, the story is not built.**
Supersedes the visual design of the first slice (`site/`, merged in #399), which is clean but plain; its content,
build, safety checks and deploy stay. The ordered work is in [website-build-plan](website-build-plan.md); the reference
study is [zephium-study](zephium-study.md); the later "served from the box" direction is [future-website](future-website.md).

Changed from the 2026-11-17 version: the **cut-out cloud layers are gone**. The technique is now **three real photographs
cross-graded by one shader** (below); the numbers are measured; the contrast method is concrete; ownership of the sun,
moon and light-on-text work is stated so it is not done twice.

**Superseded for the night sky (2026-11-20, owner request): there is no night sky.** The live sky shows daylight only, dawn
to sunset, from **two** photographs (day, dusk). The keyframe table has six rows (dawn 06:24, morning 08:30, noon 12:00,
afternoon 15:30, golden 17:30, sunset 18:42) and is **clamped, not wrapped**: before dawn the sky is the dawn palette,
after sunset the sunset palette. No stars, no moon, no night photograph, and the descent no longer runs the clock on
toward night. The three-photograph, night, moon and wrap-at-midnight passages below are the history of the design.

## The idea

The landing page **is a sky**: a real photograph that matches the visitor's hour, with **BothyBox** as the main words.
The page is a **story told from the sky down to the lit bothy**: you start above the clouds, descend through them to the
hills, and arrive at a small lit shelter, which is what the product is. Each chapter is told from there, with the real
product interface shown as the story's evidence. The whole site is one place: docs, install and releases wear a calm
version of the same sky.

## Decisions

| Question | Decision | Why | Date |
|---|---|---|---|
| How the sky is made | **Three real CC0 photographs (day, dusk, night), cross-graded by a raw WebGL2 fragment shader through an hour-keyframe table** | The owner approved it after seeing it run: 59.9 fps on their real laptop, "very very good". One technique, three small files, no compositing of cut-outs | 2026-11-18 |
| (replaced) Cut-out cloud layers with alpha | **Dropped** | Cut-outs can look pasted on, cost more bytes and need keying per exposure; photographs plus a shader look more real for less weight | 2026-11-18 |
| How the sky knows the hour | Visitor's local clock, plus a manual dial; `?hour=` forces it | No location, no tracking, no request to another site | 2026-11-17 |
| Shape of the story | Sky down to the hut | It is the meaning of the name | 2026-11-17 |
| Priority on real devices | **Always works, beautiful when it can**: no JavaScript is a real page | A real still sky and every word with no script; live effects only when the device is able | 2026-11-17 |
| Language | English first, Hebrew-ready CSS (logical properties only, already enforced) | Hebrew ships after the story | 2026-11-17 |
| Domain and deploy | `bothybox.com` over HTTPS; deploy by manual workflow dispatch until the owner approves a push trigger | Nothing goes live by accident | 2026-11-18 |

## Who owns what (so nobody duplicates work)

| Concern | Owner | Where |
|---|---|---|
| Sun, moon, and light falling on the text | **Another agent, in progress now** | `site/public/sky-spike/` |
| The three photographs, the hour table, grading, pointer physics, capability probe | The spike, then the production sky component (build plan slice S3) | `site/public/sky-spike/` then `site/src/sky/` |
| The story, chapters, scroll mechanics, product UI | Build plan slices S4 to S9 | `site/src/` |

Rule: the production sky imports the spike's proven shader and keyframe table and **does not re-derive the sun, moon or
text-light model**. Until that agent lands, S3 treats them as a named module interface (`sunMoon(hour) -> uniforms`,
`textLight(hour) -> scrim params`) with a stub.

## The technique

**One shader, three photographs, one table.**

1. **Three photographs**: a day sky, a dusk sky, a night sky. Each is a real CC0 photograph (provenance recorded per
   file, below), cropped for the hero and encoded as AVIF with a WebP fallback, in a desktop size and a phone size.
2. **An hour-keyframe table**: a small checked-in table keyed by hour (night, pre-dawn, dawn, morning, noon, afternoon,
   golden hour, dusk, twilight). Each row names the two photographs to blend, the blend weight, an exposure and a tint,
   the sun and moon uniforms, and the scrim parameters for text. The shader interpolates between adjacent rows
   continuously, wrapping at midnight, so 17:59 and 18:01 look alike and 23:59 and 00:01 look alike.
3. **A raw WebGL2 fragment shader** (no three.js, no library) samples the photographs, cross-grades them by the table,
   adds a depth-from-colour cue (cloud-like pixels are near, open sky far, so near moves more) for ambient drift and
   pointer lean, and a short pointer wake that settles in about 1.5 s. The reference study measured this family of
   technique in zephium.app; here it is used with **our own photographs, our own values and our own arrival**, and
   nothing of theirs is reused.
4. **Not in the sky**: cursor velocity grids, fluid solves, cut-out layers, three.js, gyroscope, any request to another site.

The hills, the mist and the lit window are **below the sky** in the story (chapters 1 to 3) and are a separate decision
(build plan open question Q4).

## Measured numbers (from the spike, 2026-11-18)

| Item | Measured | Budget (production) |
|---|---|---|
| First paint, desktop (still sky and text, over the wire) | **56 KB** | 120 KB |
| First paint, phone | **27 KB** | 60 KB |
| Frame rate on the owner's real laptop | **59.9 fps** | 55 fps or better on the same laptop; the probe degrades the effect below 50 |
| Previous plan's first-paint budget | 250 KB | replaced by the rows above |

The spike beat the old 250 KB budget by a factor of four, so the budget is tightened to keep it that way. **Performance
still cannot be measured on this dev box**: it has no real GPU and its headless Chromium emits roughly one
`requestAnimationFrame` per 40 s. Frame-rate numbers come only from real devices (the owner's laptop and phone); this
box checks looks (deterministic frame stepping, software GL, screenshots) and bytes.

## Time of day

Local clock to a keyframe row, interpolated. No location, no season: deliberately honest and cheap, and the page says
plainly that it uses the visitor's local clock. A dial lets anyone scrub the hour; `?hour=17.5` forces it, for
screenshots, tests and sharing. If the clock is wrong the sky is wrong, harmlessly; the dial fixes it. The photographs
carry the real colour; the grade only moves between them and tints, so dawn and dusk stay believable.

## Legibility: contrast per hour (method)

Text over a sky must hold its contrast at every hour. The method, replacing "check with APCA", which was intended and
never measured:

1. **A scrim, not a shadow.** Under the headline and lede sits a soft local darkening (or lightening) computed from the
   hour row's scrim parameters. The glyphs stay solid, never gradient text.
2. **Text colour is chosen per row** (warm off-white or deep ink) when the table is written, not at runtime.
3. **A checker samples pixels.** For each hour in a fixed set (every half hour, 48 stills), render the hero at 1440 and
   390 wide with `?hour=`, read the actual pixels behind the text bounding boxes (the darkest and lightest 5 percent of
   them, the worst case rather than the mean), and compute WCAG contrast (4.5:1 for body, 3:1 for the large headline)
   and APCA Lc as a second opinion (floor Lc 60 for body, 45 for the headline).
4. **The output is a table** (hour, viewport, worst contrast, pass or fail) and CI fails on a fail. The fix for a
   failure is a scrim parameter in the table, never a lower bar.
5. **The light-on-text model** that makes the sun's glow fall across the letters is the other agent's work; this method
   only tests its result.

## Cursor and touch

Pointer lean plus a short wake, on the budget above, off for `prefers-reduced-motion` and for touch (touch gets a small
scroll-linked parallax only). A visible, labelled control gives a keyboard user the same lean (nudge), a calm or lively
toggle and a pause. The sky is never mouse-only.

## The story (scroll)

| Chapter | What the visitor sees | What it says (all of it true today) |
|---|---|---|
| 0 Sky | BothyBox in the clouds, the hour dial, a quiet cue to scroll | One line: a shelter in the hills, for your machine |
| 1 Descent | Scroll drives the camera down through the cloud | What a bothy is: an unlocked hut that anyone may shelter in |
| 2 The hut | Hills, the hut, its window lit | What Bothy is: one console for one machine, found by asking Docker |
| 3 What it does | The real console, rendered from fixtures, in a glass frame | Only what the shipped modules do |
| 4 Four sizes | Four places on the hill: Bivvy, Bothy, Basecamp, Cairn | Names and measured costs; what is installable and what is a plan, marked |
| 5 Install | One command, then what it checks | The real flow, with the proven and unproven lists |
| 6 Leave it as you found it | The night sky returns | Open source, licence, docs, releases, uninstall and purge, the security policy |

Chapter contents in full, with their sources, are in the build plan. The honesty rules of the first slice are kept: no
invented features, only what has been shown to work, a plain list of what is not supported yet.

## Not negotiable

* **Works without JavaScript and without WebGL.** A real still sky (an hour-appropriate one chosen by CSS where possible,
  a neutral dusk otherwise) with every word of the page readable, and every chapter a normal section with a heading.
* **`prefers-reduced-motion`**: a still frame, no drift, no pointer physics, no scroll-driven camera.
* **Capability and power**: a short frame-time probe lowers the resolution or switches the effect off; paused when the
  tab is hidden or the canvas is off-screen; honours `Save-Data`.
* **Legibility** per the method above, enforced in CI.
* **Nothing from other sites**, no analytics, no cookies, no webfont requests. Self-contained WebGL2.
* **Budgets** as in the build plan, enforced in CI like the leak scan is.
* **Provenance**: every image has a licence entry in a checked-in file (`site/public/sky/PROVENANCE.json`: source URL,
  author, licence, date fetched, sha256, what was done to it) and CI fails on an image without one.
* The first slice's guards stay: docs allowlist, the leak scan on the output, link and anchor checks.

## Assets

Three CC0 photographs (day, dusk, night), already approved. Hills, mist and the bothy are drawn assets or layered
silhouettes that take the same hour's grade (open question Q4 in the build plan). Fonts: a self-hosted open-licence
family, subset, no request to another site. No image, font, code or copy from the reference site is used.

## Risks, stated plainly

* **The realism bar below the sky.** The sky is proven; the descent to hills and a lit hut is where it could look
  pasted. Slice S5 begins with a still mock to judge before the animation is built.
* **Weak devices.** Mitigated by the probe and the no-JS path; the budgets must be tested on a real low-end phone.
* **Duplicate work on the sun and moon.** Mitigated by the ownership table above.
* **Scope.** The story is the expensive part. The sky (S3) plus the content chapters without the descent are worth
  shipping on their own if the descent slips.

## Open questions

Moved to [website-build-plan](website-build-plan.md), each with a recommendation. Answered since the first version: cloud
photographs (CC0, done), clouds technique (photographs plus shader, done), Hebrew (after the story).
