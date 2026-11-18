import { REPO_URL, href } from '../config.ts';
import { localePrefix } from '../i18n/locales.ts';
import type { PageContext } from '../page-context.ts';

/**
 * The solid Install pill with a chevron segment that opens a glass menu of what installs (a native <details>, so it
 * works with no script; src/enhance.ts only adds click-outside and Escape). Only what is true is offered: the Linux
 * amd64 binary is the one build that has been installed on a clean machine; the rest say "Not yet" and are not links.
 */
export function InstallSplit({ ctx, label }: { ctx: PageContext; label?: string }) {
  const t = ctx.t;
  const p = localePrefix(ctx.locale.code);
  return (
    <div className="pill-split">
      <a className="pill pill-solid" href={href(`${p}/install/`)}>
        {label ?? t.nav.getBothy}
      </a>
      <details className="dd" data-dd>
        <summary className="pill pill-solid pill-chev" aria-label={t.nav.moreWays}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
            <path
              d="m6 9 6 6 6-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </summary>
        <div className="dd-panel">
          <ul className="dd-rows">
            {t.nav.menu.available.map((r) => (
              <li key={r.title}>
                <a className="dd-row" href={href(`${p}/install/`)}>
                  <span className="dd-ico" aria-hidden="true">
                    {r.title.slice(0, 1)}
                  </span>
                  <span className="dd-txt">
                    <strong>{r.title}</strong>
                    <span>{r.sub}</span>
                  </span>
                  <span className="dd-tag dd-tag-ok">{r.tag}</span>
                </a>
              </li>
            ))}
            {t.nav.menu.notYet.map((r) => (
              <li key={r.title} className="dd-row dd-off">
                <span className="dd-ico" aria-hidden="true">
                  {r.title.slice(0, 1)}
                </span>
                <span className="dd-txt">
                  <strong>{r.title}</strong>
                  <span>{r.sub}</span>
                </span>
                <span className="dd-tag">{r.tag}</span>
              </li>
            ))}
          </ul>
          <hr />
          <ul className="dd-links">
            <li>
              <a href={`${REPO_URL}/releases`} rel="noopener">
                {t.nav.menu.builds} <span aria-hidden="true">↗</span>
              </a>
            </li>
            <li>
              <a href={href(`${p}/changelog/`)}>{t.nav.menu.notes}</a>
            </li>
          </ul>
        </div>
      </details>
    </div>
  );
}
