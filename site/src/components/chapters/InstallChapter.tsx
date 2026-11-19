import { Rich } from '../Rich.tsx';
import { Terminal } from '../Terminal.tsx';
import { REPO_URL, href } from '../../config.ts';
import { LAB_GUEST, LAB_TIMINGS, MEMORY, PROVEN_RELEASE } from '../../facts.ts';
import { localePrefix } from '../../i18n/locales.ts';
import { downloadBase } from '../../lib/releases.ts';
import { formatDate } from '../../lib/format.ts';
import type { CSSProperties } from 'react';
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

/**
 * Chapter 5. Four numbered steps down a long rail, each with its command and a copy icon; at the side, one terminal
 * runs the same install, an example. The scroll position is the progress of the whole sequence (home-sections.ts): the
 * command types, a pause, a running spinner, the output lines one by one, the step's Done tick, then the next step; faster
 * scrolling plays it faster, scrolling back rewinds it, nothing is skipped. The long lists of what was shown and not shown live on the Install page and are linked from here.
 */
export function InstallChapter({ ctx }: { ctx: PageContext }) {
  const { t, locale } = ctx;
  const i = t.home.install;
  const pr = t.home.proof;
  const p = localePrefix(locale.code);
  const nf = new Intl.NumberFormat(locale.tag, { maximumFractionDigits: 0 });
  const lines = installLines(ctx);
  // the side terminal plays the same four commands, whole: nothing is shortened, and long ones wrap
  const demo = lines.map((l) => l.cmd);
  // what each command prints: the dry run lists its four checks (the same example rows as the card above) first
  const outs = demo.map((_, k) =>
    k === 2 ? [...ctx.t.after.checks.rows(MEMORY.gateMiB), i.termOut[k] ?? ''] : [i.termOut[k] ?? ''],
  );
  return (
    <section id="install" className="ch ch-install" aria-labelledby="install-h" data-hs>
      <div className="ch-wrap">
        <header className="hs-head">
          <h2 id="install-h" className="hs-rise">
            {i.heading}
          </h2>
          <p className="ch-lead hs-rise" style={{ '--i': 1 } as CSSProperties}>
            <Rich text={i.lead} />
          </p>
        </header>

        <div className="hs-install">
          <div className="hs-railwrap" data-rail data-scrub>
            <span className="hs-railline" aria-hidden="true">
              <i />
            </span>
            <ol className="hs-rail" aria-label={i.stepsLabel}>
              {lines.map((l, k) => (
                <li key={l.cmd} className="hs-step hs-rise" data-step style={{ '--i': k } as CSSProperties}>
                  <span className="hs-num" aria-hidden="true">
                    {k + 1}
                  </span>
                  <Terminal label={i.steps[k] ?? ''} lines={[l]} />
                  <span className="hs-dn" aria-hidden="true">
                    ✓ {i.done}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <figure
            className="hs-demo hs-rise"
            aria-label={i.terminalLabel}
            data-scrub-demo
            data-mock="install"
            style={{ '--i': 2 } as CSSProperties}
          >
            <figcaption>
              <span>{i.terminalLabel}</span>
              <span className="hs-cap-r">
                <button type="button" className="hs-replay" data-replay hidden aria-label={i.replayLabel}>
                  {i.replay}
                </button>
                <span className="hs-tag">{i.termExample}</span>
              </span>
            </figcaption>
            <pre translate="no" dir="ltr" tabIndex={0}>
              <code>
                {demo.map((cmd, k) => (
                  <span key={cmd} className="hs-ln">
                    <span className="hs-cmd">
                      <span className="prompt" aria-hidden="true">
                        ${' '}
                      </span>
                      <span data-type>{cmd}</span>
                      <span className="hs-run" aria-hidden="true" data-spin />
                    </span>
                    {'\n'}
                    {outs[k]!.map((o, j) => (
                      <span key={o} className={`hs-out${j === outs[k]!.length - 1 ? ' hs-last' : ''}`} data-out>
                        {o}
                        {'\n'}
                      </span>
                    ))}
                  </span>
                ))}
              </code>
            </pre>
          </figure>
        </div>

        <p className="ch-small">
          <Rich text={i.terminalNote} />
        </p>
        <p className="hs-leave">
          <strong>{i.leaveHeading}.</strong> <Rich text={i.leave} />
        </p>

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
        <p>
          <a href={href(`${p}/install/#proof-h`)}>{i.proofLink}</a>
          {' · '}
          {i.paths} <a href={href(`${p}/install/`)}>{i.pathsLink}</a>
          {' · '}
          <a href={href(`${p}/docs/installing/`)}>{i.pathsGuide}</a>
        </p>
      </div>
    </section>
  );
}
