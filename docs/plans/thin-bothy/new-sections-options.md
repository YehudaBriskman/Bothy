# New home page sections: four proposals, each with three live options

Status: proposal, 2026-11-19. Nothing here is wired into `site/src`. It is a second pass after
[section-design-options.md](section-design-options.md) (the 20 existing sections), in the same format and under the
same rules. The owner asked for "areas of more components, and maybe videos (that we'll make) from the app view".

**To look at it:** the mocks are sections 21 to 24 at the end of the gallery in `site/public/section-mock/`
(`mocks-new.js`, `mocks-new.css`, `new-behaviours.js`). Serve `site/public` and open `/section-mock/`:

```sh
python3 -m http.server 4204 --bind 0.0.0.0 --directory site/public
# then open http://<box>:4204/section-mock/#parts
```

How to read the costs: **S / M / L** is effort to build, risk of getting it wrong, cost to the page's bytes and
frames (perf), and cost to accessibility (a11y). **★** marks the recommended option. Anything invented is marked
**EXAMPLE** on the screen.

## The proposals at a glance

| #   | New section                           | Recommended                      | E / R / P / A | What it adds that the page lacks                                                     |
| --- | ------------------------------------- | -------------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| 21  | The parts, up close (`#parts`)        | A Four windows in a bento        | S S S S       | The health strip and module list are never shown; nothing is seen at full size       |
| 22  | See it in motion (`#motion`)          | A One player, four chapters      | M S M S       | A slot for the owner's recorded clips, with every rule for loading them              |
| 23  | The four sizes, compared (`#compare`) | A A table that says what is real | S S S S       | A line-by-line comparison; the only place "only Bivvy installs" sits beside a figure |
| 24  | Under the hood (`#hood`)              | A The request path               | S S S S       | Where the Docker socket is not, what is exposed, how big it is                       |

**Recommendation: build all four, but ship them in two steps.** Step one is 21, 23 and 24 (all S effort, all
built from fixtures and facts the site already holds, no new bytes of any weight). Step two is 22, which is
blocked on the recordings, not on code: the slot can ship with posters only and the clips drop in as they are
made. The command-strip idea from the brief is folded into 24 as option C rather than made a fifth section
(see "Evaluated and not made a section", below).

## Where each sits in the page

The page is: sky above the fold, the pinned story (console, descent, inside, sizes, install, trust), and then
the flat black region (after-story intro, two photo cards, the wide dry-run card, four-up features, closing
band, footer). Rules that hold for all four: **the black region has no sky of its own** (sky stays in photo
windows inside cards), and **there is no background behind a group of cards**: the windows sit straight on the
ink with hairlines between sections.

Proposed order below the story (new sections in **bold**):

1. After-story intro (09)
2. Two photo cards (10) and the wide dry-run card (11): unchanged
3. **21 The parts, up close** — right after 11. 10 and 11 show the console as a small floating panel in a sky
   photo; 21 is the same material at full size, with no photo, so it reads as the "evidence" after the
   "atmosphere".
4. **22 See it in motion** — after 21. A visitor who has just seen the parts still has not seen them move;
   this is the next question.
5. Four-up features (12), unchanged
6. **23 The four sizes, compared** — after 12, before the close. The story already explained the names (06, the
   hill); this is the "so what do I get" answer for someone who has decided to look.
7. **24 Under the hood** — after 23. It is the last argument ("here is why it is safe to run"), and it leads
   straight into the closing band (13).
8. Closing band (13) and footer (14), unchanged.

That is four new full-width blocks in a region that had five. If it is too long, the cut line is: keep 21, 22
and 24 on the home page, and make 23 the top of the existing `/modes` anchor on the install page.

## How the page stays light

Phone first load is the constraint: `check-budgets.mjs` gates it at 67 KB and carries the design's **60 KB advisory**,
with about 2 KB of headroom reported in the file. None of the four sections is part of the first load.

- **No new images.** 21, 23 and 24 are HTML and CSS drawn from the example fixtures (`site/fixtures/console/`)
  and `facts.ts`. The site already prerenders the console from those fixtures, so 21 reuses markup that exists.
- **Below the fold, so out of the first paint.** Each is a prerendered block with `content-visibility: auto` and a
  `contain-intrinsic-size` (so the scrollbar does not jump), and no script until it is near the viewport.
- **Estimated cost** (not measured; the mocks are dev-page text, 58 KB raw for all four plus their script):
  roughly 3 to 5 KB gzipped of HTML for 21, 2 KB for 23, 2 KB for 24, and a script of about 2 KB gzipped shared by
  all four (the player, the column highlight, the node facts). These are inputs to a budget row, not a promise.
  They would move "dist total" by under 20 KB and "first load / phone" by zero.
- **Video (22) is the one heavy thing, so it is the one with rules** (next section).
- The gallery itself is a dev page: `section-mock` is already excluded from the shipped budgets in
  `check-budgets.mjs` and `check-a11y.mjs`, and the dev-pages row stays under its 1150 KB ceiling (see "How it was
  checked").

## Video rules (section 22)

A clip is **silent, looping, 6 to 12 seconds, recorded from the real app on example data**. Rules, in order of
importance:

1. **Nothing downloads until needed.** `<video preload="none" muted loop playsinline poster="…">`, `src` set
   by an IntersectionObserver when the slot is within one screen (rootMargin 100 %), and not at all when
   `navigator.connection.saveData` is true or the connection is `slow-2g`/`2g`. The poster is the only thing on
   the page until then. On phone widths the clip starts only when the visitor presses play (the poster carries
   the play button): a cellular visitor never pays for a clip they did not ask for.
2. **Poster is the real last frame**, AVIF, at most 25 KB at the slot's width, with explicit `width`/`height` so
   there is no layout shift. A slot never carries the page's LCP; the hero does.
3. **Visible play/pause button on every clip**, a real `<button>` with `aria-label` that says what it does and
   which clip ("Pause the Services clip"). WCAG 2.2.2 (Pause, Stop, Hide, level A) requires a way to pause
   anything that starts by itself and lasts more than five seconds; every clip here is longer, so the control is
   not optional. Starting by scrolling into view counts as starting by itself.
4. **Reduced motion shows the poster and does not autoplay.** The play button still works, because a visitor's
   own press is not "automatic".
5. **Pauses off screen** (IntersectionObserver), on hover over the controls, and under the page's own
   "pause motion" if one is added.
6. **A caption and a transcript for every clip.** The caption is one visible sentence under the slot; the
   transcript is a native `<details>` with a plain description of what is on screen, step by step. There is no
   audio, so there are no spoken captions to write; the transcript is the text alternative for the video.
7. **Budget per clip, a target and not a measurement:** 1280 × 800, 24 fps, H.264 in MP4 plus an AV1 or VP9
   WebM, at most **500 KB each** (a flat dark UI compresses well). Four clips are 2 MB, none of it on first
   load. A new `check-budgets.mjs` row ("video, per clip, raw": 500 KB; "video, total": 2 MB) should be added
   with the first clip, in a folder `public/video/` that is excluded from "first load" the way `section-mock`
   is. This must be a measured number once the clips exist.
8. **No clip may show a number the real app did not show**, and a shortened sequence says so on screen
   ("shortened"), because the site's claim is "in our lab, 24 to 39 seconds", not "instantly".

### Shot list (what we record, from the real app, on example data)

Common setup. A clean Bivvy install on the example box with six containers named as in
`fixtures/console/services.json` (Notes web, Notes API, Notes DB, Wiki, plus the host dev server and the nightly
backup row). Browser window 1280 × 800, dark theme, no bookmarks bar, no extensions, a 14 px cursor. Record
at 60 fps and encode at 24. Every clip begins and ends on the same frame so the loop does not jump.

| #   | Clip               | Length | On screen                                                                                       | Exact steps                                                                                                                                                                                                                                                                                       |
| --- | ------------------ | ------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Services           | 8 s    | The Services table, six rows, one starting                                                      | 0 s the filled table, Wiki "starting" (start the Wiki container 3 s before recording). 2 s move the pointer to the Wiki row. 4 s its chip changes to "up" (set the healthcheck start period so it lands near 4 s; retake until it does). 8 s hold on the first frame's state, loop point.         |
| 2   | Notes              | 10 s   | Files: tree on the left, reader on the right, the "Writing: read-only" chip                     | 0 s tree collapsed. 1.5 s open `setup`. 3 s click `first-run.md`. 5 s scroll to the code block. 8 s hover the read-only chip. 10 s loop point.                                                                                                                                                    |
| 3   | Health             | 6 s    | The Overview strip: Services, Routes, Updates, Last backup                                      | 0 s all up. 2 s run `docker stop notes-cache` from a hidden terminal (a prepared script on a keypress, not visible). 3 to 4 s the Services tile changes figure and tone. 6 s loop point. Confirm on the real app how soon the strip refreshes; if it is slower than 3 s, say "sped up" on screen. |
| 4   | Install            | 12 s   | A terminal: `bothy install --dry-run`, then `bothy install`, then the console opens             | 0 s type the dry run (40 ms a key). 2 to 5 s the four checks print. 6 s type `bothy install`. 7 to 11 s the output, cut for time with a visible "shortened" badge. 11 s the `Bivvy is up` line. Never show a duration the real run did not take (the lab says 24 to 39 s).                        |
| 5   | A module (not yet) | 10 s   | `bothy module list`, then `bothy module add node-metrics`, then the new row in the Modules view | **Blocked.** Today `module add` is tested against a simulated machine only, and no published release carries a module. Do not record this until one does; until then the site must not show it. Listed so the slot count (four now, five later) is known.                                         |

Each clip also needs: a one-sentence caption, a transcript of what is on screen (the mocks in the gallery carry
one for each), and a poster. The gallery's stand-in scenes are CSS, not video, but they follow the same script,
so the clip can be checked against the mock.

## 21 The parts, up close (`#parts`)

**Now.** Not on the page as its own section. The console appears once, in the pinned story, and in the two photo
cards as a small floating panel.

**Weak.** A visitor never sees the health strip or the module list at all, and the services table is only seen
small and moving. Nobody can look at one piece and judge how finished it is.

**Looked at.** Linear (the product as the picture, fetched: the page uses still UI components, not video),
Zed and Raycast (UI pieces in frames), Supabase (a grid of capabilities).

|     | Option                  | Effort | Risk | Perf | A11y |
| --- | ----------------------- | ------ | ---- | ---- | ---- |
| A ★ | Four windows in a bento | S      | S    | S    | S    |
| B   | A fan of windows        | M      | M    | S    | M    |
| C   | Windows that are alive  | M      | S    | M    | S    |

**A. Four windows in a bento (recommended).** The services table, the health strip, a note being read and
the module list, each in its own framed window with one line under it, on the page's ink with no group
background. Drawn from the same fixtures the site already prerenders. _Says:_ These are the parts, and each is
finished. _Motion:_ rise 18 px and fade as it enters, 90 ms apart (700 ms emphasised); a cell lifts 3 px on
hover or focus. Nothing loops. Reduced motion: still.

**B. A fan of windows.** Three windows overlap like papers on a desk; pointing at or choosing one straightens
it and brings it forward. Shows depth. The cost is a rotated stack that is hard to read on a phone (it becomes
a plain stack) and a pointer-driven change of order that must also work from the keyboard (buttons below it do
that). _Motion:_ 600 ms emphasised, the others dim to 80 %.

**C. Windows that are alive.** A: plus one slow, small motion in each window (the wiki state turns to up, a
tile changes figure, a row highlights). It proves the product is live without a video; the loops are 9 s,
opacity and background only, and stop off screen. Costs a little more main-thread time, and has to stop under
reduced motion and pause-all.

**Placement and weight.** After 11. HTML only, about 3 to 5 KB gzipped (estimate). No images.

## 22 See it in motion (`#motion`)

**Now.** No video anywhere. The story animates a drawn console; the rest is still.

**Weak.** The owner will record the real app. The page has no slot for it, no rule for how it loads, and no way to
serve a reader who cannot or should not watch (captions, a transcript, reduced motion, a phone on mobile data).

**Looked at.** Linear and Zed (product loops inside a frame; only Linear was fetched, and it showed stills),
Warp and Raycast (a clip with a text description beside it), Vercel (short silent demos per feature). web.dev on lazy
loading video and WCAG 2.2.2 (both fetched or searched, see Sources).

|     | Option                          | Effort | Risk | Perf | A11y |
| --- | ------------------------------- | ------ | ---- | ---- | ---- |
| A ★ | One player, four chapters       | M      | S    | M    | S    |
| B   | Three poster cards, play on ask | S      | S    | S    | S    |
| C   | The clip follows the scroll     | L      | M    | L    | M    |

**A. One player, four chapters (recommended).** One framed player with four chapter buttons (Services, Notes,
Health, Install). Each chapter is its own silent loop with a poster, a play and pause button, a loop-position bar,
a caption and a transcript; the "How we record it" details in the gallery is the shot list, for the owner and
not for visitors. Only the chapter you are on can load; a visitor who presses nothing downloads one poster.
Chapters follow the APG tabs pattern (arrow keys). _Says:_ Here is the real thing, four short looks.
_Motion:_ marker slides 320 ms; the poster crossfades 250 ms.

**B. Three poster cards, play on request.** Three cards in a row, still posters with a play button;
nothing loads until pressed; one plays at a time. The lightest and the least script. Loses the chaptered tour.

**C. The clip follows the scroll.** The clip is pinned and its time follows the scroll, with a caption
per stage. Impressive, but it needs a video with every frame a keyframe (large files), a scrubbing script, and
it cannot be paused (it is not playing), so it avoids the pause rule only by being something else. Not
recommended for a site whose promise is "light".

**Placement and weight.** After 21. Poster 25 KB per chapter (estimate), script about 1.5 KB gzipped, clips
as per the rules above and never in first load.

## 23 The four sizes, compared (`#compare`)

**Now.** The Four sizes chapter in the story (a hill with four stops and a card each) explains the names;
it cannot be compared line against line.

**Weak.** "What do I get at each size, and what does it cost?" has to be remembered across four cards. The honest
answer (only the smallest installs, only it has a measured cost) is easy to lose in a polished table.

**Looked at.** Tailscale and Supabase plan tables, Linear's plan columns (all Prior or Snippet).

|     | Option                         | Effort | Risk | Perf | A11y |
| --- | ------------------------------ | ------ | ---- | ---- | ---- |
| A ★ | A table that says what is real | S      | S    | S    | S    |
| B   | Climb the ladder               | M      | S    | S    | S    |
| C   | Three questions                | M      | M    | S    | M    |

**A. A table that says what is real (recommended).** Four columns, Bivvy lit amber because it is the only one
that installs. Pointing at or choosing a size dims the other three. Where there is no measurement the cell says
"Not yet measured", in the same grey as the planned sizes. Real figures only: **38 MiB across three
containers** (lab, `facts.ts` `MEMORY_USED_TOTAL_MIB`), **960 MiB free** wanted by the installer. It is a real
`<table>` with `<caption>` (screen-reader only), `scope` on every header and a horizontal scroll container at
phone widths.

**B. Climb the ladder.** The sizes as a radio group (arrow keys) on the left; a list of what you have on
the right grows as you pick a bigger one, new lines outlined for a moment. Shows how the sizes build on each
other. Needs a live region for the list.

**C. Three questions.** Three yes/no questions and a "start with" answer. Most answers end at "start with Bivvy,
this is planned", so it reads as a promise about things that do not exist. Not recommended.

**Placement and weight.** After 12 and before the close. HTML only, about 2 KB gzipped; the column highlight is
one script line shared with the other three.

## 24 Under the hood (`#hood`)

**Now.** Nothing shows how the pieces fit. The trust section lists claims, not the shape.

**Weak.** Careful people look for where the Docker socket is and what is exposed. The answer is good and is
not visible.

**Looked at.** Tailscale (diagrams that show a mechanism, fetched), Warp (callouts on a code block, fetched),
Ghostty and Fly (terminal-first pages, Prior).

|     | Option                     | Effort | Risk | Perf | A11y |
| --- | -------------------------- | ------ | ---- | ---- | ---- |
| A ★ | The request path           | S      | S    | S    | S    |
| B   | Layers, peeled             | M      | S    | S    | S    |
| C   | Commands, with real output | S      | S    | S    | M    |

**A. The request path (recommended).** A browser, the edge, and two services joined by lines with a point of
light that runs along them. Each box is a button; choosing it shows one real fact under the diagram:
the edge is Traefik with the file provider only, **no Docker socket** (one read-only folder of routes), no
dashboard, one published port, 15 MiB in the lab; the console is 3.4 MiB; the notes reader is **read-only three
times over** (policy, `:ro` mount, no write routes; twelve read routes) and 19.6 MiB. Sources: bothy-install.md
sections 10b, 11 (I20, I21) and `facts.ts`. **The diagram does not draw how the console learns what is running
from Docker**, because the plan documents read for this work do not state that for the installed Bivvy; that
arrow must be added only once someone has read the code and confirmed it.

**B. Layers, peeled.** Three stacked layers: the machine (Linux amd64, Docker, Compose, the 960 MiB gate: 448 MiB
of limits plus a 512 MiB reserve), the three containers (measured memory beside declared limit: 15/128,
3.4/64, 19.6/256 MiB) and your data (kept on uninstall). Concrete, but says less about safety.

**C. Commands, with real output.** The command strip from the brief: three tabs (`bothy install --dry-run`,
`bothy module list`, `bothy update --check`) in a terminal frame, with what each prints. The output is
marked EXAMPLE because it is drawn from the site's own words and fixtures and the lab record, not captured; a
recorded capture would replace it. The text is real selectable text, not a typewriter. **`bothy doctor` is left
out on purpose**: the plans describe it, but the lab record does not show it running, so showing output for it
would be an invention.

**Placement and weight.** After 23. HTML only, about 2 KB gzipped.

## Evaluated and not made a section

- **A standalone command strip.** Folded into 24 C. As its own full-width block it would repeat the install
  chapter's terminal (07) and the dry-run card (11), which already show the same commands.
- **A customer or "who uses it" row**, a star and contributor count, and a testimonials wall. No numbers we can
  show truthfully (the earlier decision on the trust section stands).
- **A benchmark or comparison against other tools.** Nothing measured against another product exists; it would be
  invented.
- **An interactive "try it" sandbox in the page.** It would need a live backend or a large bundle; the clips and
  the example windows give the same information at a fraction of the weight.

## Rules every option follows

Unchanged from the first pass, plus three for video:

- Only `transform` and `opacity` animate (and a background colour on one row), plus CSS scroll-driven timelines
  with a fallback.
- `prefers-reduced-motion: reduce` gives the finished state, no autoplay for video.
- Every interactive piece is a real `button`, `input` or `details`; tabs use the APG pattern; focus is visible.
- No number that was not measured. Placeholder data says **EXAMPLE**.
- No new images in the mocks. In the site, the only new bytes are four posters and, later, the clips.

## Research: what was looked at

Each source is in my own words; nothing was copied. **Fetched** means the page was fetched and read in this
work. **Searched** means seen only in search results. **Prior** means known from before, not re-checked.

| Source                                                                                                                             | What it shows                                                                                                                                                                                           | Status                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| https://linear.app/                                                                                                                | The product shown as still UI mocks (issue view, activity, lists, a changelog), no video in the page text; fetched 2026-11-19                                                                           | Fetched                                                     |
| https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html                                                                   | SC 2.2.2: moving content that starts by itself and lasts over five seconds needs a way to pause, stop or hide it                                                                                        | Fetched                                                     |
| https://web.dev/articles/lazy-loading-video                                                                                        | `preload="none"` plus a poster to avoid the download; `autoplay muted loop playsinline` as the GIF replacement; `loading="lazy"` on video defers autoplay until near the viewport; not for an LCP video | Searched (result summary, page not opened)                  |
| https://web.dev/learn/performance/video-performance                                                                                | Video performance guidance for the same                                                                                                                                                                 | Searched                                                    |
| https://developer.chrome.com/docs/modern-web-guidance/guides/performance/lazy-load-video-and-audio                                 | The poster is fetched eagerly unless the video is lazy                                                                                                                                                  | Searched                                                    |
| https://tailscale.com/, https://www.raycast.com/, https://zed.dev/, https://www.warp.dev/, https://supabase.com/, https://cal.com/ | Diagrams over decoration; split features with a mock UI; product UI as the visual; callouts on a code block; a grid of capabilities                                                                     | Fetched in the first pass (2026-11-19), not re-fetched here |
| https://vercel.com/, https://ghostty.org/, https://fly.io/, https://resend.com/                                                    | Short silent demos per feature; terminal-first pages (the earlier fetches of Ghostty and Resend failed)                                                                                                 | Prior                                                       |
| Tailscale and Supabase plan tables, Linear plans                                                                                   | Plans as columns with the current one marked                                                                                                                                                            | Prior                                                       |
| `docs/plans/thin-bothy/bothy-install.md` (10b, 10e, 11, 15), `mode-names.md`, `cli-and-control-plane.md`                           | The facts used: edge file-provider, no Docker socket, read-only reader, lab figures, `module` verbs, `doctor` described not shown                                                                       | Read in this repository                                     |

The brief's examples of how top dev-tool sites show app video were **not** confirmed by fetching those sites'
video markup. Several of them ship their loops from scripts and a CDN that a text fetch does not show. The
pattern (silent loop inside a frame, with a caption) is from the first-pass notes and from search results.

## How it was checked

- Each option was screenshotted with headless Chromium on this box (no frame clock, so the stages are seeked
  with the Web Animations API, as `scripts/screenshots.mjs` does and the first pass did), at 1440 px, at 390 px
  with reduced motion on, and at 1440 px part-way (2.5 s). No console errors, no failed requests, no
  horizontal page scroll in any of them.
- Two defects were found and fixed from the screenshots: the loop's final keyframe hid every row at the
  loop point, and a class name (`.layers`) was already used by another mock and pulled the layers
  out of flow. A shared `.dot` class also clashed and was renamed.
- `npm run build`, `lint`, `format:check`, `test`, `check:a11y` and `check:budgets` were run in `site/`; the
  PR records the result.

## What is not verified

- **The clips do not exist.** The gallery's players are CSS stand-ins that follow the script. File sizes, load
  behaviour and the 500 KB per clip target are untested. How soon the real Overview strip refreshes after a
  service stops, and that the Wiki healthcheck can be timed to land near 4 s, are guesses until recorded.
- **How the console discovers containers in the installed Bivvy** was not confirmed, so the diagram leaves it out.
- **`bothy doctor`** has no recorded output, so it is not shown. The `module list` lines are from the example
  fixture; the `update --check` line is the lab record's wording.
- **Byte estimates** (3 to 5 KB, 2 KB) are not measured; they need the real components.
- **No real phone, screen reader or Safari** was used; pointer and keyboard behaviours (the fan, the ladder arrow
  keys, the tabs) were read in code and driven by script, not tried by hand. Muted autoplay on iOS needs
  `playsinline`, which is from web.dev's text, not tested here.
- Whether the owner wants the home page this long is a product decision; the cut line is stated above.
