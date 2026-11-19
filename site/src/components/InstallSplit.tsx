import { CopyButton } from './CopyButton.tsx';
import { REPO_URL, href } from '../config.ts';
import { localePrefix } from '../i18n/locales.ts';
import type { PageContext } from '../page-context.ts';
import { Icon } from './Icons.tsx';

/**
 * The solid Install pill with a chevron segment that opens a dark frosted menu of what installs. A native <details>,
 * so it opens with no script; enhance.ts adds the APG disclosure keys (Escape closes and returns focus, arrows move
 * through the items, a click outside closes) and the copy button. Only what is true is offered: Linux amd64 with
 * Docker is the one target run end to end; the rest are named once, as not yet.
 */
export function InstallSplit({ ctx, label, id }: { ctx: PageContext; label?: string; id?: string }) {
  const t = ctx.t;
  const m = t.nav.menu;
  const p = localePrefix(ctx.locale.code);
  const panel = `${id ?? (label ? 'hero-install' : 'nav-install')}-panel`;
  return (
    <div className="pill-split">
      <a className="pill pill-solid" href={href(`${p}/install/`)}>
        {label ?? t.nav.getBothy}
      </a>
      <details className="dd" data-dd>
        <summary className="pill pill-solid pill-chev" aria-label={t.nav.moreWays} aria-controls={panel}>
          <Icon name="chevron" size={16} />
        </summary>
        <div className="dd-panel" id={panel}>
          <p className="dd-label t-label">{m.label}</p>
          <ul className="dd-rows">
            {m.available.map((r) => (
              <li key={r.title}>
                <a className="dd-row" href={href(`${p}/${r.to}`)}>
                  <span className="dd-ico">
                    <Icon name={r.icon} size={18} />
                  </span>
                  <span className="dd-txt">
                    <strong>{r.title}</strong>
                    <span>{r.sub}</span>
                  </span>
                  <span className={`dd-tag${r.ok ? ' dd-tag-ok' : ''}`}>{r.tag}</span>
                </a>
              </li>
            ))}
          </ul>
          <div className="dd-cmd" data-copy-text={m.cmd} aria-label={m.cmdLabel} role="group">
            <code translate="no" dir="ltr">
              {m.cmd}
            </code>
            <CopyButton />
          </div>
          <p className="dd-not">{m.notYet}</p>
          <hr />
          <ul className="dd-links">
            <li>
              <a href={href(`${p}/docs/installing/`)}>
                {m.guide} <Icon name="arrow" size={16} className="arrow" />
              </a>
            </li>
            <li>
              <a href={`${REPO_URL}/releases`} rel="noopener">
                {m.builds} <Icon name="external" size={16} className="arrow" />
              </a>
            </li>
            <li>
              <a href={href(`${p}/changelog/`)}>
                {m.notes} <Icon name="arrow" size={16} className="arrow" />
              </a>
            </li>
          </ul>
        </div>
      </details>
    </div>
  );
}
