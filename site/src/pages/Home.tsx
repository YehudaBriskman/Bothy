import { Layout } from '../components/Layout.tsx';
import { Rich } from '../components/Rich.tsx';
import { Terminal } from '../components/Terminal.tsx';
import { REPO_URL, href } from '../config.ts';
import { PROVEN_RELEASE } from '../facts.ts';
import { localePrefix } from '../i18n/locales.ts';
import { downloadBase } from '../lib/releases.ts';
import type { PageContext } from '../page-context.ts';

export function installLines(ctx: PageContext) {
  const v = ctx.latest.version;
  const base = downloadBase(ctx.feed, ctx.latest);
  const archive = `bothy_${v}_linux_amd64.tar.gz`;
  return [
    { cmd: `curl -fsSLO ${base}/${archive}` },
    { cmd: `tar -xzf ${archive} && install -D bothy ~/.local/bin/bothy` },
    { cmd: 'bothy install --dry-run', note: 'read the plan' },
    { cmd: 'bothy install' },
  ];
}

export function Home({ ctx }: { ctx: PageContext }) {
  const { t, locale } = ctx;
  const h = t.home;
  const p = localePrefix(locale.code);
  return (
    <Layout ctx={ctx} nav="home">
      <section className="hero">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <h1>{h.hero.heading}</h1>
            <p className="lede">{h.hero.lede}</p>
            <p className="actions">
              <a className="btn primary" href={href(`${p}/install/`)}>
                {h.hero.primary}
              </a>
              <a className="btn" href={href(`${p}/docs/`)}>
                {h.hero.secondary}
              </a>
            </p>
          </div>
          <div className="hero-term">
            <Terminal label={h.hero.terminalLabel} lines={installLines(ctx)} />
            <p className="small muted">{h.hero.terminalNote}</p>
          </div>
        </div>
      </section>

      <section className="band" aria-labelledby="app-h">
        <div className="wrap">
          <h2 id="app-h">{h.app.heading}</h2>
          <p className="intro">{h.app.intro}</p>
          <ol className="steps">
            {h.app.steps.map((s) => (
              <li key={s.title}>
                <h3>{s.title}</h3>
                <p>
                  <Rich text={s.body} />
                </p>
              </li>
            ))}
          </ol>
          <div className="trust">
            <h3>{h.app.trust.heading}</h3>
            <ul>
              {h.app.trust.items.map((i) => (
                <li key={i}>
                  <Rich text={i} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="band" aria-labelledby="modes-h">
        <div className="wrap">
          <h2 id="modes-h">{h.modes.heading}</h2>
          <p className="intro">{h.modes.intro}</p>
          <ol className="ladder" aria-label={h.modes.profileLabel}>
            {h.modes.items.map((m, i) => (
              <li key={m.name} className={`rung rung-${i + 1} ${m.status}`}>
                <p className={`chip ${m.status}`}>
                  <span aria-hidden="true">{m.status === 'available' ? '✓' : '○'}</span>{' '}
                  {m.status === 'available' ? h.modes.available : h.modes.planned}
                </p>
                <h3 translate="no">{m.name}</h3>
                <p className="tagline">{m.tagline}</p>
                <p>{m.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="band" aria-labelledby="status-h">
        <div className="wrap">
          <h2 id="status-h">{h.status.heading}</h2>
          <p className="intro">{h.status.asOf(PROVEN_RELEASE)}</p>
          <div className="status-grid">
            <div>
              <h3>
                <span aria-hidden="true" className="glyph ok">
                  ✓
                </span>{' '}
                {h.status.worksHeading}
              </h3>
              <ul>
                {h.status.works.map((w) => (
                  <li key={w}>
                    <Rich text={w} />
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>
                <span aria-hidden="true" className="glyph no">
                  ○
                </span>{' '}
                {h.status.notHeading}
              </h3>
              <ul>
                {h.status.not.map((w) => (
                  <li key={w}>
                    <Rich text={w} />
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p>
            {h.status.where}{' '}
            <a className="ext" rel="noopener" href={`${REPO_URL}/blob/main/docs/plans/thin-bothy/bothy-install.md`}>
              {h.status.whereLink}
            </a>
          </p>
        </div>
      </section>

      <section className="band" aria-labelledby="docs-h">
        <div className="wrap narrow">
          <h2 id="docs-h">{h.docsTeaser.heading}</h2>
          <p>{h.docsTeaser.body}</p>
          <p>
            <a className="btn" href={href(`${p}/docs/`)}>
              {h.docsTeaser.link}
            </a>
          </p>
        </div>
      </section>
    </Layout>
  );
}
