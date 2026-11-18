import { href } from '../../config.ts';
import { localePrefix } from '../../i18n/locales.ts';
import type { PageContext } from '../../page-context.ts';
import { SkyControls } from '../../sky/SkyControls.tsx';

/** Chapter 0. The sky is CSS only here (chapters.css); `BothyBox` is the page's one h1. */
export function Sky({ ctx }: { ctx: PageContext }) {
  const h = ctx.t.home.hero;
  const p = localePrefix(ctx.locale.code);
  return (
    <section id="sky" className="ch ch-sky has-sky" data-sky aria-labelledby="sky-h">
      <div className="sky-still" data-sky-layer aria-hidden="true" />
      <div className="ch-wrap ch-sky-inner">
        <p className="ch-skip">
          <a href="#install">{h.skipInstall}</a>
        </p>
        <h1 id="sky-h" translate="no">
          {h.heading}
        </h1>
        <p className="ch-line">{h.line}</p>
        <p className="ch-lede">{h.lede}</p>
        <p className="ch-actions">
          <a className="ch-btn ch-btn-primary" href={href(`${p}/install/`)}>
            {h.primary}
          </a>
          <a className="ch-btn" href={href(`${p}/docs/`)}>
            {h.secondary}
          </a>
        </p>
        <p className="ch-cue">
          <a href="#descent">
            {h.cue} <span aria-hidden="true">↓</span>
          </a>
        </p>
        <p className="ch-foot">{h.footnote}</p>
        <SkyControls ctx={ctx} />
      </div>
    </section>
  );
}
