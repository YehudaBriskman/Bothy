import type { CSSProperties } from 'react';
import { Rich } from '../Rich.tsx';
import { MEMORY, MEMORY_USED_TOTAL_MIB, MODES } from '../../facts.ts';
import type { PageContext } from '../../page-context.ts';

/** Where each size sits on the ridge line, as a percentage across and down the drawing, smallest at the foot. */
const SPOT: [number, number][] = [
  [4, 93.5],
  [30, 74.3],
  [54, 48.2],
  [76, 25.5],
];

/**
 * Chapter 4. Four sizes as places on one hill, smallest first; Bivvy is lit, the others dashed. The markers are
 * links to the four cards below, so with no script every card is shown; with script the markers become tabs
 * (home-sections.ts) and one card at a time is shown. State chips come from facts.ts, never from this file.
 */
export function Sizes({ ctx }: { ctx: PageContext }) {
  const s = ctx.t.home.sizes;
  return (
    <section id="sizes" className="ch ch-sizes" aria-labelledby="sizes-h" data-hs>
      <div className="ch-wrap">
        <header className="hs-head">
          <h2 id="sizes-h" className="hs-rise">
            {s.heading}
          </h2>
          <p className="ch-lead hs-rise" style={{ '--i': 1 } as CSSProperties}>
            {s.lead}
          </p>
        </header>
        <div className="hs-sizes" data-tabs data-label={s.pickLabel}>
          <div className="hs-hill" data-tablist>
            <svg viewBox="0 0 800 200" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <path className="hs-hill-path" d="M30 188 C200 164 300 136 420 100 S640 40 780 26" />
            </svg>
            {MODES.map((m, k) => {
              const t = s.items[m.id];
              const now = m.state === 'now';
              const [x, y] = SPOT[k] ?? [0, 0];
              return (
                <a
                  key={m.id}
                  href={`#size-${m.id}`}
                  data-tab={m.id}
                  className={`hs-mark ${now ? 'is-now' : 'is-planned'}`}
                  style={{ '--x': `${x}%`, '--y': y, '--i': k } as CSSProperties}
                >
                  <span className="hs-pin" aria-hidden="true" />
                  <b translate="no">{t.name}</b>
                  <span className="hs-sm">{now ? s.now : s.planned}</span>
                </a>
              );
            })}
          </div>
          <div className="hs-panels">
            {MODES.map((m) => {
              const t = s.items[m.id];
              const now = m.state === 'now';
              return (
                <article
                  key={m.id}
                  id={`size-${m.id}`}
                  data-panel={m.id}
                  className={`hs-panel ${now ? 'is-now' : 'is-planned'}`}
                  aria-labelledby={`size-${m.id}-h`}
                >
                  <p className={`ch-chip ${now ? 'now' : 'planned'}`}>
                    <span aria-hidden="true">{now ? '✓' : '○'}</span> {now ? s.now : s.planned}
                  </p>
                  <h3 id={`size-${m.id}-h`} translate="no">
                    {t.name}
                  </h3>
                  <p className="ch-tagline">{t.tagline}</p>
                  <p>{t.body}</p>
                  <p className="ch-cost">
                    <strong>{s.cost}.</strong>{' '}
                    {m.measured ? s.bivvyCost(MEMORY_USED_TOTAL_MIB, MEMORY.gateMiB) : s.notMeasured}
                  </p>
                  {t.note ? (
                    <p className="ch-small">
                      <Rich text={t.note} />
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
