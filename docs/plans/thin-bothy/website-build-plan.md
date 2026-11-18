# The Bothy site: build plan, from the prerendered site to the finished story (2026-11-18)

Status: **plan; nothing in it is built except slice S0 (the current `site/`).** The design is
[website-sky-design](website-sky-design.md); the reference study is [zephium-study](zephium-study.md); the first slice and
its guards are described in `site/README.md`. This document is the ordered work, the exact content, the mechanics, the
budgets, the checks and the decisions. It is written to be handed to agents slice by slice.

## 0. What exists, what is approved

**Exists (`site/`, #399):** a React 19 + Vite static site, prerendered at build time into `dist/`; pages Home, Install,
Docs (the 14 Markdown files in `site/docs-allowlist.json`), Releases (`fixtures/releases.json`) and a 404; one small
script (`src/enhance.ts`: copy buttons, docs search, the install menu); all English words in `src/i18n/en.ts`; proven facts
in `src/facts.ts` (`PROVEN_RELEASE = '2026.11.2'`); guards `src/docs/safety.ts`, `leak-patterns.json`,
`scripts/check-public.mjs`, `check-links.mjs`, `verify-dist.sh`; stylesheet with logical properties only (a Hebrew
locale is a data edit); workflow `.github/workflows/site-pages.yml` (manual dispatch only, never run).

**Approved by the owner (2026-11-18):** the sky is three real CC0 photographs (day, dusk, night) cross-graded by a raw
WebGL2 shader through an hour-keyframe table. It ran at 59.9 fps on their real laptop ("very very good"). First paint
measured 56 KB desktop, 27 KB phone. The sun, moon and light-on-text are being reworked now by another agent in
`site/public/sky-spike/`; **this plan never duplicates that work** and depends on its interface (slice S3).

**Owner requirements:** the whole site is a story from the sky down to the lit bothy; interactions and real product UI,
animations, colours and components in the spirit of the reference (zephium.app) but original and true; always working
(no JavaScript is a real page); English first with Hebrew-ready CSS; `bothybox.com` live over HTTPS; manual-dispatch
deploy until approved.

## 1. The truth rules for every word on the site

The reference's copy is confident marketing. Ours is the Bothy Code: leave it as you found it, turn no one away, and say
only what has been shown to work. Concretely:

1. A claim on the site must be one of: **proven** (the lab results in `bothy-install.md` s10 to s10f), **checkable in the
   repo** (a file, a command, a licence), or **marked as a plan**. Every number on a page comes from `src/facts.ts` or the
   release feed, and `scripts/checks/doc-facts.sh` style tests keep it honest. No size, speed or "instant" claim is made
   that a measurement does not back.
2. **Proven today** (from `bothy-install.md` 10e and 10f): `bothy install` of a stock release on a clean linux/amd64 guest
   with only Docker and compose; checksum verification; the install took 24 to 39 s in the lab; a re-run is a no-op in
   about 1 s; `update` refuses a tampered or mismatched release and rolls back byte for byte; `uninstall` and `purge`;
   attestation is verified when `gh` is present and skipped with the exact command to run when it is not.
3. **Unproven, so never promised** (listed on the Install page in plain words, as the repo lists them): arm64 execution
   (images are pullable, never run); WSL, including Docker Desktop for WSL; rootless Docker; a 2 GiB host (`lab-mini`); a
   real downgrade or a real update between two real releases; a verified attestation inside a guest; SELinux enforcing;
   IPv6-only networks; macOS and Windows hosts; **k3s** (a design in `install-and-bootstrap.md`, not what installs today).
4. **What is a plan stays a plan.** Modes: the story shows all four rungs, but each is marked **installable now** or
   **planned** from `facts.ts`, which is written from the repo at the time of the slice (modules can be added with
   `bothy module add`, section 15 of `bothy-install.md`; the slice author re-reads what is proven before writing).
5. The page says its own limits: it uses your local clock for the sky; it makes no request to another site; it sets no
   cookie.

## 2. Open questions, each decided

| # | Question | Recommendation | Why |
|---|---|---|---|
| Q1 | Where the sky lives in the codebase | A first-party `site/src/sky/` module (vanilla TypeScript and one GLSL string, no React inside the canvas), loaded lazily by the one island that needs it. The spike stays in `site/public/sky-spike/` until S3 merges, then is deleted | React renders the static page; the sky is an enhancement and must not be in the SSR path |
| Q2 | Scroll mechanics | **Mixed.** Chapter 0 to 2 (sky, descent, hut) are one pinned scene of about 3 screens driven by scroll; chapters 3 to 6 are normal flow with sticky captions at most | Pin only where the metaphor needs it; pinned page content is hard to read, link and print |
| Q3 | Scroll library | None. `IntersectionObserver` for chapter state, and CSS scroll-driven animation (`animation-timeline: view()`) where supported, with one `requestAnimationFrame` loop reading scroll position as the fallback | No dependency, budget stays in the script cap; no Lenis (smooth-scroll libraries fight keyboard and assistive tech) |
| Q4 | The hills and the hut | **Layered SVG silhouettes** (three ridges, mist bands, a bothy), graded by the same hour table, as the first build; a still mock is reviewed by the owner before any animation. A painted or photographic option is a later, separate decision | Original, tiny, themeable by hour, no licence risk; the realism bar is judged on a mock first |
| Q5 | Real product UI | Render the **real console components** from `apps/bothy-web/web/src/components` against committed fixtures, built into the site as static HTML plus CSS (see s5). Not screenshots, not drawings | The reference's strongest idea; and it keeps the site true |
| Q6 | Palette and type | Site chrome from the **place**: warm dark peat ground, granite panels, heather accent, one lit-window amber (values chosen by eye against the photographs and checked for contrast). The **console frame** keeps the console's own tokens untouched, so the real UI looks like itself | One brand outside, truthful product inside; they meet in the glass frame |
| Q7 | Analytics | **None** (s10) | Privacy, the no-third-party rule, and nothing to decide that analytics would inform at this stage |
| Q8 | Domain, HTTPS | `bothybox.com` on GitHub Pages, HTTPS enforced once GitHub issues the certificate (steps in `site/README.md`) | Already planned; nothing new to build, only owner steps |
| Q9 | Hebrew | After the story ships (slice S12); every slice must keep logical CSS properties and put words in `src/i18n/en.ts` | Cheapest if nothing English is hard-coded; verified by `verify-dist.sh` |
| Q10 | Video | None. Motion is live DOM and CSS | No weight, no third party, no autoplay problems |
| Q11 | A local copy on each box | Out of scope here; the build already supports `SITE_ORIGIN= SITE_BASE=/`. The module is `future-website.md` | Keeps this plan on the public site |

## 3. The story, chapter by chapter (exact content)

Every chapter is a real `<section>` with a heading, so with no JavaScript it is a long, readable, linkable page. The sky
behind it is the still image for the visitor's hour (CSS picks by `prefers-color-scheme` as a coarse fallback; a dusk
default otherwise). Words live in `en.ts`. "Fixture" means a committed JSON file the tests keep equal to the product.

**Chapter 0: Sky.** *Shows:* the sky for your hour, `BothyBox` as the real `<h1>`, one line below it, the hour dial
(labelled, keyboard operable), a "Skip to install" link first in tab order, a quiet scroll cue. *Says:* "A free shelter in
the hills, for your machine." (A bothy is an unlocked mountain hut anyone may use.) A footnote states that the sky uses
your local clock and nothing leaves your browser.

**Chapter 1: Descent.** *Shows:* the camera falling through cloud (scroll-linked scale and fade of the photograph, the
cloud crossing the text), ending at ridge tops. *Says:* what a bothy is, in one short paragraph from `mode-names.md`:
basic, free, kept up by volunteers; the Bothy Code (leave it as you found it; turn no one away). The product name is the
metaphor; no product claim yet.

**Chapter 2: The hut.** *Shows:* hills, mist, the small bothy with its window just lit (amber, the one warm colour on the
page). *Says:* what Bothy is, true today: one console for one machine; it finds what runs by asking Docker; open source,
MIT. Two honest lines: "It does not replace your tools. It shows and looks after what you already run." Only wording the
docs (`guide/index.md`) already supports.

**Chapter 3: What it does (inside).** *Shows:* a glass frame holding the **real console** (s5), three tabs the visitor can
click without JavaScript being required for the content (each a real anchor, `:target` or `<details>` driven): Services
(the service table with live-looking status from a fixture), Files (the reading surface), Health (the strip). Captions
beside it swap by chapter progress. *Says:* only what `docs/guide/` documents for the shipped modules: services found by
asking Docker, the files browser, the health strip, themes, roles and sign-in. Anything illustrative is labelled
"Example data". Nothing is claimed to be live unless it is.

**Chapter 4: Four sizes.** *Shows:* four places on the hill (Bivvy, Bothy, Basecamp, Cairn), each a card: what it adds,
its measured idle cost **on the runtime that applies**, and a state chip, **Installable now** or **Planned**, driven by
`facts.ts`. *Says* (from `mode-names.md`): Bivvy, a roof, a door, a lock (core, login, files, health strip); Bothy, four
walls and a fire (adds metrics, logs, alerts, backups); Basecamp, everything before the climb (adds dashboards, SSO,
Postgres, cluster UI, traces); Cairn, stack your own stones (pick modules one by one). Costs: use only measured numbers
from the repo (the Compose install's mini RAM gate is 704 MiB; modes above Bivvy are quoted only if a measurement exists,
otherwise the card says "not yet measured"). The k3s figures are **not shown**: that path is a design.

**Chapter 5: Install in one command.** *Shows:* a terminal block (the existing `Terminal.tsx`) with the one command and a
copy button, then the checklist the installer really runs (Docker present and answering, free memory against the gate,
port availability, release found, sha256 verified, attestation verified or skipped with the command), then "what it
did": three images pulled, one command to open the console, `bothy uninstall` and `purge`. *Says:* "Tested on Linux
amd64 with Docker." and, directly under it, the unproven list from s1 in plain words. A line gives both paths: a release
binary (`bothy install`) and a source checkout (s7). The lab time ("24 to 39 seconds in our lab, on a clean machine with
Docker") is stated with its source, not as a promise.

**Chapter 6: Leave it as you found it (open source and trust).** *Shows:* the night sky returns, stars, the window lit,
four link rows: source, licence (MIT), releases (with checksums and attestation), security policy (`SECURITY.md`).
*Says:* what the project does about trust, each line checkable: releases carry sha256 checksums and a build attestation;
the installer verifies before it changes anything and rolls back on failure; `uninstall` removes what it added; the
public site runs no analytics and sets no cookie. Closing line is the Bothy Code.

Header and footer on every page: wordmark, Docs, Install, Releases, Source, language switcher (hidden until Hebrew
exists), the sky's pause toggle.

## 4. Slices, ranked and sized

Sizes: **S** is under a day for one agent, **M** is one to three days, **L** is more. "Files" is the write set, so two
slices with disjoint files can run in parallel in separate worktrees (one writer per worktree). Ranking is by value to
the owner and by how much it unblocks.

| Rank | Slice | Size | Depends on | Write set (disjoint from others in the same wave) |
|---|---|---|---|---|
| 1 | **S1 Honest content pass**: replace the current Home with the seven chapters as plain, finished, styled sections on the still sky (no WebGL yet); rewrite `en.ts`, extend `facts.ts` (proven and unproven lists, modes with state chips, lab timings with sources); keep the guards green | M | none | `site/src/pages/Home.tsx`, `src/i18n/en.ts`, `src/facts.ts`, `src/components/chapters/*`, `site/src/styles/chapters.css` |
| 2 | **S2 Asset and provenance pipeline**: the three CC0 photographs moved from the spike to `site/public/sky/`, AVIF and WebP in two sizes, `PROVENANCE.json`, `scripts/check-assets.mjs` (every image has an entry, sha256 matches, sizes under budget), CSS still-sky fallback chosen by hour class | S | none | `site/public/sky/*`, `site/scripts/check-assets.mjs`, `site/src/styles/sky-still.css` |
| 3 | **S3 Production sky**: `site/src/sky/` (WebGL2 shader, hour table, pointer lean and wake, capability probe, pause, reduced-motion, `?hour=`, dial), consuming the other agent's sun, moon and text-light interface once merged; lazy island on Home; keyboard nudge control | L | S2; the sky-spike agent's sun/moon/text-light (stub interface until then) | `site/src/sky/*`, `site/src/enhance-sky.ts`, `site/src/styles/sky.css` |
| 4 | **S4 Contrast and still-image checker**: `scripts/check-sky.mjs`: renders 48 stills per viewport through `?hour=`, samples the pixels behind text, writes the table of WCAG and APCA results, fails on a fail; also produces the screenshots reused for OG images (S10) | M | S2, S3 (works against S1 with the still sky first) | `site/scripts/check-sky.mjs`, `site/test/sky/*` |
| 5 | **S5 Real-UI components**: a build step that renders chosen console components to static HTML+CSS from fixtures (Services table, Files view, Health strip, Modules list) with the console's own tokens scoped under `.console-frame`; fixtures compared to the product's shapes by a test; glass frame, tabs, captions | L | none (reads `apps/bothy-web`, never edits it) | `site/src/console/*`, `site/fixtures/console/*`, `site/src/styles/console.css`, `site/scripts/render-console.mjs` |
| 6 | **S6 Hills, mist and the hut (still mock first)**: layered SVG ridges, mist, the bothy with a lit window, graded by the hour table; a still mock for the owner to judge, then wire into chapters 1 and 2 | M | S3's hour table; S1 | `site/src/scene/*`, `site/src/styles/scene.css` |
| 7 | **S7 Story scroll**: chapter state machine (IntersectionObserver), the pinned descent (chapters 0 to 2), scroll-linked camera and cloud crossing, sticky captions for chapter 3, progress dots, "skip the descent" link, reduced-motion and no-JS paths, keyboard and focus order | L | S1, S3, S6 | `site/src/story/*`, `site/src/styles/story.css` |
| 8 | **S8 Install page and docs polish**: the two paths (s7), proven and unproven list, copyable commands, checksums and `gh attestation verify` lines from the release feed, docs pages wearing the calm sky band, docs search kept; allowlist review for any new page | M | S1 | `site/src/pages/Install.tsx`, `src/pages/Docs.tsx`, `site/docs-allowlist.json`, `src/styles/pages.css` |
| 9 | **S9 Accessibility and no-JS audit**: pass over every page with the checks in s8, fix list, `lang`, landmarks, focus rings, reduced-motion check; the accessibility statement page (IS 5568 note) | M | S1, S7, S8 | `site/src/pages/Accessibility.tsx`, fixes across files (so it runs after the write waves, not beside them) |
| 10 | **S10 SEO and share images**: titles, descriptions, canonical, sitemap (exists), JSON-LD `SoftwareApplication`, OG and Twitter images generated from the sky at a chosen hour with the wordmark, by a script at build time | S | S3 or S2 (stills), S4 | `site/scripts/og.mjs`, `src/components/Seo.tsx`, `site/public/og/*` (generated, committed or built) |
| 11 | **S11 Budgets and CI**: `scripts/check-budgets.mjs` (bytes per route and per asset class, script cap), a Lighthouse-like offline audit (s9), screenshot job at the hours, link and leak scans in `ci.yml`, a `site` job that runs only on `site/**` changes | M | S2, S4; grows with each slice | `site/scripts/check-budgets.mjs`, `.github/workflows/ci.yml` (site job), `site/test/*` |
| 12 | **S12 Hebrew** (after the story): `he.ts`, RTL check at every hour and chapter, bidi for commands and paths, plural forms, the switcher | M | S1 to S9 settled | `site/src/i18n/he.ts`, `locales.ts`, `styles/rtl.css` |
| 13 | **S13 Go live**: owner steps from `site/README.md` (Pages source, custom domain, Cloudflare DNS grey cloud, verify domain), run the workflow once by hand, review, then add the `push` trigger on `site/**` and `docs/guide/**` | S | S1 minimum; recommended after S7 and S9 | `.github/workflows/site-pages.yml` only |

**S7 as built (2026-11-18, owner feedback applied):** the sky is the page's background, not the hero's: one fixed stage behind
every chapter (`site/src/story/`, `styles/story.css`). Hills, hut and ground were dropped by the owner, so the story is
sky only. The descent is the *camera*, which is pinned (scroll progress to the shader's pan, zoom, cloud rise and
crossing, a sea of cloud, a glow boost and a clock that runs on toward night), while the words stay in normal flow, one
screen each for chapters 0 to 2, so nothing is hard to read, link or print and no focus is trapped. Chapters transition
by one long eased veil and masked scene backdrops (lit cumulus behind chapter 3, cloud deck behind 4, twilight bands
behind 5, loaded only when near), never by a border or a band. Content floats on glass panels (blur on three large
panels only), with scroll-linked drift by CSS `animation-timeline: view()` and staggered reveals. No JS or reduced
motion: the still sky, the same veil and every section as a plain page.


**S10 as built (2026-11-18):** one row per page in `site/src/seo.ts` feeds the head (`src/seo-head.ts`, called from the
prerender, not a React `Seo.tsx`, since the head is written outside React). Share images are drawn from the CC0 sky
photographs rather than the S4 stills: the stills are whole-page screenshots with the site's own text in them and need
the WebGL sky at software-GL speed. `scripts/og.mjs` renders them (JPEG, since Facebook and LinkedIn do not render WebP
reliably), checks each line's contrast with S4's maths and floors, and commits them with a `PROVENANCE.json`;
`scripts/check-seo.mjs` holds the built pages, sitemap, robots and 404 to the table.

Rank notes: S1 is first because it makes the site honest and finished before any effect exists (a visitor sees something
true on day one); S2 to S3 are the owner's chosen visual core; S5 is early because it is large, independent and the
site's strongest "real product" signal; S13 can happen as early as after S1 plus S2 if the owner wants the domain live
sooner, because every later slice is just another deploy.

### Waves and parallelism

| Wave | Slices (parallel, separate worktrees) | Why it is conflict-free |
|---|---|---|
| A | **S1**, **S2**, **S5** | Disjoint write sets (Home and strings; `public/sky` and its script; `src/console` and fixtures). S5 only reads `apps/bothy-web` |
| B | **S3**, **S6**, **S8**, **S4 against the still sky** | `src/sky`, `src/scene`, the Install and Docs pages, `scripts/check-sky.mjs`. Shared files: `en.ts` (additive keys; merge by rebase) and `Home.tsx` (S3 and S6 only add islands and imports in S7) |
| C | **S7**, **S10**, **S11** | `src/story`; `scripts/og.mjs` and `Seo.tsx`; `check-budgets.mjs` and CI. `Home.tsx` is touched by S7 alone |
| D | **S9** | Cross-cutting fixes: runs alone |
| E | **S12**, **S13** | S12 owns `i18n` and RTL CSS; S13 owns the workflow. Independent |

Two rules for every agent: one writer per worktree, and `en.ts` is append-only inside a wave (new keys, no reordering),
so rebases are mechanical. Nobody under `apps/bothy-web/` is edited by this plan.

## 5. Real product UI: reuse, licence, and design

**Licence:** the repository is **MIT** (`LICENSE`, copyright the owner), so the console's CSS tokens and components may be
reused in the site. No third-party component from the console carries a different licence that the site would ship; the
slice S5 author runs a check of `apps/bothy-web/web/package.json` dependencies that the rendered components import
(a component that pulls a library, such as the three.js folder under `components/three`, is **not** used in the site).

**What is reused:** the console's design tokens (`apps/bothy-web/web/src/index.css`: the four surface steps, `--fg`,
`--fg-muted`, `--line`, `--accent`, the reserved `--st-*` status colours, the type and spacing scales) and these
components, as markup and CSS, not as the running app: `ServiceTable` / `ServiceRow`, `SortHeader`, `Tabs`, `states`
(empty, loading, error), the `ui/` primitives (`Button`, `Disclosure`, `Dialog`, `Menu`, `Popover`, `InfoHint`, `Icon`),
the Files page, the health strip. The design rules come with them: status colour reserved for status, panel accents never
encode state, four surface steps.

**How:** `scripts/render-console.mjs` server-renders the chosen components against `fixtures/console/*.json` into static
HTML fragments that the page inlines in the glass frame; the console CSS is scoped under `.console-frame` so it cannot
leak into the site chrome and the site's peat palette cannot leak into the console. Interaction is progressive: tabs and
row details work as anchors and `<details>`; the small enhancement script adds sorting and filtering on the fixture rows,
labelled "Example data".

**Truth guard:** a test compares each fixture's shape and the visible column names with the component's types, so when the
product's UI changes and the fixture does not, CI fails and the site cannot show a screen that no longer exists.

**Fonts:** the console's font stack is system fonts (no webfont request). The site does the same for body; if a display
face is wanted for the wordmark, one open-licence (SIL OFL) family is self-hosted, subset to the glyphs used, in WOFF2,
with a `PROVENANCE.json` entry. No request to a font service, ever.

## 6. Scroll mechanics

* **Pinned vs not.** Pinned: chapters 0 to 2 only, as one scene of about 300 vh. Everything else is normal flow. The
  chapter 3 frame is `position: sticky` within its section so captions scroll past it. No horizontal scroll hijack.
* **Always a way past.** The first focusable element is "Skip to install"; a visible "Skip the descent" control jumps to
  chapter 2; every chapter has an id and a heading and is a link target; `#` links work with and without JavaScript.
* **Driver.** CSS scroll-driven animations (`animation-timeline: view()`) where supported for pure CSS transforms; the
  sky shader's camera parameter is fed from one `scroll` listener (passive) read in the shader's own animation loop, never
  layout-reading in the handler. No scroll-jacking: the browser's native scroll, momentum and keyboard are untouched.
* **Performance budget in motion:** one `requestAnimationFrame` loop in total; only `transform` and `opacity` animate in
  the DOM; the canvas is sized to the viewport times `min(devicePixelRatio, 1.5)` (times 0.85 under 900 px), stepped down
  after a slow-frame probe (three consecutive frames over 24 ms) and stopped when off screen or the tab is hidden
  (`IntersectionObserver`, `visibilitychange`); `Save-Data` starts at the still sky.
* **`prefers-reduced-motion: reduce`:** no shader animation, no pointer physics, no scroll-linked camera; the descent
  becomes a plain scroll through still bands; the dial and the pause control still work. A toggle on the page lets a
  visitor who has not set the preference ask for the same.
* **No-JS path:** the server-rendered page is the whole story: still sky chosen by CSS, the seven sections in order,
  the glass frame showing its first tab's fixture, install commands as plain text with the copy button simply absent. The
  dial is hidden with `<noscript>`-free logic (it is only inserted by script).
* **Keyboard:** every control reachable in reading order; a visible focus ring on every state (contrast checked); dial is a
  `role="slider"` with arrow, Home and End keys and an `aria-valuetext` such as "5:30 pm, dusk"; the sky nudge and the
  pause control are buttons; progress dots are links, not decoration; `Esc` closes any dialog; no keyboard trap in the
  pinned scene (tab order moves through the sections' content even while pinned).
* **Print:** a print stylesheet drops the sky and prints the story as a document.

## 7. Docs pages and the install page

**Docs** keep rendering the allowlisted Markdown (14 guide files), now with the calm sky band header, an in-page table of
contents, a "last built from commit" footer, and search. Rules unchanged: only allowlisted files render; `docs/kb`,
`claude-notes`, credentials and `.env*` never; a link to an unrendered file becomes plain text; the leak scan runs on the
output. New docs are added by editing `docs-allowlist.json` after reading the page for addresses, hostnames and credentials
(S8 reviews `backups.md`, which was left out on purpose, and keeps it out unless cleaned).

**Install page** shows two honest paths, side by side, each with what it needs and what is proven:

| | `bothy install` (a release binary) | From a source checkout |
|---|---|---|
| For | someone who just wants Bothy on a machine with Docker | someone who wants to read, change or contribute |
| Steps | download the release archive for linux/amd64, `sha256sum -c` against `checksums.txt`, optionally `gh attestation verify`, run `bothy install` (the installer finds its own release, verifies, pulls three images, starts the stack, prints the address) | clone the repository, follow the checkout path in `docs/guide/installing.md` |
| Proven | **Yes**, lab, stock v2026.11.2, linux/amd64, Docker only (`bothy-install.md` 10e) | the repository's own `just` flow is how the project is developed; the page states only what `guide/installing.md` states |
| Unproven | the list in s1.3, printed as a list | same list where it applies |
| After | `bothy update`, `uninstall`, `purge` described with what each removes | `guide/upgrading.md` |

The page's commands and version are generated from the release feed and `facts.ts`, never typed twice. The exact
copy-paste download line and checksum steps come from the release notes of the newest release. If a newer release exists
than `PROVEN_RELEASE`, the page says "latest release" and "last release the installer was proven against" separately.

## 8. Accessibility

**Target: WCAG 2.2 AA** on every page, in every theme, at every hour of the sky. Concretely: text contrast per s6 of the
design (pixel-sampled per hour); `lang` and `dir` on `html`; one `h1` per page, ordered headings, landmarks
(`header`, `nav`, `main`, `footer`); skip link; visible focus (2 px ring with 3:1 against adjacent colours, never
removed); targets at least 24 by 24 CSS px (44 on touch); no information by colour alone (status chips have words);
reflow at 320 px and 400 percent zoom with no two-dimensional scroll; text spacing overrides do not break layout; motion
per s6 with a pause control (WCAG 2.2.2); no flashing; every image has an alt or is marked decorative; the canvas is
`aria-hidden` and the same information exists as text; the dial and controls follow the ARIA Authoring Practices
patterns; screen-reader names for the copy buttons and the tabs; the terminal blocks are real text.

**IS 5568 (Israel).** The Israeli standard is WCAG 2.0 AA with national changes and applies to services offered to the
Israeli public. Meeting WCAG 2.2 AA covers its substance, but the standard has its own rules that need the Hebrew site
and, for a business, an accessibility statement and a named coordinator. This site is a free, open-source project page;
whether the legal duty applies to the owner personally is a legal question, **not answered here and not legal advice**.
The plan does the cheap, safe part: an **accessibility statement page** (what is met, how it was checked, known gaps, how
to report a barrier) in S9, and a Hebrew version in S12 that is tested against the Hebrew-specific points (RTL focus
order, bidi in commands, Hebrew labels for the controls). The owner decides whether to appoint a coordinator (owner
decision O5). The `israeli-accessibility-compliance` skill is the reference when S9 and S12 run.

## 9. Performance budgets

| Budget | Limit | How it is enforced |
|---|---|---|
| First paint, desktop (HTML, CSS, still sky, text; over the wire, compressed) | 120 KB | `check-budgets.mjs` on the built `dist/` plus a request trace |
| First paint, phone | 60 KB | same, at 390 wide |
| Measured today (spike) | 56 KB desktop, 27 KB phone | recorded as the baseline; a rise of more than 20 percent fails |
| JavaScript for the home page | 60 KB gzipped total, 25 KB of it before the sky loads | script size check |
| Shader and sky module | in the 60 KB above | same |
| Console frame (HTML and CSS for chapter 3) | 60 KB gzipped, lazy-hydrated | size check |
| All photographs (3 skies, two sizes each) | 300 KB total | `check-assets.mjs` |
| Any docs page | 80 KB | size check |
| Requests to other origins | zero | leak and link scans |
| Frame rate (real laptop, real phone) | 55 fps median on the owner's laptop; the probe degrades under 50 | **manual, on real devices only** (this box cannot measure it) |
| Layout shift | CLS 0 on the hero (the still sky is sized before it loads) | Lighthouse-like check |
| Largest contentful paint | under 1.5 s on a throttled "fast 4G" profile | Lighthouse-like check, offline |

## 10. Analytics: none

**Recommendation: no analytics on the public site, now or at launch.** Reasons:

1. The brand is a free shelter that turns no one away; a tracker contradicts it, and "no analytics, no cookies, no third
   parties" is a claim the site can make and CI can prove (the leak scan already rejects other origins).
2. A cookie-free, self-hosted counter would still need a server the project does not run: the site is static files on
   Pages, and a counter means either a third party or a box exposed to the internet, which the project's own rules
   against exposing the box rule out.
3. Nothing the owner has to decide needs the data yet. The signals that matter are free and private: GitHub stars,
   release download counts (from the release feed the site already reads), and issues.
4. The decision is reversible: if the owner later wants counts, the least bad option is **server logs of the host**
   (Cloudflare's privacy-friendly, cookie-free web analytics measures at the edge with no script; or a self-hosted
   counter behind a separate subdomain). Either needs a separate owner decision (O4) and an update to the privacy line.

## 11. SEO and share images

* Per page: unique `<title>` and meta description from `en.ts`, canonical from `SITE_ORIGIN`, `hreflang` when Hebrew
  exists, a sitemap and `robots.txt` (already generated), a `404` page, semantic headings.
* Structured data: `SoftwareApplication` (name, operating system "Linux", licence, source URL, latest release) built from
  the release feed; no review or rating markup, ever.
* **OG and Twitter images are generated from the sky**: `scripts/og.mjs` renders the hero at a fixed golden-hour or dusk
  keyframe (the same pixels the contrast check already produces), adds the wordmark and the one line, writes a 1200 by
  630 image (about 60 KB, AVIF or JPEG for compatibility) per page type: home, docs, install, releases. Deterministic
  (`?hour=` fixed), so the image changes only when the sky or the words change, and a test fails when the image is missing
  or over 150 KB. Alt text is set in the meta.
* Per-release pages carry the version in the title; the release feed fixes dates.
* The site names no private host, address or machine (the leak scan keeps this).

## 12. Testing

| Check | What it does | Runs where |
|---|---|---|
| Unit | docs rendering, releases, facts, fixtures against component types (`npm test`) | CI, here |
| Build and verify | `npm run build`, `verify-dist.sh` (logical CSS, expected files), `check-public.mjs` (leak scan on all output) | CI, here |
| Link and anchor scan | `check-links.mjs`: internal links, anchors, no external requests in output | CI, here |
| Leak scan | tailnet shapes, token prefixes, key blocks, owner machine names, over rendered docs and the whole `dist/` | CI, here |
| Provenance | `check-assets.mjs`: every image listed with licence, source, hash; sizes | CI, here |
| Sky stills at hours | `check-sky.mjs`: 48 hours by 2 viewports through `?hour=`, software GL, deterministic frame stepping (the box has no frame clock, so the harness steps time itself instead of waiting on `requestAnimationFrame`); screenshots kept as CI artefacts | CI, here |
| Contrast per hour | pixel-sampled WCAG and APCA table (design doc), fails on a miss | CI, here |
| No-JS and no-WebGL | the page loaded with JavaScript disabled and with WebGL forced off: all seven sections present, still sky shown, no console error | CI, here |
| Reduced motion | emulated `prefers-reduced-motion`: no canvas animation, no scroll camera | CI, here |
| Lighthouse-like, offline | a local run of Lighthouse against the built `dist/` served from disk, or if the dependency is refused, a script asserting the same things (budgets, landmarks, alt text, `lang`, meta, tap-target size, CLS) with axe-core for accessibility | CI, here |
| Keyboard | a scripted Tab walk: every control is reached in order, visible focus on each, no trap in the pinned scene | CI, here |
| Budgets | bytes per route and asset class (s9) | CI, here |
| Frame rate | median fps on the owner's laptop and a low-end phone, with the probe's chosen tier reported | **manual, real device** |
| Real-device look | the owner looks at the site on phone and laptop at morning, noon, dusk and night | **manual** |

Every new dependency in the test chain (Lighthouse, axe-core) is vetted before it is added (read, pinned, no postinstall,
no network at run time), as the project does for any package, and added to `site/package-lock.json`.

## 13. Release and deploy

* **Now:** `site-pages.yml` is manual dispatch only. Slices merge to `main` through normal PRs with the site checks
  (S11) green; nothing deploys. The owner runs the workflow when they choose.
* **Before first deploy** (owner steps, `site/README.md`): Settings > Pages > Source "GitHub Actions"; custom domain
  `bothybox.com`; verify the domain in GitHub account settings; Cloudflare DNS in **DNS-only (grey cloud)** with the four
  apex `A` records (and optionally `AAAA`) and `www` as a `CNAME`; wait for the certificate; enforce HTTPS.
* **First deploy:** run the workflow by hand on a reviewed `main`; check the live page with the real-device pass (frame
  rate, looks at four hours), the leak scan on the live bytes, `https://bothybox.com/` redirect from `http://`, the
  `CNAME`, the sitemap, the OG images in a link preview tool.
* **Later, only when the owner approves:** add `push` on `main` with `paths: [site/**, docs/guide/**]` so a doc edit or a
  release reaches the site by itself; keep `workflow_dispatch` as well. A failed check blocks the deploy job; the previous
  deployment stays live (Pages keeps the last good artefact).
* **Rollback:** re-run the workflow on the previous commit. No server state exists to undo.
* **Docs and releases freshness:** `fixtures/releases.json` refreshes by `npm run refresh-releases` (reviewed diff); a
  scheduled job that opens a PR for it is an optional later slice, not a push to `main`.

## 14. Risks

| Risk | Mitigation |
|---|---|
| The descent looks pasted on | S6 starts with a still mock the owner judges before any animation |
| Duplicate sun, moon, text-light work | Ownership table in the design doc; S3 consumes the spike's interface and does not re-derive it |
| Performance cannot be measured here | Real-device pass is part of "done"; this box measures bytes and looks only |
| A claim outruns the proof | Facts live in `facts.ts` with a source line; the proven and unproven lists are printed on the page; a doc-facts style check for numbers |
| Console components drift from the product | Fixtures are compared with component types in CI |
| Contrast fails at an odd hour | Pixel-sampled table in CI; fix in the hour table, never lower the bar |
| Scroll feels hijacked | Native scroll only; pinned scene limited to three screens; always a skip link |
| The site goes live by accident | Workflow stays manual until O3 |
| Scope | The sky (S3) and the honest content (S1) are worth shipping alone; the descent (S6, S7) is the part that may slip |

## 15. Decisions the owner must make (only these)

| # | Decision | Recommendation |
|---|---|---|
| O1 | Approve the **still mock** of the hills and the bothy (end of S6) before the animation is built | Yes, judge on a real screen at dusk and at night |
| O2 | The site palette (peat, granite, heather, lit-window amber) and one display face for the wordmark | Approve the values after seeing them against the photographs; if no face is wanted, system fonts only |
| O3 | **When to go live**, and when to add the push trigger | Go live by hand once S1 and S2 are merged if you want the domain up early (an honest, finished page with the still sky); add the push trigger only after S9 (accessibility) |
| O4 | Analytics | None (s10) |
| O5 | The accessibility statement: wording of the legal position and whether to name a coordinator | Publish the factual statement in S9; take legal advice before saying anything about IS 5568 duty |
| O6 | Which modes the page may call **installable now**, once more modules are proven | Decide at S1 from what `bothy install` proved; until then Bivvy only is claimed |
| O7 | Hebrew timing and who reviews the Hebrew words | After S9; the owner or a native reviewer must read the Hebrew before it ships |
| O8 | The owner's personal site `yehudabriskman.com`: link to it or not from the footer | Link it from "about the maintainer" only if you want it; the plan does not |

Everything else in this document is decided by the recommendations above and may be changed by the owner at any time.
