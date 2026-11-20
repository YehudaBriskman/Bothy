import type { CSSProperties, ReactNode } from 'react';
import { REPO_URL, RELEASES_URL, href } from '../config.ts';
import { ENABLED_LOCALES, LOCALES, localePrefix, type Locale } from '../i18n/locales.ts';
import type { PageContext } from '../page-context.ts';
import { Lockup } from './Brand.tsx';
import { FootMark } from './FootMark.tsx';
import { GitHubMark, Icon } from './Icons.tsx';
import { InstallSplit } from './InstallSplit.tsx';

export type NavKey = 'home' | 'install' | 'docs' | 'changelog' | 'about' | null;

/** The licence's own copyright year (LICENSE in the repository root). */
const LICENCE_YEAR = '2026';
const RECORD = `${REPO_URL}/blob/main/docs/plans/thin-bothy/bothy-install.md`;

/**
 * Every page's frame: the pinned header (transparent, no bar, until the page moves; see chrome.css for its states),
 * the page, an optional closing band, and the footer with its cropped wordmark. `glow` gives a page outside the story
 * its soft top light; `cta` adds the closing band (not on Install, which is the call to action, nor on the docs).
 */
export function Layout({
  ctx,
  nav,
  children,
  cta = false,
  glow = true,
}: {
  ctx: PageContext;
  nav: NavKey;
  children: ReactNode;
  cta?: boolean;
  glow?: boolean;
}) {
  const { locale, t } = ctx;
  const p = localePrefix(locale.code);
  const items: { key: Exclude<NavKey, null> | 'modes'; label: string; to: string }[] = [
    { key: 'docs', label: t.nav.docs, to: `${p}/docs/` },
    { key: 'install', label: t.nav.install, to: `${p}/install/` },
    { key: 'modes', label: t.nav.modes, to: `${p}/#sizes` },
    { key: 'changelog', label: t.nav.changelog, to: `${p}/changelog/` },
    { key: 'about', label: t.nav.about, to: `${p}/about/` },
  ];
  return (
    <>
      <a className="skip" href="#main">
        {t.nav.skip}
      </a>
      {glow ? <div className="page-glow" aria-hidden="true" /> : null}
      <header className="site-nav" data-nav>
        <div className="wrap bar">
          <a className="brand" href={href(`${p}/`)} aria-current={nav === 'home' ? 'page' : undefined}>
            <Lockup />
          </a>
          <nav aria-label={t.nav.label} className="primary">
            <ul>
              {items.map((i) => (
                <li key={i.key}>
                  <a href={href(i.to)} aria-current={nav === i.key ? 'page' : undefined}>
                    {i.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="tools">
            <a className="pill pill-glass pill-gh" href={REPO_URL} rel="noopener">
              <Icon name="star" size={16} />
              {t.nav.githubShort}
            </a>
            <InstallSplit ctx={ctx} id="nav-install" />
            <details className="nav-sheet" data-dd>
              <summary className="pill pill-glass" aria-controls="nav-sheet-panel">
                {t.nav.menuButton}
              </summary>
              <div className="sheet-panel" id="nav-sheet-panel">
                <nav aria-label={t.nav.label}>
                  <ul>
                    {items.map((i) => (
                      <li key={i.key}>
                        <a href={href(i.to)} aria-current={nav === i.key ? 'page' : undefined}>
                          {i.label}
                          <Icon name="arrow" size={16} />
                        </a>
                      </li>
                    ))}
                  </ul>
                  <hr />
                  <ul>
                    <li>
                      <a href={REPO_URL} rel="noopener">
                        {t.nav.github}
                        <Icon name="external" size={16} />
                      </a>
                    </li>
                  </ul>
                </nav>
              </div>
            </details>
            <LanguageSwitch ctx={ctx} />
          </div>
        </div>
      </header>
      <main
        id="main"
        tabIndex={-1}
        data-copy-idle={t.home.hero.copy}
        data-copied={t.home.hero.copied}
        data-copy-label={t.home.hero.copyLabel}
        data-copy-fail={t.home.hero.copyFail}
      >
        {children}
        {cta ? <EndCta ctx={ctx} /> : null}
      </main>
      <Footer ctx={ctx} mark={!cta} />
    </>
  );
}

/**
 * The sky band: the dusk photograph, the headline and the two pills. It sits on the home page after the story, high up,
 * where the dark sections begin; its edges melt into the black with plain gradients (no dots).
 */
export function SkyBand({ ctx }: { ctx: PageContext }) {
  const c = ctx.t.cta;
  const p = localePrefix(ctx.locale.code);
  return (
    <section className="sky-cta" aria-labelledby="sky-cta-h">
      <div className="sky-cta-sky" aria-hidden="true">
        <picture>
          <source srcSet={href('sky/dusk-desk.avif')} type="image/avif" media="(min-width: 721px)" />
          <source srcSet={href('sky/dusk-phone.avif')} type="image/avif" />
          <img src={href('sky/dusk-desk.webp')} alt="" loading="lazy" decoding="async" />
        </picture>
      </div>
      <div className="wrap reveal">
        <h2 id="sky-cta-h">
          {c.heading} <span className="soft">{c.soft}</span>
        </h2>
        <div className="actions">
          <a className="pill pill-solid" href={href(`${p}/install/`)}>
            {c.primary}
          </a>
          <a className="pill pill-glass" href={href(`${p}/docs/`)}>
            {c.secondary}
          </a>
        </div>
        <p className="fine">{c.fine}</p>
      </div>
    </section>
  );
}

/**
 * The closing band: plain ink, one proven line, a quiet row of links, and under them the giant BothyBox as a thin
 * outline that the pointer lights, sitting low and clipped by the foot of the page. No photograph, no dots. The band
 * owns the wordmark; the footer carries it only on a page with no band.
 */
function EndCta({ ctx }: { ctx: PageContext }) {
  const { t, locale } = ctx;
  const f = t.footer;
  const p = localePrefix(locale.code);
  const links = [
    { label: f.links.install, to: href(`${p}/install/`) },
    { label: f.links.docs, to: href(`${p}/docs/`) },
    { label: f.links.releases, to: href(`${p}/changelog/`) },
    { label: f.links.source, to: REPO_URL, ext: true },
  ];
  return (
    <section className="end-cta" aria-labelledby="end-cta-h">
      <div className="wrap reveal">
        <h2 id="end-cta-h">{t.cta.closing}</h2>
        <ul className="end-links">
          {links.map((l) => (
            <li key={l.label}>
              <a href={l.to} rel={l.ext ? 'noopener' : undefined} className="link-draw">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
      <FootMark />
    </section>
  );
}

function Footer({ ctx, mark }: { ctx: PageContext; mark: boolean }) {
  const { t, locale, latest } = ctx;
  const f = t.footer;
  const p = localePrefix(locale.code);
  const cols: { title: string; links: { label: string; to: string; ext?: boolean }[] }[] = [
    {
      title: f.cols.product,
      links: [
        { label: f.links.install, to: href(`${p}/install/`) },
        { label: f.links.modes, to: href(`${p}/#sizes`) },
        { label: f.links.releases, to: href(`${p}/changelog/`) },
        { label: f.links.about, to: href(`${p}/about/`) },
      ],
    },
    {
      title: f.cols.resources,
      links: [
        { label: f.links.docs, to: href(`${p}/docs/`) },
        { label: f.links.installing, to: href(`${p}/docs/installing/`) },
        { label: f.links.source, to: REPO_URL, ext: true },
        { label: f.links.record, to: RECORD, ext: true },
      ],
    },
    {
      title: f.cols.legal,
      links: [
        { label: f.links.licence, to: `${REPO_URL}/blob/main/LICENSE`, ext: true },
        { label: f.links.security, to: `${REPO_URL}/blob/main/SECURITY.md`, ext: true },
        { label: f.links.privacy, to: href(`${p}/privacy/`) },
        { label: f.links.accessibility, to: href(`${p}/accessibility/`) },
      ],
    },
  ];
  return (
    <footer className="site-foot">
      {mark ? <FootMark /> : null}
      <div className="foot-body">
        <div className="wrap foot-grid">
          <div className="foot-brand reveal" style={{ '--i': 0 } as CSSProperties}>
            <a className="brand" href={href(`${p}/`)}>
              <Lockup reuse />
            </a>
            <p>{f.description}</p>
            <ul className="foot-social">
              <li>
                <a className="icon-btn" href={REPO_URL} rel="noopener" aria-label={f.github}>
                  <GitHubMark size={18} />
                </a>
              </li>
              <li>
                <a className="icon-btn" href={RELEASES_URL} rel="noopener" aria-label={f.releases}>
                  <Icon name="tag" size={18} />
                </a>
              </li>
            </ul>
          </div>
          {cols.map((c, i) => (
            <nav
              className="foot-col reveal"
              key={c.title}
              style={{ '--i': i + 1 } as CSSProperties}
              aria-labelledby={`foot-h-${i}`}
            >
              <h2 id={`foot-h-${i}`}>{c.title}</h2>
              <ul>
                {c.links.map((l) => (
                  <li key={l.label}>
                    <a href={l.to} rel={l.ext ? 'noopener' : undefined} className="link-draw">
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="wrap">
          <div className="foot-bottom">
            <p>{f.copyright(LICENCE_YEAR)}</p>
            <p>
              <bdi>{f.version(latest.version)}</bdi> · {f.build}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}

/** Rendered only when more than one locale is enabled, so English-only builds carry no dead switcher. */
function LanguageSwitch({ ctx }: { ctx: PageContext }) {
  if (ENABLED_LOCALES.length < 2) return null;
  return (
    <ul className="lang" aria-label="Language">
      {ENABLED_LOCALES.map((code) => {
        const l: Locale = LOCALES[code];
        return (
          <li key={code}>
            <a
              href={href(`${localePrefix(code)}${ctx.pathWithoutLocale}`)}
              lang={l.tag}
              hrefLang={l.tag}
              aria-current={l.code === ctx.locale.code ? 'true' : undefined}
            >
              {l.name}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
