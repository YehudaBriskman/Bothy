import { createHash } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { BASE, ORIGIN, absolute, href } from './config.ts';
import { seoHead } from './seo-head.ts';
import { ENABLED_LOCALES, LOCALES } from './i18n/locales.ts';
import { buildContext, buildRoutes, type Route } from './routes.tsx';
import { escapeHtml } from './docs/markdown.ts';
import { introScript } from './brand/splash-gate.ts';
import { hourScript } from './sky/hour-script.ts';

/**
 * Build-time entry (see scripts/prerender.mjs). Nothing here ships to a browser:
 * the pages are rendered to static markup and the only JavaScript on them is
 * src/enhance.ts, which adds conveniences and is never needed to read a page.
 */

export interface RenderedPage {
  files: string[];
  html: string;
  head: string;
  lang: string;
  dir: string;
}

/**
 * GitHub Pages cannot set response headers, so the Content-Security-Policy is a <meta> and must come first in the head
 * (it governs only what follows it). Scripts: the page's own files and the inline ones, allowed by hash, so an injected
 * script would not run. Styles keep 'unsafe-inline' for the style="" attributes React renders (a hash cannot cover
 * those). Fonts, fetches, media, workers and the manifest fall back to default-src 'self': nothing may be fetched from another origin. frame-ancestors is not honoured in a <meta>.
 */
export function cspFor(inlineScripts: string[]): string {
  const hashes = inlineScripts.map((js) => `'sha256-${createHash('sha256').update(js).digest('base64')}'`);
  return [
    `default-src 'self'`,
    `script-src 'self'${hashes.length ? ' ' + hashes.join(' ') : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ].join('; ');
}

function headFor(route: Route, byPath: Map<string, Route[]>): string {
  const locale = LOCALES[route.locale];
  const canonical = route.indexable ? absolute(route.path) : null;
  // Title, description, Open Graph, Twitter, icons and JSON-LD: one row per page in src/seo.ts (S10).
  const inline = route.pathWithoutLocale === '/' ? [introScript(), hourScript()] : [];
  const lines: string[] = [
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(cspFor(inline))}" />`,
    `<meta name="referrer" content="same-origin" />`,
    ...seoHead(route, canonical, locale.tag),
    `<meta name="bothy-base" content="${escapeHtml(BASE)}" />`,
  ];
  // The home page's first-visit intro decides before the first paint (brand/splash-gate.ts).
  for (const js of inline) lines.push(`<script>${js}</script>`);
  if (canonical) {
    const alternates = byPath.get(route.pathWithoutLocale) ?? [];
    if (alternates.length > 1) {
      for (const alt of alternates) {
        lines.push(`<link rel="alternate" hreflang="${LOCALES[alt.locale].tag}" href="${absolute(alt.path)}" />`);
      }
    }
  }
  return lines.join('\n    ');
}

export function renderAll() {
  const { routes, docs } = buildRoutes();
  const byPath = new Map<string, Route[]>();
  for (const r of routes) {
    if (!r.indexable) continue;
    byPath.set(r.pathWithoutLocale, [...(byPath.get(r.pathWithoutLocale) ?? []), r]);
  }

  const pages: RenderedPage[] = routes.map((route) => {
    const ctx = buildContext(route.locale, route.pathWithoutLocale, docs);
    const html = renderToStaticMarkup(route.render(ctx));
    const locale = LOCALES[route.locale];
    return { files: [route.file], html, head: headFor(route, byPath), lang: locale.tag, dir: locale.dir };
  });

  // The documentation search index: one record per page, sections by heading.
  const search = {
    pages: routes
      .filter((r) => r.doc)
      .map((r) => ({
        slug: r.doc!.slug,
        title: r.doc!.title,
        href: href(r.path),
        s: r.doc!.sections.filter((s) => s.text).map((s) => ({ id: s.id, h: s.heading, t: s.text })),
      })),
  };

  return {
    pages,
    search,
    /** Every repository document that was rendered: the post-build check compares this with the allowlist. */
    docsRendered: docs.map((d) => d.source),
    sitemap: routes.filter((r) => r.indexable).map((r) => ({ path: r.path, loc: absolute(r.path), locale: r.locale })),
    origin: ORIGIN,
    locales: [...ENABLED_LOCALES],
  };
}
