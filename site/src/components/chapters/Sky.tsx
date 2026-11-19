import type { CSSProperties } from 'react';
import { href } from '../../config.ts';
import { localePrefix } from '../../i18n/locales.ts';
import type { PageContext } from '../../page-context.ts';
import { SkyControls } from '../../sky/SkyControls.tsx';
import { Lockup } from '../Brand.tsx';
import { InstallSplit } from '../InstallSplit.tsx';

/**
 * Chapter 0: centred over the sky. A badge, the wordmark (the page's one h1), the big two-line statement, one muted
 * line and two pills. The window rising from the bottom edge is the next section's (ConsoleFlow.tsx): the real
 * demo, not a picture of it. The sky itself is the story's fixed stage (SkyStage.tsx).
 */
export function Sky({ ctx }: { ctx: PageContext }) {
  const h = ctx.t.home.hero;
  const p = localePrefix(ctx.locale.code);
  return (
    <section id="sky" className="ch ch-sky has-sky" data-sky aria-labelledby="sky-h">
      <div className="ch-wrap ch-sky-inner">
        <p className="ch-skip">
          <a href="#inside">{h.skipDescent}</a>
          {' · '}
          <a href="#install">{h.skipInstall}</a>
        </p>
        <a className="ch-badge" href={href(`${p}/install/`)}>
          {h.badge} <span aria-hidden="true">›</span>
        </a>
        <h1 id="sky-h" translate="no">
          <Lockup reuse />
        </h1>
        <p className="ch-line">
          {h.line.split(' ').map((w, i, all) => (
            <span key={i}>
              <span className="w" style={{ '--i': i } as CSSProperties}>
                {w}
              </span>
              {i < all.length - 1 ? ' ' : null}
            </span>
          ))}
        </p>
        <p className="ch-lede">{h.sub}</p>
        <div className="ch-actions">
          <InstallSplit ctx={ctx} label={h.primary} />
          <a className="pill pill-glass" href={href(`${p}/docs/`)}>
            {h.secondary}
          </a>
        </div>
      </div>
      <SkyControls ctx={ctx} />
    </section>
  );
}
