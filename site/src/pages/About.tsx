import type { CSSProperties } from 'react';
import { Icon } from '../components/Icons.tsx';
import { Layout } from '../components/Layout.tsx';
import { Rich } from '../components/Rich.tsx';
import { REPO_URL, RELEASES_URL, href } from '../config.ts';
import { localePrefix } from '../i18n/locales.ts';
import type { PageContext } from '../page-context.ts';

/**
 * About: the name, the software, how it is made, and what this site does with a visit. Every sentence is one the home
 * page's story already says (home.descent, home.hut, home.trust, and, reworded for this page, the hero footnote); this page only gathers them.
 */
export function About({ ctx }: { ctx: PageContext }) {
  const { t } = ctx;
  const a = t.about;
  const h = t.home;
  const p = localePrefix(ctx.locale.code);
  const links = [
    { ...h.trust.links.source, to: REPO_URL },
    { ...h.trust.links.licence, to: `${REPO_URL}/blob/main/LICENSE` },
    { ...h.trust.links.releases, to: RELEASES_URL },
    { ...h.trust.links.security, to: `${REPO_URL}/blob/main/SECURITY.md` },
  ];
  return (
    <Layout ctx={ctx} nav="about" cta>
      <div className="wrap page">
        <header className="page-head">
          <p className="eyebrow">{a.eyebrow}</p>
          <h1>{a.heading}</h1>
          <p className="lede">
            <Rich text={h.hut.lead} />
          </p>
        </header>

        <div className="about-grid">
          <section className="card reveal" aria-labelledby="about-name-h">
            <div>
              <p className="eyebrow">{a.nameEyebrow}</p>
              <h2 id="about-name-h" className="t-h3">
                {h.descent.heading}
              </h2>
              <p className="muted">{h.descent.lead}</p>
            </div>
            <div>
              <h3 className="t-label muted">{h.descent.codeLabel}</h3>
              <ul className="code-list">
                {h.descent.code.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <p className="muted small" style={{ marginBlockStart: '0.75rem' }}>
                {h.descent.codeSource}
              </p>
            </div>
          </section>
          <section className="card reveal" style={{ '--i': 1 } as CSSProperties} aria-labelledby="about-what-h">
            <div>
              <p className="eyebrow">{a.whatEyebrow}</p>
              <h2 id="about-what-h" className="t-h3">
                {h.hut.heading}
              </h2>
              <p className="muted">{h.hut.promise}</p>
              <p className="muted">{h.descent.close}</p>
            </div>
            <a className="card-link" href={href(`${p}/docs/`)}>
              {h.hut.guide} <Icon name="arrow" size={16} className="arrow" />
            </a>
          </section>
        </div>

        <section className="section-block" aria-labelledby="about-made-h">
          <header className="section-head reveal">
            <p className="eyebrow">{a.madeEyebrow}</p>
            <h2 id="about-made-h">{h.trust.heading}</h2>
            <p className="lede">{h.trust.lead}</p>
          </header>
          <ul className="proof-list proof-shown about-claims reveal">
            {h.trust.claims.map((c) => (
              <li key={c}>
                <Rich text={c} />
              </li>
            ))}
          </ul>
          <ul className="link-rows reveal" aria-label={h.trust.linksLabel}>
            {links.map((l) => (
              <li key={l.name}>
                <a rel="noopener" href={l.to}>
                  <span className="link-name">{l.name}</span>
                  <span className="link-note">{l.note}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section id="privacy" className="section-block" aria-labelledby="about-privacy-h">
          <header className="section-head reveal">
            <p className="eyebrow">{a.privacyEyebrow}</p>
            <h2 id="about-privacy-h">{a.privacyHeading}</h2>
            <p className="lede">{a.privacyBody}</p>
          </header>
        </section>
      </div>
    </Layout>
  );
}
