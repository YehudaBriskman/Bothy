import { renderToStaticMarkup } from 'react-dom/server';
import { BASE, ORIGIN, absolute, href } from './config.ts';
import { ENABLED_LOCALES, LOCALES } from './i18n/locales.ts';
import { buildContext, buildRoutes, type Route } from './routes.tsx';
import { escapeHtml } from './docs/markdown.ts';

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

/** Sets the colour scheme before first paint so a reader who chose one never sees the other flash. */
const THEME_BOOT = `try{var t=localStorage.getItem('bothy-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

function headFor(route: Route, byPath: Map<string, Route[]>): string {
  const locale = LOCALES[route.locale];
  const canonical = route.indexable ? absolute(route.path) : null;
  const lines: string[] = [
    `<title>${escapeHtml(route.title)}</title>`,
    `<meta name="description" content="${escapeHtml(route.description)}" />`,
    `<meta name="bothy-base" content="${escapeHtml(BASE)}" />`,
    `<meta name="theme-color" content="#f3f4f0" media="(prefers-color-scheme: light)" />`,
    `<meta name="theme-color" content="#13161b" media="(prefers-color-scheme: dark)" />`,
    `<link rel="icon" href="${href('/favicon.svg')}" type="image/svg+xml" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeHtml(route.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(route.description)}" />`,
    `<meta property="og:locale" content="${escapeHtml(locale.tag)}" />`,
    `<meta name="twitter:card" content="summary" />`,
  ];
  if (!route.indexable) lines.push('<meta name="robots" content="noindex" />');
  if (canonical) {
    lines.push(`<link rel="canonical" href="${canonical}" />`, `<meta property="og:url" content="${canonical}" />`);
    const alternates = byPath.get(route.pathWithoutLocale) ?? [];
    if (alternates.length > 1) {
      for (const alt of alternates) {
        lines.push(`<link rel="alternate" hreflang="${LOCALES[alt.locale].tag}" href="${absolute(alt.path)}" />`);
      }
    }
  }
  lines.push(`<script>${THEME_BOOT}</script>`);
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
