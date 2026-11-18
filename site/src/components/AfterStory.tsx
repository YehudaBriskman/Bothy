import type { CSSProperties, ReactNode } from 'react';
import { href } from '../config.ts';
import { MEMORY } from '../facts.ts';
import { localePrefix } from '../i18n/locales.ts';
import type { PageContext } from '../page-context.ts';
import { Icon, type IconName } from './Icons.tsx';
import { Rich } from './Rich.tsx';

/**
 * The dark sections after the story: "what you get", as two cards, one wide card and a row of four. Each big card
 * frames a real CC0 sky (the same files the story's chapter backdrops already load, so no extra bytes on this page)
 * with a glass panel of EXAMPLE content over it, labelled as such. Every sentence is from the proven list in facts.ts.
 */
function Photo({ src, children, tall }: { src: string; children: ReactNode; tall?: boolean }) {
  return (
    <figure className={`photo${tall ? ' photo-tall' : ''}`}>
      <img src={href(src)} alt="" loading="lazy" decoding="async" width={1280} height={800} />
      {children}
    </figure>
  );
}

export function AfterStory({ ctx }: { ctx: PageContext }) {
  const a = ctx.t.after;
  const p = localePrefix(ctx.locale.code);
  const i = (n: number) => ({ '--i': n }) as CSSProperties;
  return (
    <div className="after-story">
      <section className="section wrap" aria-labelledby="get-h">
        <header className="section-head reveal">
          <p className="eyebrow">{a.eyebrow}</p>
          <h2 id="get-h">{a.heading}</h2>
          <p className="lede">{a.lede}</p>
        </header>

        <ul className="cards cards-2">
          <li className="reveal" style={i(0)}>
            <article className="card" aria-labelledby="get-ov-h">
              <div className="card-text">
                <h3 id="get-ov-h">{a.overview.title}</h3>
                <p className="lead-in">
                  <Rich text={a.overview.lead} />
                </p>
                <a className="card-link" href={href(`${p}/docs/the-console/`)}>
                  {a.overview.link} <Icon name="arrow" size={16} className="arrow" />
                </a>
              </div>
              <Photo src="scene-mock/img/cumulus-desk.avif">
                <div className="mini">
                  <p className="mini-head">
                    <span>{a.overview.panel}</span>
                    <span className="mini-tag">{a.example}</span>
                  </p>
                  <ul>
                    {a.overview.rows.map((r) => (
                      <li key={r.name}>
                        <span className="dot" aria-hidden="true" />
                        <span className="grow">
                          <span className="mono" translate="no">
                            {r.name}
                          </span>{' '}
                          <span className="sub">{r.sub}</span>
                        </span>
                        <span className="sub">{a.overview.state}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mini-foot">{a.overview.foot}</p>
                </div>
              </Photo>
            </article>
          </li>
          <li className="reveal" style={i(1)}>
            <article className="card" aria-labelledby="get-fi-h">
              <div className="card-text">
                <h3 id="get-fi-h">{a.files.title}</h3>
                <p className="lead-in">
                  <Rich text={a.files.lead} />
                </p>
                <a className="card-link" href={href(`${p}/docs/files/`)}>
                  {a.files.link} <Icon name="arrow" size={16} className="arrow" />
                </a>
              </div>
              <Photo src="scene-mock/img/twilight-desk.avif">
                <div className="mini">
                  <p className="mini-head">
                    <span>{a.files.panel}</span>
                    <span className="mini-tag">{a.example}</span>
                  </p>
                  <ul>
                    {a.files.rows.map((r) => (
                      <li key={r}>
                        <Icon name="file" size={16} className="ico-file" />
                        <span className="grow mono" translate="no" dir="ltr">
                          {r}
                        </span>
                      </li>
                    ))}
                    <li>
                      <span className="grow">{a.files.readOnly}</span>
                      <span className="switch" aria-hidden="true" />
                    </li>
                  </ul>
                  <p className="mini-foot">{a.files.foot}</p>
                </div>
              </Photo>
            </article>
          </li>
        </ul>

        <div className="reveal" style={i(2)}>
          <article className="card card-wide" aria-labelledby="get-ck-h">
            <div className="card-text">
              <h3 id="get-ck-h" className="t-h2">
                {a.checks.title}
              </h3>
              <p className="lead-in">
                <Rich text={a.checks.lead} />
              </p>
              <a className="card-link" href={href(`${p}/#install`)}>
                {a.checks.link} <Icon name="arrow" size={16} className="arrow" />
              </a>
            </div>
            <Photo src="scene-mock/img/deck-desk.avif" tall>
              <div className="mini">
                <p className="mini-head">
                  <span>{a.checks.panel}</span>
                  <span className="mini-tag">{a.example}</span>
                </p>
                <ul>
                  {a.checks.rows(MEMORY.gateMiB).map((r) => (
                    <li key={r}>
                      <span className="tick" aria-hidden="true">
                        <Icon name="check" size={13} />
                      </span>
                      <span className="grow">{r}</span>
                    </li>
                  ))}
                </ul>
                <p className="mini-foot">{a.checks.foot}</p>
              </div>
            </Photo>
          </article>
        </div>

        <ul className="features">
          {a.features.map((f, n) => (
            <li key={f.lead} className="reveal" style={i(n)}>
              <span className="feature-ico" aria-hidden="true">
                <Icon name={f.icon as IconName} size={20} />
              </span>
              <p className="lead-in">
                <Rich text={f.lead} /> <Rich text={f.rest} />
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
