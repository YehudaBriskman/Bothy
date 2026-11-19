import type { CSSProperties } from 'react';
import type { PageContext } from '../../page-context.ts';
import { Clouds } from './Clouds.tsx';

/** Chapter 1. What a bothy is: the name and the manners, no product claim. */
export function Descent({ ctx }: { ctx: PageContext }) {
  const d = ctx.t.home.descent;
  return (
    <section id="descent" className="ch ch-descent" aria-labelledby="descent-h">
      <Clouds order="a" />
      <div className="ch-wrap">
        <div className="ch-narrow glass glass-blur float" style={{ '--dr': '12px' } as CSSProperties}>
          <h2 id="descent-h">{d.heading}</h2>
          <p className="ch-lead">{d.lead}</p>
          <figure className="ch-code">
            <figcaption>{d.codeLabel}</figcaption>
            <ul>
              {d.code.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p className="ch-small">{d.codeSource}</p>
          </figure>
          <p>{d.close}</p>
        </div>
      </div>
    </section>
  );
}
