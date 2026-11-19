import type { CSSProperties } from 'react';
import { Icon } from '../components/Icons.tsx';
import { Layout } from '../components/Layout.tsx';
import { href } from '../config.ts';
import { localePrefix } from '../i18n/locales.ts';
import { formatDate } from '../lib/format.ts';
import type { PageContext } from '../page-context.ts';

export function Changelog({ ctx }: { ctx: PageContext }) {
  const { t, locale, feed } = ctx;
  const c = t.changelog;
  const cur = feed.releases[0]!;
  const nf = new Intl.NumberFormat(locale.tag);
  return (
    <Layout ctx={ctx} nav="changelog" cta>
      <div className="wrap page">
        <header className="page-head">
          <p className="eyebrow">{c.eyebrow}</p>
          <h1>{c.heading}</h1>
          <p className="lede">{c.lede}</p>
          <p className="note-line">{c.builtFrom(formatDate(feed.generated, locale.tag))}</p>
        </header>
        {feed.releases.length ? (
          <div className="rel-layout">
            <aside className="rel-side" aria-labelledby="rel-cur-h">
              <div className="card">
                <p id="rel-cur-h" className="eyebrow">
                  {c.current}
                </p>
                <p className="rel-cur-tag">
                  <bdi translate="no">{cur.tag}</bdi>
                </p>
                <p className="meta">
                  <time dateTime={cur.date}>{formatDate(cur.date, locale.tag)}</time>
                  <span>{c.count(cur.changes.length)}</span>
                </p>
                <p className="release-links">
                  <a href={`#${cur.tag}`}>{c.changes}</a>
                  {' · '}
                  <a rel="noopener" href={cur.url}>
                    {c.releasePage}
                  </a>
                </p>
                <a className="card-link" href={href(`${localePrefix(locale.code)}/install/`)}>
                  {c.installIt} <Icon name="arrow" size={16} className="arrow" />
                </a>
              </div>
            </aside>
            <ol className="releases rel-rail">
              {feed.releases.map((r, idx) => (
                <li key={r.tag} id={r.tag} className="rel" style={{ '--i': idx } as CSSProperties}>
                  <details className="card" open={idx === 0}>
                    <summary>
                      <h2>
                        <bdi translate="no">{r.tag}</bdi>
                        {idx === 0 ? <span className="chip available small">{c.latest}</span> : null}
                      </h2>
                      <span className="meta">
                        <time dateTime={r.date}>{formatDate(r.date, locale.tag)}</time>
                        <span>{c.count(r.changes.length)}</span>
                      </span>
                    </summary>
                    <div className="rel-body">
                      <p className="meta">
                        {r.manifest ? (
                          <>
                            {c.images(r.manifest.images)}
                            {' · '}
                            {c.commit}{' '}
                            <code translate="no" dir="ltr">
                              {r.manifest.commit.slice(0, 12)}
                            </code>
                          </>
                        ) : null}
                      </p>
                      <h3 className="visually-hidden">{c.changes}</h3>
                      {r.changes.length ? (
                        <ul className="changes">
                          {r.changes.map((ch) => (
                            <li key={ch.pr}>
                              <a className="pr" href={ch.url} rel="noopener" translate="no">
                                #{nf.format(ch.pr)}
                              </a>
                              <span dir="auto">{ch.title}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted">{c.noChanges}</p>
                      )}
                      <p className="release-links">
                        <a rel="noopener" href={r.url}>
                          {c.releasePage}
                        </a>
                        {r.compareUrl ? (
                          <>
                            {' · '}
                            <a className="ext" rel="noopener" href={r.compareUrl}>
                              {c.fullDiff}
                            </a>
                          </>
                        ) : null}
                      </p>
                    </div>
                  </details>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p>{c.empty}</p>
        )}
      </div>
    </Layout>
  );
}
