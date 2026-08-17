// ── the Control landing ──────────────────────────────────────────────────────
//
// One question: what would you click next. Not a fourth copy of the Overview's
// counts, and not a grid of destination cards - the sidebar two centimetres to
// the left IS the destination list, and drawing it again in bigger boxes is the
// footprint rule inverted (principles.md rule 3: an element's size is
// proportional to how many facts it carries, and a card that carries a label a
// nav item already carries carries none).
//
// docs/plans/control-and-settings.md offered a redirect to Services as the
// acceptable outcome if this page could not say anything new. It can, and this is
// the whole justification for it existing:
//
//   · PORT COLLISIONS appear NOWHERE else in the app. The Ports table is sorted
//     by port, so two rows on 8080 are adjacent and readable - but only if you
//     went to look;
//   · a DISABLED ROUTER is one badge in one column of a table nobody opens until
//     something is already broken;
//   · services needing a look are on the Overview, but there they are a flat
//     list of service names. Here they are grouped by SYSTEM and they link into
//     this section, which is a different question ("which system do I open")
//     answered with the same data.
//
// When there is nothing to say, this page says nothing. That is deliberate and
// it is the shape the Overview's attention strip already has: a section that is
// invisible on a healthy box and impossible to miss on a sick one. An empty
// triage page is not a design failure - it is the report.

import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Plug, Waypoints } from 'lucide-react';
import { usePortal, needsAttention } from '../../lib/data';
import { systemLink } from '../../lib/links';
import { StatusIcon } from '../../lib/icons';
import { Skeleton } from '../../components/states';
import './control.css';

interface Finding {
  key: string;
  /** Where the fix lives - always inside this section. */
  to: string;
  /** The sidebar entry that owns it, named so the row says where it is going. */
  where: string;
  icon: ReactNode;
  subject: string;
  what: string;
}

export function Control() {
  const { data } = usePortal();

  const findings = useMemo<Finding[]>(() => {
    const out: Finding[] = [];

    // 1. Systems with something wrong. `needsAttention` rather than a rule of
    //    this page's own: it is the one place that knows a stopped system's
    //    wreckage is not news, and lib/data.tsx exists so the health maths is
    //    computed one way everywhere. Grouped by system because the answer to
    //    "what do I open" is a system page, not six service pages.
    const bySystem = new Map<string, { title: string; n: number; worst: string }>();
    for (const n of needsAttention(data.nodes)) {
      const cur = bySystem.get(n.group) ?? { title: n.groupTitle || n.group, n: 0, worst: '' };
      cur.n += 1;
      // `down` outranks a dangling route in what it makes you do next.
      if (n.status === 'down') cur.worst = 'down';
      else if (!cur.worst) cur.worst = 'no container';
      bySystem.set(n.group, cur);
    }
    for (const [group, s] of bySystem) {
      out.push({
        key: `sys:${group}`,
        to: systemLink(group),
        where: 'Services',
        icon: <StatusIcon status={s.worst === 'down' ? 'down' : 'unknown'} size={15} />,
        subject: s.title,
        what: `${s.n} service${s.n === 1 ? '' : 's'} ${s.worst === 'down' ? 'down' : 'routed to nothing'}`,
      });
    }

    // 2. Ports that collide. Grouped by PORT AND PROTOCOL, across bind
    //    addresses on purpose: 0.0.0.0 covers loopback, so a container on
    //    0.0.0.0:8080 and another on 127.0.0.1:8080 are a genuine overlap even
    //    though the two rows do not look identical. Two rows for the same
    //    container (docker reports tcp and udp, or the same port twice) are not
    //    a collision, which is why the test counts distinct CONTAINERS.
    const byPort = new Map<string, Set<string>>();
    for (const p of data.ports) {
      const k = `${p.hostPort}/${p.proto}`;
      let seen = byPort.get(k);
      if (!seen) byPort.set(k, (seen = new Set()));
      seen.add(p.container);
    }
    for (const [k, containers] of byPort) {
      if (containers.size < 2) continue;
      out.push({
        key: `port:${k}`,
        to: '/control/ports',
        where: 'Ports',
        icon: <Plug size={15} aria-hidden="true" />,
        subject: k,
        what: `claimed by ${[...containers].join(' and ')}`,
      });
    }

    // 3. Routers Traefik itself has switched off. A field read, not a rule -
    //    the Routes table's State column derives 'no container' and 'unknown'
    //    from the node graph, and re-deriving those here would be a second copy
    //    of a rule that is already hard to keep honest. Whatever Traefik says is
    //    not `enabled` is Traefik's own report of a route it will not serve, and
    //    it is the only fault class on this page with no other surface at all.
    for (const r of data.routers) {
      if (!r.status || r.status === 'enabled') continue;
      out.push({
        key: `router:${r.name}`,
        to: '/control/routes',
        where: 'Routes',
        icon: <Waypoints size={15} aria-hidden="true" />,
        subject: String(r.name).split('@')[0],
        what: `router is ${r.status}`,
      });
    }

    return out;
  }, [data.nodes, data.ports, data.routers]);

  // Which sources answered. A page that reports "nothing is wrong" while the
  // socket proxy is unreachable is claiming to know something it does not, and
  // honesty outranks everything but accessibility (principles.md).
  const degraded = useMemo(
    () => [...new Set(data.errors.map((e) => e.src.split(' ')[0]))],
    [data.errors],
  );
  const loading = data.at === 0 && data.fails === 0;

  return (
    <div className="page control-page">
      <div className="page-head">
        <div>
          <h1>Control</h1>
          <p className="page-sub">Everything that is running, and how you reach it.</p>
        </div>
      </div>

      {loading ? (
        <Skeleton />
      ) : (
        <>
          {degraded.length > 0 && (
            <p className="ctl-degraded">
              <AlertTriangle size={14} aria-hidden="true" />
              {degraded.join(' and ')} unreachable - this covers only what is still visible.
            </p>
          )}

          {findings.length === 0 ? (
            <p className="ctl-clear">
              <StatusIcon status="up" size={15} />
              Nothing in here needs a look. No system is reporting a fault, no two
              containers are claiming the same port, and every router is enabled.
            </p>
          ) : (
            <ul className="ctl-findings">
              {findings.map((f) => (
                <li key={f.key}>
                  <Link className="ctl-finding" to={f.to}>
                    <span className="ctl-f-ico">{f.icon}</span>
                    <span className="ctl-f-subject">{f.subject}</span>
                    <span className="ctl-f-what">{f.what}</span>
                    <span className="ctl-f-where">{f.where}</span>
                    <ArrowRight size={14} className="ctl-f-arrow" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
