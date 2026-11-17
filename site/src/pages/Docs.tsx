import { Layout } from '../components/Layout.tsx';
import { REPO_URL, REPO_BRANCH, href } from '../config.ts';
import { groupDocs, type DocPage } from '../docs/docs.ts';
import { localePrefix } from '../i18n/locales.ts';
import type { PageContext } from '../page-context.ts';

function docHref(ctx: PageContext, slug: string): string {
  return href(`${localePrefix(ctx.locale.code)}/docs/${slug}/`);
}

function Sidebar({ ctx, current }: { ctx: PageContext; current: string | null }) {
  const { t } = ctx;
  return (
    <nav aria-label={t.docs.sidebarLabel} className="docs-nav">
      <details open data-collapse-narrow>
        <summary>{t.docs.sidebarLabel}</summary>
        {groupDocs(ctx.docs).map(({ group, pages }) => (
          <div key={group} className="docs-group">
            <p className="docs-group-title">{t.docs.groups[group]}</p>
            <ul>
              {pages.map((d) => (
                <li key={d.slug}>
                  <a href={docHref(ctx, d.slug)} aria-current={d.slug === current ? 'page' : undefined}>
                    {d.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </details>
    </nav>
  );
}

export function DocsIndex({ ctx }: { ctx: PageContext }) {
  const { t } = ctx;
  return (
    <Layout ctx={ctx} nav="docs">
      <div className="wrap docs-shell">
        <Sidebar ctx={ctx} current={null} />
        <div className="docs-main">
          <header className="page-head">
            <h1>{t.docs.heading}</h1>
            <p className="lede">{t.docs.lede}</p>
            <p className="muted small">{t.docs.notTranslated}</p>
          </header>

          <form className="search" role="search" data-docs-search hidden data-needs-js>
            <label htmlFor="docs-q">{t.docs.search.label}</label>
            <input
              id="docs-q"
              type="search"
              name="q"
              placeholder={t.docs.search.placeholder}
              autoComplete="off"
              spellCheck={false}
              data-none={t.docs.search.none('{q}')}
              data-count-one={t.docs.search.results(1)}
              data-count-many={t.docs.search.results(2)}
            />
            <div id="docs-results" aria-live="polite" />
          </form>
          <noscript>
            <p className="muted">{t.docs.search.needsScript}</p>
          </noscript>

          <div id="docs-list">
            {groupDocs(ctx.docs).map(({ group, pages }) => (
              <section key={group} aria-labelledby={`g-${group}`} className="doc-group">
                <h2 id={`g-${group}`}>{t.docs.groups[group]}</h2>
                <ul className="doc-cards">
                  {pages.map((d) => (
                    <li key={d.slug}>
                      <a href={docHref(ctx, d.slug)}>
                        <span className="card-title">{d.title}</span>
                        <span className="card-sum">{d.summary}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </div>
    </Layout>
  );
}

export function DocView({ ctx, doc }: { ctx: PageContext; doc: DocPage }) {
  const { t } = ctx;
  const idx = ctx.docs.findIndex((d) => d.slug === doc.slug);
  const prev = idx > 0 ? ctx.docs[idx - 1] : undefined;
  const next = idx >= 0 ? ctx.docs[idx + 1] : undefined;
  return (
    <Layout ctx={ctx} nav="docs">
      <div className="wrap docs-shell">
        <Sidebar ctx={ctx} current={doc.slug} />
        <article className="docs-main prose">
          {/* The document's own H1 is the first thing in the HTML. */}
          <div dangerouslySetInnerHTML={{ __html: doc.html }} />
          <p className="source-link muted small">
            <a className="ext" rel="noopener" href={`${REPO_URL}/blob/${REPO_BRANCH}/${doc.source}`}>
              {t.docs.sourceLink}
            </a>
          </p>
          <nav className="pager" aria-label={t.docs.sidebarLabel}>
            {prev ? (
              <a rel="prev" href={docHref(ctx, prev.slug)}>
                <span className="muted small">{t.docs.prev}</span>
                <span>{prev.title}</span>
              </a>
            ) : (
              <span />
            )}
            {next ? (
              <a rel="next" href={docHref(ctx, next.slug)} className="next">
                <span className="muted small">{t.docs.next}</span>
                <span>{next.title}</span>
              </a>
            ) : null}
          </nav>
        </article>
        {doc.toc.length ? (
          <aside className="toc" aria-label={t.docs.onThisPage}>
            <p className="docs-group-title">{t.docs.onThisPage}</p>
            <ul>
              {doc.toc.map((e) => (
                <li key={e.id} className={`d${e.depth}`}>
                  <a href={`#${e.id}`}>{e.text}</a>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}
      </div>
    </Layout>
  );
}
