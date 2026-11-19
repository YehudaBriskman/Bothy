import type { CSSProperties } from 'react';
import { Icon, type IconName } from '../Icons.tsx';
import { Rich } from '../Rich.tsx';
import { href } from '../../config.ts';
import { MEMORY, MEMORY_USED_TOTAL_MIB } from '../../facts.ts';
import { localePrefix } from '../../i18n/locales.ts';
import type { PageContext } from '../../page-context.ts';

const ICONS: IconName[] = ['grid', 'file', 'users', 'palette'];
const i = (n: number) => ({ '--i': n }) as CSSProperties;

/**
 * Chapter 3. Only what docs/guide documents: a two-column head, four equal cards with an icon, then the measured
 * numbers under hairlines. The cards take a light on hover (home-sections.ts); the numbers count up once.
 */
export function Inside({ ctx }: { ctx: PageContext }) {
  const n = ctx.t.home.inside;
  const p = localePrefix(ctx.locale.code);
  const values = [MEMORY_USED_TOTAL_MIB, MEMORY.gateMiB, 4, 5];
  return (
    <section id="inside" className="ch ch-inside" aria-labelledby="inside-h" data-hs>
      <div className="ch-wrap">
        <header className="hs-head">
          <h2 id="inside-h" className="hs-rise">
            {n.heading}
          </h2>
          <p className="ch-lead hs-rise" style={i(1)}>
            {n.lead}
          </p>
        </header>
        <ul className="hs-cards" data-spot>
          {n.items.map((it, k) => (
            <li key={it.title} className="hs-card hs-rise" style={i(k + 1)}>
              <span className="hs-ico" aria-hidden="true">
                <Icon name={ICONS[k] ?? 'file'} size={22} />
              </span>
              <h3>{it.title}</h3>
              <p>
                <Rich text={it.body} />
              </p>
              <p className="hs-more">
                <a href={href(`${p}/docs/${it.page}/`)}>{it.link}</a>
              </p>
            </li>
          ))}
        </ul>
        <ul className="hs-stats" aria-label={n.statsLabel}>
          {n.stats.map((s, k) => (
            <li key={s.label} className="hs-stat">
              <span className="hs-rule" aria-hidden="true" style={i(k)} />
              <p className="hs-big hs-rise" style={i(k + 2)}>
                <span data-count={values[k]}>{values[k]}</span>
                {s.unit ? <span className="hs-unit"> {s.unit}</span> : null}
              </p>
              <p className="hs-sm hs-rise" style={i(k + 3)}>
                {s.label}
              </p>
            </li>
          ))}
        </ul>
        <p className="ch-small">{n.note}</p>
      </div>
    </section>
  );
}
