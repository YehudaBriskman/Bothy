import { Rich } from '../Rich.tsx';
import { REPO_URL, RELEASES_URL } from '../../config.ts';
import type { PageContext } from '../../page-context.ts';

/** Chapter 6. Each claim is checkable in the repository or by the site's own build guards. */
export function Trust({ ctx }: { ctx: PageContext }) {
  const r = ctx.t.home.trust;
  const links = [
    { ...r.links.source, to: REPO_URL },
    { ...r.links.licence, to: `${REPO_URL}/blob/main/LICENSE` },
    { ...r.links.releases, to: RELEASES_URL },
    { ...r.links.security, to: `${REPO_URL}/blob/main/SECURITY.md` },
  ];
  return (
    <section id="trust" className="ch ch-trust" aria-labelledby="trust-h">
      <div className="ch-wrap">
        <h2 id="trust-h">{r.heading}</h2>
        <p className="ch-lead">{r.lead}</p>
        <ul className="ch-list ch-claims">
          {r.claims.map((c) => (
            <li key={c}>
              <Rich text={c} />
            </li>
          ))}
        </ul>
        <nav aria-label={r.linksLabel}>
          <ul className="ch-links">
            {links.map((l) => (
              <li key={l.name}>
                <a className="ext" rel="noopener" href={l.to}>
                  <span className="ch-link-name">{l.name}</span>
                  <span className="ch-link-note">{l.note}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <p className="ch-close">{r.close}</p>
        <p className="ch-small">{ctx.t.home.hero.footnote}</p>
      </div>
    </section>
  );
}
