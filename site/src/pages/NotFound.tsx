import { Layout } from '../components/Layout.tsx';
import { href } from '../config.ts';
import { localePrefix } from '../i18n/locales.ts';
import type { PageContext } from '../page-context.ts';

export function NotFound({ ctx }: { ctx: PageContext }) {
  const { t, locale } = ctx;
  const p = localePrefix(locale.code);
  return (
    <Layout ctx={ctx} nav={null}>
      <div className="wrap page narrow">
        <h1>{t.notFound.heading}</h1>
        <p className="lede">{t.notFound.body}</p>
        <p>{t.notFound.links}</p>
        <ul>
          <li>
            <a href={href(`${p}/`)}>{t.nav.home}</a>
          </li>
          <li>
            <a href={href(`${p}/install/`)}>{t.nav.install}</a>
          </li>
          <li>
            <a href={href(`${p}/docs/`)}>{t.nav.docs}</a>
          </li>
          <li>
            <a href={href(`${p}/changelog/`)}>{t.nav.changelog}</a>
          </li>
        </ul>
      </div>
    </Layout>
  );
}
