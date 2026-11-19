import type { CSSProperties } from 'react';
import { href } from '../../config.ts';
import { localePrefix } from '../../i18n/locales.ts';
import type { PageContext } from '../../page-context.ts';
import { Lines, ReadSection } from './Reading.tsx';

/**
 * A compact mock of the console, marked EXAMPLE, built from the same example rows as the "what you get" cards
 * (i18n after.overview and after.files). It is assembled as the lines beside it are read: the window, then the
 * services Docker reports, then the reader, then the licence line. Nothing in it is a live reading.
 */
function ConsoleMock({ ctx }: { ctx: PageContext }) {
  const a = ctx.t.after;
  return (
    <figure className="rd-console" aria-hidden="true">
      <div className="rd-win-bar rd-part" data-from="1">
        <span className="rd-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="rd-win-title">Bothy · {a.overview.panel}</span>
        <span className="mini-tag">{a.example}</span>
      </div>
      <div className="rd-cols">
        <ul className="rd-svc">
          {a.overview.rows.map((r, k) => (
            <li key={r.name} className="rd-part" data-from="2" style={{ '--k': k } as CSSProperties}>
              <span className="dot" />
              <span className="grow">
                <span className="mono" translate="no">
                  {r.name}
                </span>
                <span className="sub">{r.sub}</span>
              </span>
              <span className="sub">{a.overview.state}</span>
            </li>
          ))}
        </ul>
        <div className="rd-files rd-part" data-from="3">
          <p className="rd-files-head">
            <span>{a.files.panel}</span>
          </p>
          <ul>
            {a.files.rows.map((r, k) => (
              <li key={r} className={k === 0 ? 'is-open' : ''} translate="no">
                {r}
              </li>
            ))}
            <li className="rd-sw">
              <span>{a.files.readOnly}</span>
              <span className="switch" />
            </li>
          </ul>
        </div>
      </div>
      <p className="rd-foot rd-part" data-from="4">
        {a.overview.foot}
      </p>
    </figure>
  );
}

/** What Bothy is, true today: the words on the flat black ground, the console they describe beside them. */
export function Hut({ ctx }: { ctx: PageContext }) {
  const u = ctx.t.home.hut;
  const p = localePrefix(ctx.locale.code);
  return (
    <ReadSection
      id="hut"
      className="ch-hut"
      flip
      text={
        <>
          <h2 id="hut-h">{u.heading}</h2>
          <Lines text={u.lead} />
          <Lines text={u.promise} />
          <p>
            <a className="ch-btn" href={href(`${p}/docs/overview/`)}>
              {u.guide}
            </a>
          </p>
        </>
      }
      figure={<ConsoleMock ctx={ctx} />}
    />
  );
}
