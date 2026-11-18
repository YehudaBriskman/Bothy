import { href } from '../../config.ts';
import { localePrefix } from '../../i18n/locales.ts';
import type { PageContext } from '../../page-context.ts';

/** The hut: ridges and one lit window, drawn here, original, and decorative. */
function HutArt({ label }: { label: string }) {
  return (
    <svg className="ch-hut-art" viewBox="0 0 320 180" role="img" aria-label={label} focusable="false">
      <path className="ridge-far" d="M0 120 60 84 110 108 170 66 230 104 290 78 320 96V180H0z" />
      <path className="ridge-near" d="M0 142 70 112 140 134 210 104 280 130 320 118V180H0z" />
      <path className="hut-wall" d="M120 150V118h64v32z" />
      <path className="hut-roof" d="M112 120 152 92 192 120z" />
      <rect className="hut-door" x="132" y="132" width="12" height="18" />
      <rect className="hut-window" x="156" y="126" width="12" height="10" />
    </svg>
  );
}

/** Chapter 2. What Bothy is, true today. */
export function Hut({ ctx }: { ctx: PageContext }) {
  const u = ctx.t.home.hut;
  const p = localePrefix(ctx.locale.code);
  return (
    <section id="hut" className="ch ch-hut" aria-labelledby="hut-h">
      <div className="ch-wrap ch-split">
        <div className="ch-narrow">
          <h2 id="hut-h">{u.heading}</h2>
          <p className="ch-lead">{u.lead}</p>
          <p>{u.promise}</p>
          <p>
            <a className="ch-btn" href={href(`${p}/docs/overview/`)}>
              {u.guide}
            </a>
          </p>
        </div>
        <HutArt label={u.art} />
      </div>
    </section>
  );
}
