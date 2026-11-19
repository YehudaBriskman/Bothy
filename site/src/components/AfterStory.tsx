import type { CSSProperties, ReactNode } from 'react';
import { href } from '../config.ts';
import { LAB_TIMINGS, MEMORY } from '../facts.ts';
import { localePrefix } from '../i18n/locales.ts';
import type { PageContext } from '../page-context.ts';
import { Icon } from './Icons.tsx';
import { Rich } from './Rich.tsx';

/**
 * The dark sections after the story: "what you get", as a two-column head, two photo-window cards (window first,
 * one caption under it), one wide dry-run card and a row of four big words. Each photo window frames a real CC0 sky
 * (the same files the story's chapter backdrops already load, so no extra bytes on this page) that drifts slowly,
 * with a glass panel of EXAMPLE content over it, labelled as such. Every sentence is from the proven list in facts.ts.
 * Motion lives in styles/home-sections.css and home-sections.ts; with no script, or reduced motion, all of it is
 * simply the finished page.
 */
function Photo({ src, children, drift }: { src: string; children: ReactNode; drift: 'a' | 'b' }) {
  return (
    <figure className={`photo hs-drift-${drift}`}>
      <img src={href(src)} alt="" loading="lazy" decoding="async" width={1280} height={800} />
      {children}
    </figure>
  );
}

export function AfterStory({ ctx, mid, end }: { ctx: PageContext; mid?: ReactNode; end?: ReactNode }) {
  const a = ctx.t.after;
  const p = localePrefix(ctx.locale.code);
  const i = (n: number) => ({ '--i': n }) as CSSProperties;
  const rerun = new Intl.NumberFormat(ctx.locale.tag, { maximumFractionDigits: 0 }).format(LAB_TIMINGS.rerun.seconds);
  const checkRows = a.checks.rows(MEMORY.gateMiB);
  return (
    <div className="after-story">
      <section className="section wrap" aria-labelledby="get-h">
        <header className="hs-head hs-after" data-hs>
          <p className="eyebrow">{a.eyebrow}</p>
          <h2 id="get-h" className="hs-mask">
            <span>{a.heading}</span>
          </h2>
          <p className="lede hs-fade" style={i(3)}>
            {a.lede}
          </p>
        </header>

        <ul className="cards cards-2" data-hs>
          <li className="hs-rise" style={i(0)}>
            <article className="card hs-photocard" aria-labelledby="get-ov-h">
              <Photo src="scene-mock/img/cumulus-desk.avif" drift="a">
                <div className="mini hs-float">
                  <p className="mini-head">
                    <span>{a.overview.panel}</span>
                    <span className="mini-tag">{a.example}</span>
                  </p>
                  <ul>
                    {a.overview.rows.map((r, k) => (
                      <li key={r.name} className="hs-row" style={i(k)}>
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
              <div className="card-text">
                <h3 id="get-ov-h">{a.overview.title}</h3>
                <p className="lead-in">
                  <Rich text={a.overview.lead} />
                </p>
                <a className="card-link" href={href(`${p}/docs/the-console/`)}>
                  {a.overview.link} <Icon name="arrow" size={16} className="arrow" />
                </a>
              </div>
            </article>
          </li>
          <li className="hs-rise" style={i(1)}>
            <article className="card hs-photocard" aria-labelledby="get-fi-h">
              <Photo src="scene-mock/img/twilight-desk.avif" drift="b">
                <div className="mini hs-float">
                  <p className="mini-head">
                    <span>{a.files.panel}</span>
                    <span className="mini-tag">{a.example}</span>
                  </p>
                  <ul>
                    {a.files.rows.map((r, k) => (
                      <li key={r} className="hs-row" style={i(k)}>
                        <Icon name="file" size={16} className="ico-file" />
                        <span className="grow mono" translate="no" dir="ltr">
                          {r}
                        </span>
                      </li>
                    ))}
                    <li className="hs-row" style={i(a.files.rows.length)}>
                      <span className="grow">{a.files.readOnly}</span>
                      <span className="switch" aria-hidden="true" />
                    </li>
                  </ul>
                  <p className="mini-foot">{a.files.foot}</p>
                </div>
              </Photo>
              <div className="card-text">
                <h3 id="get-fi-h">{a.files.title}</h3>
                <p className="lead-in">
                  <Rich text={a.files.lead} />
                </p>
                <a className="card-link" href={href(`${p}/docs/files/`)}>
                  {a.files.link} <Icon name="arrow" size={16} className="arrow" />
                </a>
              </div>
            </article>
          </li>
        </ul>

        <div data-hs>
          <article className="card hs-dry hs-rise" style={i(2)} aria-labelledby="get-ck-h">
            <div className="hs-dry-top">
              <h3 id="get-ck-h">{a.checks.title}</h3>
              <p className="lead-in">
                <Rich text={a.checks.lead} />
              </p>
              <a className="card-link" href={href(`${p}/#install`)}>
                {a.checks.link} <Icon name="arrow" size={16} className="arrow" />
              </a>
            </div>
            <div className="hs-dry-body" data-run>
              <div className="hs-dry-checks mini">
                <p className="mini-head">
                  <span>{a.checks.panel}</span>
                  <span className="mini-tag">{a.example}</span>
                </p>
                <ul>
                  {checkRows.map((r, k) => (
                    <li key={r} data-row={k}>
                      <span className="tick" aria-hidden="true">
                        <Icon name="check" size={13} />
                      </span>
                      <span className="grow">{r}</span>
                    </li>
                  ))}
                </ul>
                <p className="mini-foot" data-foot>
                  {a.checks.foot}
                </p>
              </div>
              <figure className="hs-demo hs-dry-term" aria-hidden="true">
                <figcaption>
                  <span>bothy</span>
                  <span className="hs-tag">{a.example}</span>
                </figcaption>
                <pre translate="no" dir="ltr">
                  <code>
                    <span className="hs-cmd">
                      <span className="prompt">$ </span>
                      <span data-type>bothy install --dry-run</span>
                    </span>
                    {'\n'}
                    {a.checks.short.map((s, k) => (
                      <span key={s} className="hs-out" data-out={k}>
                        <span className="hs-ok">ok</span> {s}
                        {'\n'}
                      </span>
                    ))}
                    <span className="hs-out hs-done" data-out={a.checks.short.length}>
                      {a.checks.done}
                      {'\n'}
                    </span>
                  </code>
                </pre>
              </figure>
            </div>
          </article>
        </div>
        {mid}

        <ul className="features" data-hs>
          {a.features.map((f, n) => (
            <li key={f.lead} className="hs-feat" style={i(n)}>
              <span className="hs-rule" aria-hidden="true" />
              <p className="hs-big hs-mask">
                <span>{f.big || a.aboutSecond(rerun)}</span>
              </p>
              <p className="lead-in hs-fade" style={i(n + 4)}>
                <Rich text={f.lead} /> <Rich text={f.rest} />
              </p>
            </li>
          ))}
        </ul>
        {end}
      </section>
    </div>
  );
}
