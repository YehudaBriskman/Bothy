import { REPO_URL, RELEASES_URL, SITE_NAME, absolute, href } from './config.ts';
import { escapeHtml } from './docs/markdown.ts';
import type { Route } from './routes.tsx';
import { OG_CARDS, OG_SIZE, seoFor } from './seo.ts';

/**
 * The head tags a page says about itself (build plan S10), from its row in src/seo.ts.
 *
 * Absolute addresses (canonical, og:url, og:image, JSON-LD) need the public origin; a build with no origin (served
 * from a box, see config.ts) emits none of them, only the words and the icons. Everything here is a <meta>, a
 * same-site <link> or inline data, so the offline rule in verify-dist.sh still holds: no page loads anything from
 * another origin. scripts/check-seo.mjs reads the built pages and holds every field to src/seo.ts's limits.
 */

/** Theme colour: the ink the site is drawn on (tokens.css --ink); the story's sky is the only exception. */
export const THEME_COLOR = '#08090d';

const AUTHOR = 'Yehuda Briskman'; // the copyright holder in LICENSE, as the footer already says
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`; // MIT

/** Structured data for the home page: the site and the software, only fields that are true and checkable. */
function jsonLd(home: string, description: string): string {
  const person = { '@type': 'Person', name: AUTHOR, url: REPO_URL.replace(/\/[^/]+$/, '') };
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${home}#website`, name: SITE_NAME, url: home, inLanguage: 'en' },
      {
        '@type': 'SoftwareApplication',
        '@id': `${home}#software`,
        name: SITE_NAME,
        description,
        url: home,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Linux',
        isAccessibleForFree: true,
        license: LICENSE_URL,
        downloadUrl: RELEASES_URL,
        sameAs: [REPO_URL],
        author: person,
      },
    ],
  };
  // `<` escaped so no string inside can close the script element.
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

export function seoHead(route: Route, canonical: string | null, localeTag: string): string[] {
  const seo = seoFor(route.pathWithoutLocale, { title: route.title, description: route.description });
  const card = OG_CARDS[seo.image];
  const title = escapeHtml(seo.title);
  const description = escapeHtml(seo.description);
  const image = absolute(`/og/${seo.image}.jpg`);
  const lines = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<meta name="theme-color" content="${THEME_COLOR}" />`,
    `<link rel="icon" href="${href('/favicon.svg')}" type="image/svg+xml" />`,
    `<link rel="apple-touch-icon" href="${href('/apple-touch-icon.png')}" />`,
    `<link rel="manifest" href="${href('/site.webmanifest')}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:locale" content="${escapeHtml(localeTag.replace('-', '_'))}" />`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
  ];
  if (!route.indexable) lines.push('<meta name="robots" content="noindex" />');
  if (canonical)
    lines.push(`<link rel="canonical" href="${canonical}" />`, `<meta property="og:url" content="${canonical}" />`);
  if (image) {
    lines.push(
      `<meta property="og:image" content="${image}" />`,
      `<meta property="og:image:type" content="image/jpeg" />`,
      `<meta property="og:image:width" content="${OG_SIZE.width}" />`,
      `<meta property="og:image:height" content="${OG_SIZE.height}" />`,
      `<meta property="og:image:alt" content="${escapeHtml(card.alt)}" />`,
      `<meta name="twitter:image" content="${image}" />`,
      `<meta name="twitter:image:alt" content="${escapeHtml(card.alt)}" />`,
    );
  }
  if (canonical && route.pathWithoutLocale === '/') lines.push(jsonLd(canonical, seo.description));
  return lines;
}
