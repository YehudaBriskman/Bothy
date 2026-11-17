import { Layout } from '../components/Layout.tsx';
import { Rich } from '../components/Rich.tsx';
import { Terminal } from '../components/Terminal.tsx';
import { REPO_URL, href } from '../config.ts';
import { PROVEN_RELEASE } from '../facts.ts';
import { localePrefix } from '../i18n/locales.ts';
import { formatDate, formatSize } from '../lib/format.ts';
import { downloadBase, platformOf } from '../lib/releases.ts';
import type { PageContext } from '../page-context.ts';

export function Install({ ctx }: { ctx: PageContext }) {
  const { t, locale, latest, feed } = ctx;
  const i = t.install;
  const v = latest.version;
  const base = downloadBase(feed, latest);
  const archive = `bothy_${v}_linux_amd64.tar.gz`;
  const p = localePrefix(locale.code);
  const rows = latest.assets
    .map((a) => ({ a, platform: platformOf(a.name) }))
    .filter((r): r is { a: (typeof latest.assets)[number]; platform: string } => r.platform !== null);

  return (
    <Layout ctx={ctx} nav="install">
      <div className="wrap page">
        <header className="page-head">
          <h1>{i.heading}</h1>
          <p className="lede">{i.lede}</p>
          <p className="release-line">
            <bdi>{i.release.latest(`v${v}`, formatDate(latest.date, locale.tag))}</bdi>{' '}
            <a className="ext" rel="noopener" href={latest.url}>
              {i.release.page}
            </a>
          </p>
          {v !== PROVEN_RELEASE ? (
            <p className="note">{i.release.newer(PROVEN_RELEASE)}</p>
          ) : (
            <p className="muted">{i.release.proven(PROVEN_RELEASE)}</p>
          )}
        </header>

        <section aria-labelledby="need-h" className="block">
          <h2 id="need-h">{i.need.heading}</h2>
          <ul>
            {i.need.items.map((x) => (
              <li key={x}>
                <Rich text={x} />
              </li>
            ))}
          </ul>
        </section>

        <ol className="install-steps">
          <li>
            <h2>{i.steps.download.title}</h2>
            <p>
              <Rich text={i.steps.download.body} />
            </p>
            <Terminal
              label={i.steps.download.title}

              lines={[{ cmd: `curl -fsSLO ${base}/${archive}` }, { cmd: `curl -fsSLO ${base}/checksums.txt` }]}
            />
          </li>
          <li>
            <h2>{i.steps.verify.title}</h2>
            <p>
              <Rich text={i.steps.verify.body} />
            </p>
            <Terminal
              label={i.steps.verify.title}

              lines={[
                { cmd: 'sha256sum --ignore-missing -c checksums.txt' },
                { cmd: `gh attestation verify ${archive} --repo YehudaBriskman/Bothy`, note: 'optional' },
              ]}
            />
          </li>
          <li>
            <h2>{i.steps.place.title}</h2>
            <p>
              <Rich text={i.steps.place.body} />
            </p>
            <Terminal
              label={i.steps.place.title}

              lines={[
                { cmd: `tar -xzf ${archive}` },
                { cmd: 'install -D -m 0755 bothy ~/.local/bin/bothy' },
                { cmd: 'bothy version' },
              ]}
            />
          </li>
          <li>
            <h2>{i.steps.install.title}</h2>
            <p>
              <Rich text={i.steps.install.body} />
            </p>
            <Terminal
              label={i.steps.install.title}

              lines={[
                { cmd: 'bothy install --dry-run', note: 'prints the plan, changes nothing' },
                { cmd: 'bothy install' },
              ]}
            />
            <p>
              <Rich text={i.steps.install.after} />
            </p>
          </li>
        </ol>

        <section aria-labelledby="later-h" className="block">
          <h2 id="later-h">{i.later.heading}</h2>
          <ul>
            {i.later.items.map((x) => (
              <li key={x}>
                <Rich text={x} />
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="plat-h" className="block">
          <h2 id="plat-h">{i.platforms.heading}</h2>
          <p>{i.platforms.intro}</p>
          {rows.length ? (
            <div className="table-wrap" role="region" aria-label={i.platforms.heading} tabIndex={0}>
              <table className="plat">
                <thead>
                  <tr>
                    <th scope="col">{i.platforms.columns.system}</th>
                    <th scope="col">{i.platforms.columns.archive}</th>
                    <th scope="col">{i.platforms.columns.status}</th>
                    <th scope="col" className="num">
                      {i.platforms.columns.size}
                    </th>
                    <th scope="col">{i.platforms.columns.sha}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ a, platform }) => (
                    <tr key={a.name}>
                      <th scope="row" translate="no">
                        {platform}
                      </th>
                      <td>
                        <a href={a.url} rel="noopener" translate="no" dir="ltr">
                          {a.name}
                        </a>
                      </td>
                      <td>{i.platforms.rows[platform] ?? ''}</td>
                      <td className="num">{formatSize(a.size, locale.tag)}</td>
                      <td>
                        <code translate="no" dir="ltr" className="hash">
                          {a.sha256 ?? ''}
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">{i.platforms.noFeed}</p>
          )}
        </section>

        <section aria-labelledby="no-h" className="block">
          <h2 id="no-h">{i.notSupported.heading}</h2>
          <ul>
            {i.notSupported.items.map((x) => (
              <li key={x}>
                <Rich text={x} />
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="old-h" className="block">
          <h2 id="old-h">{i.older.heading}</h2>
          <p>
            <Rich text={i.older.body} /> <a href={href(`${p}/docs/installing/`)}>{i.older.link}</a>.{' '}
            <a className="ext" rel="noopener" href={REPO_URL}>
              {t.footer.source}
            </a>
          </p>
        </section>
      </div>
    </Layout>
  );
}
