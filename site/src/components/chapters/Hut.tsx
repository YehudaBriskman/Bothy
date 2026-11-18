import type { CSSProperties } from 'react';
import { href } from '../../config.ts';
import { localePrefix } from '../../i18n/locales.ts';
import type { PageContext } from '../../page-context.ts';

/** Chapter 2. What Bothy is, true today. Sky only: the hills and the hut were dropped, the words stand on the sky. */
export function Hut({ ctx }: { ctx: PageContext }) {
  const u = ctx.t.home.hut;
  const p = localePrefix(ctx.locale.code);
  return (
    <section id="hut" className="ch ch-hut" aria-labelledby="hut-h">
      <div className="ch-wrap ch-end">
        <div className="ch-narrow glass glass-blur float" style={{ '--dr': '14px' } as CSSProperties}>
          <h2 id="hut-h">{u.heading}</h2>
          <p className="ch-lead">{u.lead}</p>
          <p>{u.promise}</p>
          <p>
            <a className="ch-btn" href={href(`${p}/docs/overview/`)}>
              {u.guide}
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
