# The Bothy site: a real sky, and a story told from the shelter (plan, 2026-11-17)

Status: **plan, agreed in outline with the owner; nothing built yet.** Supersedes the visual design of the first
slice (`site/`, merged in #399), which is clean but plain. Content, build, safety checks and deploy of that slice stay.

## The idea

The landing page **is a sky**: real clouds and a real-looking sky that match the visitor's hour (night or day),
with **BothyBox** as the main words, in and among the clouds. The clouds move with the cursor with believable
physics. The page is a **story**: you start in the sky, descend through the clouds to the hills, and arrive at a
small lit bothy, a free shelter in the hills, which is what the product is. Each chapter is told from there.

## Decisions (owner, 2026-11-17)

| Question | Decision | Why |
|---|---|---|
| How the clouds are made | **Hybrid**: cut-out photographs of real clouds, layered at depths, graded per hour and moved by a small WebGL shader and cursor physics | The most real look for the least weight; runs on phones |
| How the sky knows the hour | **Visitor's local clock, plus a manual sun/moon dial** | No location, no tracking, no request to another site |
| Shape of the story | **Sky down to the hut** | It is the meaning of the name |
| Priority on real devices | **Always works, beautiful when it can** | A real still sky and the whole content with no JavaScript; live effects only when the device is able |

## The scene, back to front

1. Sky gradient from a small table of hour keyframes (below), interpolated continuously.
2. Sun or moon (moon phase computed from the date, which is cheap and true), stars at night, a faint haze.
3. Far, mid and near cloud layers (real photographs with alpha), each with its own depth, drift and mass.
4. Mist, then layered hills with atmospheric perspective, lit by the same hour.
5. The bothy: a simple silhouette with a warm window that is dark by day and lit at dusk and night.

`BothyBox` is a real `<h1>` (selectable, readable by screen readers, indexable). The clouds are composited over and
around it so wisps part where the cursor passes and reveal the letters; the text never depends on the effect.

## Time of day

Local clock to a sun elevation (a simple hour-angle model, a fixed mid latitude, no season, deliberately honest
and cheap) to a palette by interpolation between keyframes: night, pre-dawn, dawn, morning, noon, afternoon,
golden hour, dusk, twilight. The same grade tints the photographs. A small dial lets anyone scrub the hour.
`?hour=17.5` forces a time, for screenshots, tests and sharing. The whole site (docs, install, releases) wears a calm
version of the same sky as its header band, so it is one place.

## Cursor physics

The cursor is an invisible hand. A low-resolution velocity field (a stable-fluids grid, on the GPU, about 64 by 64)
is stirred by cursor velocity and advects each cloud layer's displacement. Layers have mass and drag, so near clouds
move more and far ones less, then ease back to their slow drift. Touch drags the same way. No gyroscope (iOS asks
for permission, and it is not worth the prompt). Everything is stepped by a fixed timestep so it is deterministic.

## The story (scroll)

| Chapter | What the visitor sees | What it says (all of it true today) |
|---|---|---|
| 0 Sky | BothyBox in the clouds, the dial, a quiet cue to scroll | One line: a shelter in the hills, for your machine |
| 1 Descent | Scroll drives the camera down through the clouds | What a bothy is: an unlocked hut that anyone may shelter in |
| 2 The hut | Hills, the hut, its window | What Bothy is: one console for one machine, found by asking Docker |
| 3 Inside | The window lit, the four commands | The real install flow and what it checks |
| 4 Four sizes | Four places on the hill: bivvy, bothy, basecamp, cairn | Only the first is installable; the rest are marked as plans |
| 5 Leave it as you found it | Stars | Docs, releases, source, uninstall and purge, the security policy |

The honesty rules of the first slice are kept: no invented features, only what has been shown to work, a plain
list of what is not supported yet.

## Not negotiable

* **Works without JavaScript and without WebGL.** A real still sky image (an hour-appropriate one chosen by CSS where
  possible, a neutral dusk otherwise) with every word of the page readable.
* **`prefers-reduced-motion`**: a still frame, no drift, no cursor physics, no scroll-driven camera.
* **Capability and power**: a short frame-time probe lowers the resolution or switches the effect off; paused when the
  tab is hidden or the canvas is off-screen; honours `Save-Data`.
* **Legibility**: text over the sky sits on a scrim computed per hour so contrast holds at dawn and noon alike (checked
  with APCA, which the first slice only intended and never measured).
* **Nothing from other sites**, no analytics, no cookies, no webfont requests. Self-contained WebGL2 (no three.js).
* **Budgets**: first paint (still sky + text) 250 KB or less over the wire; all cloud layers 1.5 MB or less, lazy;
  script 60 KB gzipped or less. Enforced in CI like the leak scan is.
* **Provenance**: every image has a licence entry in a checked-in file, and CI fails on an image without one.
* The first slice's guards stay: docs allowlist, the leak scan on the output, link and anchor checks.

## Assets

Real cloud photographs, from public-domain or CC0 sources (for example Poly Haven's sky textures, NASA, Wikimedia
Commons CC0/PD) or ones the owner shoots; each cut to an alpha cloud by luminance or difference keying, in several
exposures so the grade has something real to work with. Encoded as AVIF with a WebP fallback. The hills and the hut
are drawn as layered silhouettes that take the same hour's light; their style is an open question below.

## Phases (each ends with something to look at)

0. **Feel spike** (small): one page, sky for the current hour, one cloud layer, cursor physics, the dial. No story.
   The owner judges the look and the feel before anything else is built. This is the gate.
1. Sky and time engine: keyframes, moon, stars, the dial, `?hour=`, still-image fallback.
2. Clouds and physics: three layers, the velocity field, capability probe, reduced-motion path.
3. The story: descent, hills, the bothy, chapters 0 to 5.
4. The rest of the site wears the sky; Install and Docs stay fast and quiet.
5. Hardening: performance and legibility budgets in CI, keyboard and screen-reader pass, screenshots at every hour,
   a real-device pass on a phone and a laptop.

## Risks, stated plainly

* **The realism bar.** Cut-out clouds can look pasted on. The spike exists to find that out cheaply.
* **This box has no real GPU and its headless Chromium has no frame clock** (`~/claude-notes/stack/portal.md`).
  Visuals can be checked here with deterministic frame stepping and software GL, but **performance cannot be
  measured here**. The real-device pass on the owner's phone and laptop is part of "done".
* **Weak devices.** Mitigated by the probe and the no-JS path, but the budgets must be tested on a real low-end phone.
* Scope: the story is the expensive part. Phases 0 to 2 are worth shipping on their own if 3 slips.

## Open questions

1. Cloud photographs: licensed CC0 sources first (recommended), or the owner's own photos?
2. The hills and the hut: layered silhouettes with atmospheric light (recommended), a painterly illustration, or 3D?
3. Hebrew: still planned, the text and CSS are already plumbed for it; do it after the story ships.
