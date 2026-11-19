import type { CSSProperties } from 'react';
import { Icon, type IconName } from '../Icons.tsx';
import { Rich } from '../Rich.tsx';
import { Terminal } from '../Terminal.tsx';
import { REPO_URL, RELEASES_URL } from '../../config.ts';
import type { PageContext } from '../../page-context.ts';

const i = (n: number) => ({ '--i': n }) as CSSProperties;

/**
 * Chapter 6, "built in the open": the claims on the start side, four hairline link rows (icon, name, arrow) on the
 * other, then one band holding the dry-run command. Each claim is checkable in the repository or by the site's own
 * build guards; no star or contributor counts, because we have not got them.
 */
export function Trust({ ctx }: { ctx: PageContext }) {
  const r = ctx.t.home.trust;
  const links: { icon: IconName; name: string; note: string; to: string }[] = [
    { icon: 'code', ...r.links.source, to: REPO_URL },
    { icon: 'book', ...r.links.licence, to: `${REPO_URL}/blob/main/LICENSE` },
    { icon: 'tag', ...r.links.releases, to: RELEASES_URL },
    { icon: 'lock', ...r.links.security, to: `${REPO_URL}/blob/main/SECURITY.md` },
  ];
  return (
    <section id="trust" className="ch ch-trust" aria-labelledby="trust-h" data-hs>
      <div className="ch-wrap">
        <div className="hs-open">
          <div>
            <h2 id="trust-h" className="hs-rise">
              {r.heading}
            </h2>
            <p className="ch-lead hs-rise" style={i(1)}>
              {r.lead}
            </p>
            <ul className="hs-claims">
              {r.claims.map((c, k) => (
                <li key={c} className="hs-fade" style={i(k + 2)}>
                  <span className="hs-tick" aria-hidden="true">
                    <Icon name="check" size={13} />
                  </span>
                  <span>
                    <Rich text={c} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <nav aria-label={r.linksLabel}>
            <ul className="hs-links">
              {links.map((l, k) => (
                <li key={l.name} className="hs-slide" style={i(k + 2)}>
                  <a className="ext" rel="noopener" href={l.to}>
                    <span className="hs-link-ico" aria-hidden="true">
                      <Icon name={l.icon} size={20} />
                    </span>
                    <span className="hs-link-text">
                      <span className="hs-link-name">{l.name}</span>
                      <span className="hs-sm">{l.note}</span>
                    </span>
                    <Icon name="arrow" size={18} className="hs-arrow" />
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <div className="hs-band hs-rise" style={i(7)}>
          <p>{r.bandText}</p>
          <Terminal label={ctx.t.after.checks.panel} lines={[{ cmd: 'bothy install --dry-run' }]} />
        </div>
        <p className="ch-close">{r.close}</p>
        <p className="ch-small">{ctx.t.home.hero.footnote}</p>
      </div>
    </section>
  );
}
