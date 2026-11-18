import { Layout } from '../components/Layout.tsx';
import { href } from '../config.ts';
import { localePrefix } from '../i18n/locales.ts';
import type { PageContext } from '../page-context.ts';

export function NotFound({ ctx }: { ctx: PageContext }) {
  const { t, locale } = ctx;
  const p = localePrefix(locale.code);
  const links = [
    { to: `${p}/`, label: t.nav.home },
    { to: `${p}/install/`, label: t.nav.install },
    { to: `${p}/docs/`, label: t.nav.docs },
    { to: `${p}/changelog/`, label: t.nav.changelog },
  ];
  return (
    <Layout ctx={ctx} nav={null}>
      <div className="wrap page narrow">
        <header className="page-head">
          <p className="eyebrow">404</p>
          <h1>{t.notFound.heading}</h1>
          <p className="lede">{t.notFound.body}</p>
        </header>
        <h2 className="t-label muted">{t.notFound.links}</h2>
        <ul className="nf-links">
          {links.map((l, i) => (
            <li key={l.to}>
              <a className={`pill ${i === 0 ? 'pill-solid' : 'pill-glass'}`} href={href(l.to)}>
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </Layout>
  );
}
