# A Bothy website, served from the box and on the web (future)

_Written 2026-11-17. A **later** item, deliberately not in the Thin Bothy phases. Nothing here is built; this
records the owner's direction and the rules that keep it cheap to add when its time comes._

## What the owner asked for

A website, in the spirit of a product site the owner has in mind (the exact reference is **not yet captured here**;
see the questions below), that is **served on the local network by the box itself** and also carries the docs
"and more and more". In short: a box that installs from one download should also be able to explain itself, offline,
to anyone on the same network.

## Direction

1. **A module, not a special case.** The site is one more module in `stack/modes.yml`, served through the same
   edge as every other module. It is a static site, so it costs almost no memory and needs no login of its own to
   read public documentation. Adding it must be a data edit (the claim `bothy-install.md` s10b tests), not new Go.
2. **One source of truth.** The pages are generated from the repo (`docs/`, the operation catalog, the release
   manifest), never written a second time. A docs build step in CI fails on a broken link, and the build output
   is embedded or published by digest like every other image, so a box serves the docs that match its version.
3. **Works offline on a LAN.** No CDN, no external fonts, no analytics, no third-party scripts. A box with no
   internet access still serves a complete site for its own version.
4. **Useful, not decorative.** Candidate content, in rough order: install and update guide with the copy-paste
   download line and checksums; the docs for the running version; the live module and update status (the read-only
   `/v1` API, once it has token or session access); changelog and what changed between versions; troubleshooting
   runbooks; a download page for the CLI binaries (the release assets) and, later, packages (D29 to D39).
5. **Two homes, one build.** The same generated site can also be published publicly (GitHub Pages is already the
   proposed home of the apt repository, D32), so the public site and each box's local site cannot disagree.

## Rules that already apply (do not relax them for the site)

- Access is IP and port. **No Host() routers**; exact `Path()` routes only (README rule 1 in the notes).
- Static files only; nothing the site serves may reveal settings values, tokens or any secret. Operational data
  shown comes from the read-only `/v1` API, with its trust typing for third-party text.
- Hebrew and RTL support must be designed in from the start (the box's owner works in both), using the existing
  design skills and `hebrew-i18n` guidance.

## Why not now

The install path and the first real release come first (they are what a site would describe), and a site written
before the product settles would be rewritten. The docs already exist as Markdown in the repo, so nothing is lost
by waiting; the rules above keep the later work small.

## Reference and domain (answered 2026-11-17)

**Reference: WindoM's site (`windom.app`, owner's project, `~/projects/WindoM/site`).** What it is, read from its repo:
a React 19 + Vite single-page app with a landing page and a docs section, **prerendered to static HTML at build time**
(`site/scripts/prerender.mjs`, plus a generated sitemap and search index), checked by a script that every public URL
still exists (`verify-dist.sh`), and published by a GitHub Actions workflow to **GitHub Pages**
(`deploy-site.yml`, `site/public/CNAME` holding the domain). Its release feed is built from `CHANGELOG.md`, so a release
reaches the site by itself.

**Domain: `bothybox.com`, bought by the owner on 2026-11-17** (registrar: Cloudflare, not yet pointed anywhere).

Consequences for this plan (decisions, not yet built):

- Same shape as WindoM: static, prerendered, built in CI from this repository, deployed to Pages with a `CNAME`. No server
  to run for the public copy. Reuse its structure and scripts as a starting point; do not share code across repos yet.
- The copy each box serves is the **same build output**, served by a static module on the box (one source of truth).
- The release feed comes from this repository's release notes and `release-manifest.json`, so the site never lists a
  version that does not exist.
- The apt repository (D32) can live on the same Pages site or on a subdomain (`apt.bothybox.com`); decide when D32 starts.
- An existing personal site, `yehudabriskman.com`, already carries a Bothy project page and blog area; the new site does
  not replace it.

## Questions still open

1. Languages: English only first, or Hebrew alongside (the personal site is bilingual with RTL)?
2. Does the docs section render the existing Markdown in `docs/`, or is it written separately for readers outside the repo?
