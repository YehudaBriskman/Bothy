import type { ReactNode } from 'react';
import { REPO_URL, href } from '../config.ts';
import { ENABLED_LOCALES, LOCALES, localePrefix, type Locale } from '../i18n/locales.ts';
import type { PageContext } from '../page-context.ts';
import { InstallSplit } from './InstallSplit.tsx';

export type NavKey = 'home' | 'install' | 'docs' | 'changelog' | null;

function Mark() {
  // A bothy seen from the front: a roofline, a door. Drawn, not an icon font,
  // and `currentColor`, so it follows the theme without a second asset.
  return (
    <svg className="mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false">
      <path d="M3 15 16 4l13 11v13H3z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M13 28V19.5a3 3 0 0 1 6 0V28" fill="currentColor" />
    </svg>
  );
}

export function Layout({ ctx, nav, children }: { ctx: PageContext; nav: NavKey; children: ReactNode }) {
  const { locale, t, latest } = ctx;
  const p = localePrefix(locale.code);
  const items: { key: Exclude<NavKey, null>; label: string; to: string }[] = [
    { key: 'install', label: t.nav.install, to: `${p}/install/` },
    { key: 'docs', label: t.nav.docs, to: `${p}/docs/` },
    { key: 'changelog', label: t.nav.changelog, to: `${p}/changelog/` },
  ];
  return (
    <>
      <a className="skip" href="#main">
        {t.nav.skip}
      </a>
      <header className="site-header">
        <div className="wrap bar">
          <a className="brand" href={href(`${p}/`)} aria-current={nav === 'home' ? 'page' : undefined}>
            <Mark />
            <span translate="no">{t.meta.siteTitle}</span>
          </a>
          <nav aria-label={t.nav.label} className="primary">
            <ul>
              {items.map((i) => (
                <li key={i.key} className={i.key === 'install' ? 'nav-dup' : undefined}>
                  <a href={href(i.to)} aria-current={nav === i.key ? 'page' : undefined}>
                    {i.label}
                  </a>
                </li>
              ))}
              <li className="nav-dup">
                <a href={REPO_URL} rel="noopener" className="ext">
                  {t.nav.github}
                </a>
              </li>
            </ul>
          </nav>
          <div className="tools">
            <div className="nav-cta">
              <a className="pill pill-glass" href={REPO_URL} rel="noopener">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                  <path
                    d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1L3.2 9.4l6.1-.8z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                </svg>
                {t.nav.githubShort}
              </a>
              <InstallSplit ctx={ctx} />
            </div>
            <LanguageSwitch ctx={ctx} />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} data-copy-idle={t.home.hero.copy} data-copied={t.home.hero.copied}>
        {children}
      </main>
      <footer className="site-footer">
        <div className="wrap foot">
          <p>{t.footer.line}</p>
          <p className="muted">
            <bdi>{t.footer.version(latest.version)}</bdi>. {t.footer.build}
          </p>
          <ul className="foot-links">
            <li>
              <a href={REPO_URL} rel="noopener" className="ext">
                {t.footer.source}
              </a>
            </li>
            <li>
              <a href={`${REPO_URL}/releases`} rel="noopener" className="ext">
                {t.footer.releases}
              </a>
            </li>
            <li>
              <a href={`${REPO_URL}/blob/main/SECURITY.md`} rel="noopener" className="ext">
                {t.footer.security}
              </a>
            </li>
          </ul>
        </div>
      </footer>
    </>
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
