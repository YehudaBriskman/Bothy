import { Layout } from '../components/Layout.tsx';
import { formatDate } from '../lib/format.ts';
import type { PageContext } from '../page-context.ts';

export function Changelog({ ctx }: { ctx: PageContext }) {
  const { t, locale, feed } = ctx;
  const c = t.changelog;
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
          <ol className="releases">
            {feed.releases.map((r, idx) => (
              <li key={r.tag} id={r.tag}>
                <article className="card">
                  <h2>
                    <bdi translate="no">{r.tag}</bdi>
                    {idx === 0 ? <span className="chip available small">{c.latest}</span> : null}
                  </h2>
                  <p className="meta">
                    <time dateTime={r.date}>{formatDate(r.date, locale.tag)}</time>
                    {r.manifest ? (
                      <>
                        {' · '}
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
                </article>
              </li>
            ))}
          </ol>
        ) : (
          <p>{c.empty}</p>
        )}
      </div>
    </Layout>
  );
}
