import { Rich } from '../Rich.tsx';
import { Terminal } from '../Terminal.tsx';
import { REPO_URL, href } from '../../config.ts';
import { LAB_GUEST, LAB_TIMINGS, MEMORY, PROVEN, UNPROVEN, PROVEN_RELEASE } from '../../facts.ts';
import { localePrefix } from '../../i18n/locales.ts';
import { downloadBase } from '../../lib/releases.ts';
import { formatDate } from '../../lib/format.ts';
import type { PageContext } from '../../page-context.ts';

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

const RECORD = `${REPO_URL}/blob/main/docs/plans/thin-bothy/bothy-install.md`;

/** Chapter 5. One command, the checks it really runs, and the proven and unproven lists in plain words. */
export function InstallChapter({ ctx }: { ctx: PageContext }) {
  const { t, locale } = ctx;
  const i = t.home.install;
  const pr = t.home.proof;
  const p = localePrefix(locale.code);
  const nf = new Intl.NumberFormat(locale.tag, { maximumFractionDigits: 0 });
  const checks = [
    i.checks.docker,
    i.checks.memory(MEMORY.gateMiB),
    i.checks.port,
    i.checks.release,
    i.checks.sha,
    i.checks.attestation,
  ];
  return (
    <section id="install" className="ch ch-install" aria-labelledby="install-h">
      <div className="ch-wrap">
        <h2 id="install-h">{i.heading}</h2>
        <p className="ch-lead">
          <Rich text={i.lead} />
        </p>
        <div className="ch-term float">
          <Terminal label={i.terminalLabel} lines={installLines(ctx)} />
          <p className="ch-small">
            <Rich text={i.terminalNote} />
          </p>
        </div>

        <div className="ch-two">
          <div>
            <h3>{i.checksHeading}</h3>
            <ol className="ch-list">
              {checks.map((c) => (
                <li key={c}>
                  <Rich text={c} />
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h3>{i.didHeading}</h3>
            <ul className="ch-list">
              {i.did.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
            <h3>{i.leaveHeading}</h3>
            <p>
              <Rich text={i.leave} />
            </p>
          </div>
        </div>

        <p className="ch-tested">
          <strong>{i.tested}</strong>{' '}
          {i.timing(
            nf.format(LAB_TIMINGS.install.minSeconds),
            nf.format(LAB_TIMINGS.install.maxSeconds),
            nf.format(LAB_TIMINGS.rerun.seconds),
            PROVEN_RELEASE,
            formatDate(LAB_GUEST.date, locale.tag),
          )}{' '}
          <a className="ext" rel="noopener" href={RECORD}>
            {pr.whereLink}
          </a>
          .
        </p>

        <h3 className="ch-proof-h">{pr.heading}</h3>
        <p className="ch-small">{pr.asOf(PROVEN_RELEASE)}</p>
        <div className="ch-two ch-proof">
          <div>
            <h4>
              <span aria-hidden="true" className="ch-glyph ok">
                ✓
              </span>{' '}
              {pr.shownHeading}
            </h4>
            <ul className="ch-list">
              {PROVEN.map((id) => (
                <li key={id}>
                  <Rich text={id === 'install' ? pr.shownInstall(PROVEN_RELEASE, LAB_GUEST.os) : pr.shown[id]} />
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4>
              <span aria-hidden="true" className="ch-glyph no">
                ○
              </span>{' '}
              {pr.notHeading}
            </h4>
            <ul className="ch-list">
              {UNPROVEN.map((id) => (
                <li key={id}>
                  <Rich text={pr.not[id]} />
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p>
          {i.paths} <a href={href(`${p}/install/`)}>{i.pathsLink}</a>
          {' · '}
          <a href={href(`${p}/docs/installing/`)}>{i.pathsGuide}</a>
        </p>
      </div>
    </section>
  );
}
