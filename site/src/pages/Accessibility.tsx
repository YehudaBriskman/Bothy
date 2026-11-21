import { Icon } from '../components/Icons.tsx';
import { Layout } from '../components/Layout.tsx';
import { REPO_URL, X_URL } from '../config.ts';
import type { PageContext } from '../page-context.ts';

/**
 * The accessibility statement: what the site aims for, what was checked and how, the known gaps, and where to report
 * a barrier. Words in en.ts (`accessibility`). It claims no conformance and no certification; keep it that way, and
 * keep the date and the list of checks true when the checks change (scripts/check-a11y.mjs, check-sky.mjs).
 */
export function Accessibility({ ctx }: { ctx: PageContext }) {
  const a = ctx.t.accessibility;
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
            <a className="card-link" href={X_URL} rel="noopener">
              {a.reportX} <Icon name="external" size={16} className="arrow" />
            </a>
          </p>
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
