import type { ReactNode } from 'react';
import { DEFAULT_LOCALE, ENABLED_LOCALES, LOCALES, localePrefix, type LocaleCode } from './i18n/locales.ts';
import type { PageContext } from './page-context.ts';
import { About } from './pages/About.tsx';
import { Privacy } from './pages/Privacy.tsx';
import { Accessibility } from './pages/Accessibility.tsx';
import { Changelog } from './pages/Changelog.tsx';
import { DocsIndex, DocView } from './pages/Docs.tsx';
import { Home } from './pages/Home.tsx';
import { Install } from './pages/Install.tsx';
import { NotFound } from './pages/NotFound.tsx';
import { loadDocs, type DocPage } from './docs/docs.ts';
import { latestRelease, loadFeed } from './lib/releases.ts';

/**
 * The route table: the single description of the site. The prerender writes one
 * file per entry, the sitemap lists the indexable ones, and verify-dist checks
 * that every one of them exists. Adding a page is adding a row here.
 */

export interface Route {
  /** Site path including locale prefix, always with a trailing slash (`/install/`). `/404.html` for the not-found page. */
  path: string;
  /** The same page without the locale prefix; the key that links alternates together. */
  pathWithoutLocale: string;
  locale: LocaleCode;
  /** File under dist/. */
  file: string;
  title: string;
  description: string;
  indexable: boolean;
  /** What the page is about, for the search index. Docs pages only. */
  doc?: DocPage;
  render: (ctx: PageContext) => ReactNode;
}

export function buildContext(code: LocaleCode, pathWithoutLocale: string, docs: DocPage[]): PageContext {
  const locale = LOCALES[code];
  const feed = loadFeed();
  return { locale, t: locale.messages, feed, latest: latestRelease(feed), docs, pathWithoutLocale };
}

export function buildRoutes(): { routes: Route[]; docs: DocPage[] } {
  // Docs are English Markdown whatever the page locale; render once.
  const docs = loadDocs(LOCALES[DEFAULT_LOCALE].messages.docs.tableLabel);
  const routes: Route[] = [];

  for (const code of ENABLED_LOCALES) {
    const t = LOCALES[code].messages;
    const p = localePrefix(code);
    const add = (r: Omit<Route, 'locale' | 'file' | 'path' | 'pathWithoutLocale'> & { rel: string }) => {
      const { rel, ...rest } = r;
      routes.push({
        ...rest,
        locale: code,
        pathWithoutLocale: rel,
        path: `${p}${rel}`,
        file: `${`${p}${rel}`.replace(/^\//, '')}index.html`,
      });
    };

    add({
      rel: '/',
      title: t.home.title,
      description: t.meta.description,
      indexable: true,
      render: (ctx) => <Home ctx={ctx} />,
    });
    add({
      rel: '/install/',
      title: t.install.title,
      description: t.install.description,
      indexable: true,
      render: (ctx) => <Install ctx={ctx} />,
    });
    add({
      rel: '/docs/',
      title: `${t.docs.title} - ${t.meta.siteTitle}`,
      description: t.docs.description,
      indexable: true,
      render: (ctx) => <DocsIndex ctx={ctx} />,
    });
    for (const doc of docs) {
      add({
        rel: `/docs/${doc.slug}/`,
        title: `${doc.title} - ${t.docs.title} - ${t.meta.siteTitle}`,
        description: doc.summary,
        indexable: true,
        doc,
        render: (ctx) => <DocView ctx={ctx} doc={doc} />,
      });
    }
    add({
      rel: '/about/',
      title: `${t.about.title} - ${t.meta.siteTitle}`,
      description: t.about.description,
      indexable: true,
      render: (ctx) => <About ctx={ctx} />,
    });
    add({
      rel: '/changelog/',
      title: `${t.changelog.title} - ${t.meta.siteTitle}`,
      description: t.changelog.description,
      indexable: true,
      render: (ctx) => <Changelog ctx={ctx} />,
    });
    add({
      rel: '/privacy/',
      title: `${t.privacy.title} - ${t.meta.siteTitle}`,
      description: t.privacy.description,
      indexable: true,
      render: (ctx) => <Privacy ctx={ctx} />,
    });
    add({
      rel: '/accessibility/',
      title: `${t.accessibility.title} - ${t.meta.siteTitle}`,
      description: t.accessibility.description,
      indexable: true,
      render: (ctx) => <Accessibility ctx={ctx} />,
    });
  }

  // One not-found page, in the default locale, at the file GitHub Pages serves for any miss.
  const t = LOCALES[DEFAULT_LOCALE].messages;
  routes.push({
    path: '/404.html',
    pathWithoutLocale: '/404.html',
    locale: DEFAULT_LOCALE,
    file: '404.html',
    title: `${t.notFound.title} - ${t.meta.siteTitle}`,
    description: t.notFound.body,
    indexable: false,
    render: (ctx) => <NotFound ctx={ctx} />,
  });

  const files = new Set<string>();
  for (const r of routes) {
    if (files.has(r.file)) throw new Error(`two routes write ${r.file}`);
    files.add(r.file);
  }
  return { routes, docs };
}
