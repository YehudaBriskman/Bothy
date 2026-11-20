import { Icon } from '../components/Icons.tsx';
import { Layout } from '../components/Layout.tsx';
import { REPO_URL } from '../config.ts';
import type { PageContext } from '../page-context.ts';

/**
 * The privacy notice: what the site collects (nothing), what the browser keeps, who else sees a visit. Words in en.ts
 * (`privacy`). Keep it true when the site changes: no analytics, no cookie, nothing from another origin (check:meta).
 */
export function Privacy({ ctx }: { ctx: PageContext }) {
  const a = ctx.t.privacy;
  return (
    <Layout ctx={ctx} nav={null}>
      <div className="wrap page narrow">
        <header className="page-head">
          <p className="eyebrow">{a.eyebrow}</p>
          <h1>{a.heading}</h1>
          <p className="lede">{a.lede}</p>
          <p className="note-line">{a.updated}</p>
        </header>
        <div className="prose">
          {a.sections.map((s) => (
            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`}>
              <h2 id={`${s.id}-h`}>{s.heading}</h2>
              {s.paras.map((p) => (
                <p key={p}>{p}</p>
              ))}
              {s.items.length ? (
                <ul>
                  {s.items.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
          <p>
            <a className="card-link" href={`${REPO_URL}/issues/new`} rel="noopener">
              {a.report} <Icon name="external" size={16} className="arrow" />
            </a>
          </p>
        </div>
      </div>
    </Layout>
  );
}
