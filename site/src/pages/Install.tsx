import type { CSSProperties } from 'react';
import { Icon } from '../components/Icons.tsx';
import { Layout } from '../components/Layout.tsx';
import { Rich } from '../components/Rich.tsx';
import { Terminal } from '../components/Terminal.tsx';
import { REPO_URL, href } from '../config.ts';
import { LAB_GUEST, MEMORY, PROVEN, PROVEN_RELEASE, UNPROVEN } from '../facts.ts';
import { localePrefix } from '../i18n/locales.ts';
import { formatDate, formatSize } from '../lib/format.ts';
import { downloadBase, platformOf } from '../lib/releases.ts';
import type { PageContext } from '../page-context.ts';

const RECORD = `${REPO_URL}/blob/main/docs/plans/thin-bothy/bothy-install.md`;

/** The install page: two paths, the commands, the checks, and the proven and unproven lists. */
export function Install({ ctx }: { ctx: PageContext }) {
  const { t, locale, latest, feed } = ctx;
  const i = t.install;
  const pr = t.home.proof;
  const v = latest.version;
  const base = downloadBase(feed, latest);
  const archive = `bothy_${v}_linux_amd64.tar.gz`;
  const p = localePrefix(locale.code);
  const sha = latest.assets.find((a) => a.name === archive)?.sha256 ?? null;
  const rows = latest.assets
    .map((a) => ({ a, platform: platformOf(a.name) }))
    .filter((r): r is { a: (typeof latest.assets)[number]; platform: string } => r.platform !== null);
  const [first, second, ...rest] = i.need.items;
  const needItems = [first, second, i.need.memory(MEMORY.gateMiB), ...rest].filter((x): x is string => !!x);
  const nf = new Intl.NumberFormat(locale.tag, { maximumFractionDigits: 0 });

  return (
    <Layout ctx={ctx} nav="install">
      <div className="wrap page page-install">
        <header className="page-head">
          <p className="eyebrow">{i.eyebrow}</p>
          <h1>{i.heading}</h1>
          <p className="lede">{i.lede}</p>
          <p className="page-meta">
            <bdi>{i.release.latest(`v${v}`, formatDate(latest.date, locale.tag))}</bdi>
            <span className="sep" aria-hidden="true">
              ·
            </span>
            <a rel="noopener" href={latest.url}>
              {i.release.page}
            </a>
          </p>
          {v !== PROVEN_RELEASE ? (
            <p className="note-line">{i.release.newer(PROVEN_RELEASE)}</p>
          ) : (
            <p className="note-line">{i.release.proven(PROVEN_RELEASE)}</p>
          )}
        </header>

        <section aria-labelledby="paths-h" className="block wide">
          <h2 id="paths-h">{i.paths.heading}</h2>
          <div className="path-grid">
            <article className="card path-card reveal" aria-labelledby="path-bin-h">
              <p className="path-tag path-tag-proven">{i.paths.binary.tag}</p>
              <h3 id="path-bin-h">{i.paths.binary.title}</h3>
              <p>
                <Rich text={i.paths.binary.body} />
              </p>
              <p className="muted">
                <Rich text={i.paths.binary.needs} />
              </p>
              <p className="muted">
                <Rich text={i.paths.binary.proof} />
              </p>
              <a className="card-link" href="#binary">
                {i.paths.jump} <Icon name="arrow" size={16} className="arrow" />
              </a>
            </article>
            <article
              className="card path-card reveal"
              style={{ '--i': 1 } as CSSProperties}
              aria-labelledby="path-src-h"
            >
              <p className="path-tag">{i.paths.source.tag}</p>
              <h3 id="path-src-h">{i.paths.source.title}</h3>
              <p>
                <Rich text={i.paths.source.body} />
              </p>
              <p className="muted">
                <Rich text={i.paths.source.needs} />
              </p>
              <p className="muted">
                <Rich text={i.paths.source.proof} />
              </p>
              <a className="card-link" href="#source">
                {i.paths.jump} <Icon name="arrow" size={16} className="arrow" />
              </a>
            </article>
          </div>
        </section>

        <section aria-labelledby="need-h" className="block">
          <h2 id="need-h">{i.need.heading}</h2>
          <p>
            <Rich text={i.need.lead} />
          </p>
          <ul>
            {needItems.map((x) => (
              <li key={x}>
                <Rich text={x} />
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="user-h" className="block">
          <h2 id="user-h">{i.user.heading}</h2>
          <p className="note">
            <Rich text={i.user.body} />
          </p>
          <p className="muted">
            <Rich text={i.user.caveat} />
          </p>
        </section>

        <section id="binary" aria-labelledby="binary-h" className="wide-steps">
          <h2 id="binary-h">{i.binary.heading}</h2>
          <ol className="install-steps">
            <li>
              <h3>{i.binary.steps.download.title}</h3>
              <p>
                <Rich text={i.binary.steps.download.body} />
              </p>
              <Terminal
                label={i.binary.steps.download.title}
                lines={[{ cmd: `curl -fsSLO ${base}/${archive}` }, { cmd: `curl -fsSLO ${base}/checksums.txt` }]}
              />
            </li>
            <li>
              <h3>{i.binary.steps.verify.title}</h3>
              <p>
                <Rich text={i.binary.steps.verify.body} />
              </p>
              <Terminal
                label={i.binary.steps.verify.title}
                lines={[
                  { cmd: 'sha256sum --ignore-missing -c checksums.txt' },
                  {
                    cmd: `gh attestation verify ${archive} --repo ${feed.repo}`,
                    note: 'optional, needs gh',
                  },
                  {
                    cmd: `gh attestation verify checksums.txt --repo ${feed.repo}`,
                    note: 'optional, the line the installer prints',
                  },
                ]}
              />
              {sha ? (
                <p>
                  {i.binary.steps.verify.expect}{' '}
                  <code translate="no" dir="ltr" className="hash">
                    {sha}
                  </code>{' '}
                  <span className="muted">
                    <Rich text={i.binary.steps.verify.expectNote} />
                  </span>
                </p>
              ) : (
                <p className="muted">
                  <Rich text={i.binary.steps.verify.noSha} />
                </p>
              )}
            </li>
            <li>
              <h3>{i.binary.steps.place.title}</h3>
              <p>
                <Rich text={i.binary.steps.place.body} />
              </p>
              <Terminal
                label={i.binary.steps.place.title}
                lines={[
                  { cmd: `tar -xzf ${archive}` },
                  { cmd: 'install -D -m 0755 bothy ~/.local/bin/bothy' },
                  { cmd: 'bothy version' },
                ]}
              />
            </li>
            <li>
              <h3>{i.binary.steps.install.title}</h3>
              <p>
                <Rich text={i.binary.steps.install.body} />
              </p>
              <Terminal
                label={i.binary.steps.install.title}
                lines={[
                  { cmd: 'bothy install --dry-run', note: 'prints the plan, changes nothing' },
                  { cmd: 'bothy install' },
                ]}
              />
              <p>
                <Rich text={i.binary.steps.install.after} />
              </p>
              <p className="note">
                <Rich text={i.binary.steps.install.bind} />
              </p>
            </li>
          </ol>
        </section>

        <section id="source" aria-labelledby="source-h" className="block">
          <h2 id="source-h">{i.source.heading}</h2>
          <p>
            <Rich text={i.source.lead} />
          </p>
          <Terminal
            label={i.source.stepsTitle}
            lines={[
              { cmd: `git clone ${REPO_URL}.git && cd Bothy` },
              { cmd: 'cp .env.example .env' },
              { cmd: 'just up' },
              { cmd: 'just urls' },
              { cmd: 'just doctor' },
            ]}
          />
          <ul>
            {i.source.notes.map((x) => (
              <li key={x}>
                <Rich text={x} />
              </li>
            ))}
          </ul>
          <p>
            <a href={href(`${p}/docs/installing/`)}>{i.source.guide}</a>
          </p>
        </section>

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

        <section aria-labelledby="proof-h" className="block wide">
          <h2 id="proof-h">{i.proof.heading}</h2>
          <p>{i.proof.lead}</p>
          <div className="proof-grid">
            <div className="card proof-card reveal">
              <h3>{pr.shownHeading}</h3>
              <ul className="proof-list proof-shown">
                {PROVEN.map((id) => (
                  <li key={id}>
                    {id === 'install' ? pr.shownInstall(PROVEN_RELEASE, LAB_GUEST.os) : <Rich text={pr.shown[id]} />}
                  </li>
                ))}
              </ul>
            </div>
            <div className="card proof-card reveal" style={{ '--i': 1 } as CSSProperties}>
              <h3>{pr.notHeading}</h3>
              <ul className="proof-list proof-not">
                {UNPROVEN.map((id) => (
                  <li key={id}>
                    <Rich text={pr.not[id]} />
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="muted proof-foot">
            {pr.asOf(PROVEN_RELEASE)} ({LAB_GUEST.date}, {nf.format(MEMORY.gateMiB)} MiB memory gate){' '}
            <a rel="noopener" href={RECORD}>
              {i.older.record}
            </a>
          </p>
        </section>

        <section aria-labelledby="plat-h" className="block wide">
          <h2 id="plat-h">{i.platforms.heading}</h2>
          <p>{i.platforms.intro}</p>
          {rows.length ? (
            <div
              className="table-wrap"
              role="region"
              aria-label={`${t.docs.tableLabel}: ${i.platforms.heading}`}
              tabIndex={0}
            >
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
            {i.older.body} <a href={href(`${p}/docs/installing/`)}>{i.older.link}</a>.{' '}
            <a className="ext" rel="noopener" href={REPO_URL}>
              {t.footer.source}
            </a>
          </p>
        </section>
      </div>
    </Layout>
  );
}
