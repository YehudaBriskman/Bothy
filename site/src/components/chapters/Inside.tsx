import { Rich } from '../Rich.tsx';
import { href } from '../../config.ts';
import { localePrefix } from '../../i18n/locales.ts';
import type { PageContext } from '../../page-context.ts';

/** Chapter 3. Only what docs/guide documents. The real-console frame (slice S5) goes in this section. */
export function Inside({ ctx }: { ctx: PageContext }) {
  const n = ctx.t.home.inside;
  const p = localePrefix(ctx.locale.code);
  return (
    <section id="inside" className="ch ch-inside" aria-labelledby="inside-h">
      <div className="ch-wrap">
        <h2 id="inside-h">{n.heading}</h2>
        <p className="ch-lead">{n.lead}</p>
        <ul className="ch-cards">
          {n.items.map((i) => (
            <li key={i.title} className="ch-card">
              <h3>{i.title}</h3>
              <p>
                <Rich text={i.body} />
              </p>
              <p className="ch-more">
                <a href={href(`${p}/docs/${i.page}/`)}>{i.link}</a>
              </p>
            </li>
          ))}
        </ul>
        <p className="ch-small">{n.note}</p>
      </div>
    </section>
  );
}
