import { Rich } from '../Rich.tsx';
import { MEMORY, MEMORY_USED_TOTAL_MIB, MODES } from '../../facts.ts';
import type { PageContext } from '../../page-context.ts';

/** Chapter 4. State chips come from facts.ts, never from this file. */
export function Sizes({ ctx }: { ctx: PageContext }) {
  const s = ctx.t.home.sizes;
  return (
    <section id="sizes" className="ch ch-sizes" aria-labelledby="sizes-h">
      <div className="ch-wrap">
        <h2 id="sizes-h">{s.heading}</h2>
        <p className="ch-lead">{s.lead}</p>
        <ol className="ch-modes">
          {MODES.map((m) => {
            const t = s.items[m.id];
            const now = m.state === 'now';
            return (
              <li key={m.id} className={`ch-mode ${now ? 'is-now' : 'is-planned'}`}>
                <p className={`ch-chip ${now ? 'now' : 'planned'}`}>
                  <span aria-hidden="true">{now ? '✓' : '○'}</span> {now ? s.now : s.planned}
                </p>
                <h3 translate="no">{t.name}</h3>
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
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
