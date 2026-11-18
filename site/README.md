# The Bothy website

Static, prerendered, built from this repository. React 19 renders the pages at build time only; the one script
that ships (`src/enhance.ts`) adds a colour-scheme choice, copy buttons and docs search, and no page needs it.

```
npm ci
npm run build        # tsc, client build, SSR build, prerender into dist/
bash scripts/verify-dist.sh
npm test
npm run check:sky    # opt-in: pixel-sampled sky contrast, 8 hours x 2 viewports (needs a build; stills in .check-sky/)
```

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
