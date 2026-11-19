# The Bothy website

Static, prerendered, built from this repository. React 19 renders the pages at build time only; the one script
that ships (`src/enhance.ts`) adds copy buttons, docs search and the install menu, and no page needs it.

```
npm ci
npm run build        # tsc, client build, SSR build, prerender into dist/
bash scripts/verify-dist.sh
npm test
npm run check:sky    # opt-in: pixel-sampled sky contrast, 8 hours x 2 viewports (needs a build; stills in .check-sky/)
```

## Quality gates, and how to run each one

Every gate below runs against a fresh build (`npm run build`) and needs no network. CI runs them in the `site` job of
`.github/workflows/ci.yml` (only when a PR touches `site/`, `docs/guide/`, the console's styles under
`apps/bothy-web/web/src/`, or the workflow; always on a push to main; the rule is `scripts/ci-changes.sh site`), and the
browser ones in `.github/workflows/site-browser.yml`.

| Command | What it protects | In CI |
|---|---|---|
| `npm run format:check`, `npm run lint`, `npm run typecheck` | Style, obvious bugs, types | `site`, every run |
| `npm test` | Unit tests: docs safety, console fixtures against the product's shapes, sky maths, these gates' own rules (`test/budgets-meta.test.mjs` feeds each rule a page that breaks it) | `site` |
| `npm run check:assets` | Every sky photograph has a CC0 provenance entry with a matching sha256, and fits its byte budget (40 KB desktop, 20 KB phone, 300 KB all) | `site` |
| `npm run check-console` | The rendered console (`src/console/generated/`) is current with its fixtures and the console's stylesheets | `site` |
| `bash scripts/verify-dist.sh` | Every route exists, no physical left/right in the CSS, search index not empty, then `check:links` (every internal href, src and `#fragment` resolves to a file and an id) and `check-public` (no off-allowlist doc, tailnet address or credential shape in the output) | `site` |
| `npm run check:meta` | The offline Lighthouse-like audit: `lang`, charset, viewport, a unique non-empty title, a meta description, the canonical equal to origin + path, exactly one level-1 heading (`aria-level` counts), no skipped heading level, no duplicate id, `target=_blank` with `rel=noopener`, every `<img>` with `alt` and `width`/`height` (CSS-sized `/sky/` backdrops exempt), and **no request to another origin** from any HTML, CSS or JS file (so nothing third-party can block rendering, and the site works offline). Known issues owned by a later slice are listed in `KNOWN` and print as warnings | `site` |
| `npm run check:budgets` | Gzip bytes per route and asset class (table below). `--propose` prints measured + 15 % for every row; `--json` for tooling | `site`, table in the job summary |
| `npm run check:dist` | `verify-dist.sh`, `check:meta` and `check:budgets` in one go | - |
| `npm run check:story` | Chromium: the console demo plays from real wheel, key and touch scrolling at seven viewports, with WebGL off, the sky blocked and reduced motion | `site-browser.yml`, when `src/story`, `src/sky`, `src/console`, `src/styles`, Home, the stills or the lockfile changed (`ci-changes.sh site-browser`), nightly, by hand |
| `npm run check:sky` | Chromium: WCAG 2.2 and APCA contrast of every text element over the sky, from pixels, 8 hours x desktop and phone (`check:sky:full`: 48 hours) | as above; table uploaded as `site-contrast` |
| `npm run check:a11y` | Chromium: axe-core (serious/critical fail) on every page at 1440 and 390, text contrast outside the story, 320px reflow | as above, and also when a component or page changed |
| `npm run screenshots` | Not a gate. Home at 06:30, 13:00 and 22:00 plus Install and the docs index, desktop and phone, into `.screenshots/` | every site change, uploaded as `site-screenshots`; never blocks |

The browser checks need a Chromium: playwright-core's own (`npx playwright-core install --only-shell chromium`) or
`CHROMIUM_PATH`. CI caches the headless shell under the playwright-core version, so it downloads once per version.

Measured in CI on PR #428 (2026-11-18, warm npm cache): the `site` job 20 s; the browser checks job 2 min 19 s
(check:story 65 s, check:sky 58 s, the headless shell download 4 s on a cache miss); the screenshots job 47 s,
running beside it. From the plan job to the last site job: about 3 min 10 s, under the other tiers' wall time. A PR
that touches nothing the site builds from skips all three. Locally on the WSL box the same checks take longer (story
69 s, sky 149 s, screenshots 87 s): its headless Chromium runs few animation frames.

### Byte budgets

Measured 2026-11-18 at 5f6bd95; limits are those plus about 15 %, in `scripts/check-budgets.mjs` (`LIMITS`). gzip at
zlib's default level, which is what a static host sends. First load is the HTML, the scripts and stylesheets it
names, its non-lazy images, and the one still-sky photograph its stylesheet picks (the largest of the hours, since the
hour decides). The sky island (`mount`, `progress`, `enhance-sky`, reached only by `import()`) is not first load: the
page is complete without it, so it has its own cap.

| Budget | Measured KB | Limit KB | Design budget |
|---|---:|---:|---:|
| First load `/`, desktop | 72.8 | 84 | 120 |
| First load `/`, phone | 57.8 | 67 | 60 |
| First load, worst other route (docs/configuring), desktop / phone | 69.6 / 54.6 | 81 / 63 | |
| HTML: home / largest page / largest doc | 13.5 / 10.1 / 10.4 | 16 / 12 / 12 | |
| JS entry (with static imports) | 3.1 | 4 | |
| JS lazy sky island | 15.8 | 19 | |
| JS, all shipped | 18.9 | 22 | |
| CSS, all | 24.3 | 28 | |
| Lazy images on `/` (scene backdrops, the `<picture>` still) | 104.4 | 121 | |
| Search index | 37.0 | 43 | |
| Dev pages (`sky-spike/`, `scene-mock/`), raw | 748 | 861 | |
| Share cards and icons (`og/`, `apple-touch-icon`, `icon-192`/`512`, `site.webmanifest`), raw | 297.9 | 343 | |
| All of `dist/` without those, raw (1905.5 after S10) | 1889 | 2173 | |

Share cards, home-screen icons and the manifest are fetched by a link unfurler or an "add to home screen", never by a
page load, so they have their own row and stay out of the `dist/` total; `check:seo` also caps each card at 120 KB.

The design budget is from `docs/plans/thin-bothy/website-sky-design.md`; the script warns when a row passes it. The
phone first load has 2.2 KB left under the design's 60 KB: the stylesheet (24 KB of the 58) is where to look first.
To raise a limit, change `LIMITS` in the PR that grows the page and say why.

## What it renders, and from where

| Page | Source |
|---|---|
| Home, Install | `src/i18n/en.ts` (every word) and `src/facts.ts` (what the lab proof covered) |
| Docs | the Markdown listed in `docs-allowlist.json`, rendered by `src/docs/` |
| Releases | `fixtures/releases.json`, a committed snapshot. The build needs no network. `npm run refresh-releases` rewrites it from GitHub; review the diff and commit it |

## Keeping private things out

Two guards, both in the build and re-checked on the output by `scripts/check-public.mjs`:
only files in `docs-allowlist.json` render (and anything under `kb`, `claude-notes`, `secrets`, `credentials` or
`.env*` is refused even if listed), and every rendered document and every output file is scanned for the shapes in
`leak-patterns.json` (a tailnet (CGNAT range) address, `.ts.net` names, token prefixes, key blocks, the owner's
machine names). `docs/kb` is never rendered; a link to it becomes plain text.

## One build, two homes

`src/config.ts` is the only place that knows the address. `SITE_ORIGIN` (default `https://bothybox.com`) feeds the
canonical links, sitemap, robots and `CNAME`; `SITE_BASE` (default `/`) is the mount path. A build for a box has no
public origin: `SITE_ORIGIN= SITE_BASE=/ npm run build` emits no canonical, sitemap or CNAME. No Host() rules or
edge assumptions: it is plain files.

## Search and share previews

`src/seo.ts` is one row per page: title (at most 60 characters), description (110 to 160), and which share image.
`src/seo-head.ts` turns the row into the head: title, description, theme-color, canonical, Open Graph, Twitter card,
icons and manifest, and on the home page JSON-LD (`WebSite` and `SoftwareApplication`: Linux, free, the repository's
MIT licence; no rating, review or price). `npm run check:seo` (also run by `verify-dist.sh`) checks the built pages,
the sitemap, robots.txt and the 404 page against the table, and fails on a missing field or a value out of range.

The share images (`public/og/*.jpg`, 1200 x 630 JPEG, under 120 KB each), `favicon.svg` and the PNG icons are drawn
by `npm run og` from the CC0 sky photographs and the BothyBox mark in `src/brand/cube.ts`, contrast-checked line by line with the S4 maths, and
committed with `public/og/PROVENANCE.json` (bytes, sha256, renderer, font, contrast). Re-run it after changing a
card's words in `src/seo.ts`: the check fails until the images match. They are not loaded by any page, so they sit
outside the photograph budget in `check-assets.mjs`.

The mark (the Cube icon and the drawn wordmark, chosen 2026-11-18, see `docs/plans/thin-bothy/brand-options.md`) has
one source, `src/brand/cube.ts`: the header and footer lockup (`components/Brand.tsx`), the icons, the share cards, and
the first-visit intro (`src/brand/splash.ts`, a lazy chunk: the sky alone, the Cube opens, and the page assembles
round the lockup as it flies into the header). `splash-gate.ts` decides in an inline head script before the first
paint: once per browser session, home page only, never with reduced motion or a blocked sessionStorage, never under
automation; it hides only visually (`bb-intro`, `styles/intro.css`) and gives up at 3.5 s. `?splash=1` forces it,
`?splash=0` stops it, `?splash=hold` builds it paused for a screenshot harness (`window.__bbSplash.seek(ms)`).

## Hebrew

Add `src/i18n/he.ts` (typed as `Messages`), register it in `src/i18n/locales.ts` with `dir: 'rtl'`, and add it to
`ENABLED_LOCALES`. Routes, `lang`/`dir`, `hreflang` and the language switcher follow. The stylesheet uses logical
properties only (`verify-dist.sh` fails on `left`/`right`).

## Going live (not done; the owner's steps)

`.github/workflows/site-pages.yml` is `workflow_dispatch` only and has never run.

1. GitHub repo Settings > Pages > Source: **GitHub Actions**. Custom domain: `bothybox.com` (enforce HTTPS once the
   certificate is issued).
2. Cloudflare DNS for `bothybox.com`, **DNS only (grey cloud)** until GitHub has issued the certificate: four `A`
   records for the apex to `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`; optionally the
   four matching `AAAA` records; and `www` as a `CNAME` to `yehudabriskman.github.io`. Verify the domain in GitHub
   account settings first, so nobody else can claim it.
3. The build writes `dist/CNAME` itself from `SITE_ORIGIN`.
4. Run the workflow once by hand, then add a push trigger.
