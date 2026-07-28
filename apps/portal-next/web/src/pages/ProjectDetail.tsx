import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { usePortal, healthOf } from '../lib/data';
import { accentVar } from '../lib/accents';
import { ServiceRow } from '../components/ServiceRow';
import { PortsTab } from '../components/PortsTab';
import { RoutesTab } from '../components/RoutesTab';
import { useProbe } from '../lib/useProbe';
import type { Status } from '../lib/discover';
import './Detail.css';

const STATUS_ORDER: { key: Exclude<keyof ReturnType<typeof healthOf>, 'total'>; state: Status; label: string }[] = [
  { key: 'up', state: 'up', label: 'up' },
  { key: 'starting', state: 'starting', label: 'starting' },
  { key: 'down', state: 'down', label: 'down' },
  { key: 'unknown', state: 'unknown', label: 'unknown' },
];

export function ProjectDetail() {
  const { name = '' } = useParams();
  const { data } = usePortal();
  const reduce = useReducedMotion();

  const nodes = useMemo(() => data.nodes.filter((n) => n.group === name && !n.hidden), [data.nodes, name]);
  const title = useMemo(() => {
    const labelled = nodes.find((n) => n.container?.labels?.['dev.portal.project']);
    return labelled?.container?.labels?.['dev.portal.project']
      || name.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  }, [nodes, name]);

  const routerNames = new Set(nodes.filter((n) => n.route).map((n) => n.route!.router));
  const routers = data.routers.filter((r) => routerNames.has(r.name));
  const ports = data.ports.filter((p) => p.group === name);
  const h = healthOf(nodes);

  const orphanUrls = nodes.filter((n) => n.kind === 'orphan-route' && n.url).map((n) => n.url as string);
  const probed = useProbe(orphanUrls);

  const rise = (i: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.34, delay: 0.05 + i * 0.05, ease: [0.2, 0.7, 0.2, 1] as const },
        };

  if (!nodes.length) {
    return (
      <div className="page detail">
        <Link to="/services" className="back-link"><ChevronRight size={15} style={{ transform: 'rotate(180deg)' }} /> Services</Link>
        <div className="state"><h4>No such project</h4><p>Nothing is grouped under “{name}”.</p></div>
      </div>
    );
  }

  const accStyle = { ['--acc' as string]: `var(${accentVar(`project:${name}`)})` } as React.CSSProperties;
  let panel = 0;

  return (
    <div className="page detail" style={accStyle}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/services">Services</Link>
        <ChevronRight size={13} className="sep" aria-hidden="true" />
        <span className="here">{title}</span>
      </nav>

      <motion.header className="detail-head" {...(reduce ? {} : { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.3 } })}>
        <div className="detail-head-meta">
          <h1><span className="acc-bar" />{title}</h1>
          <div className="detail-head-row">
            <span className="dim" style={{ fontSize: 13.5 }}>
              {h.up}/{h.total} up · {ports.length} ports · {routers.length} routes
            </span>
          </div>
        </div>
      </motion.header>

      <div className="dgrid" style={{ marginTop: 18 }}>
        {/* Health rollup */}
        <motion.section className="panel span-12" {...rise(panel++)}>
          <div className="panel-h">Health</div>
          <div className="panel-b health-roll">
            <div className="health-big">
              <span className="n">{h.up}</span>
              <span className="d">/ {h.total} up</span>
            </div>
            <div className="ov-bar" role="img" aria-label={`${h.up} up, ${h.starting} starting, ${h.down} down, ${h.unknown} unknown`}>
              {STATUS_ORDER.map(({ key, state }) =>
                h[key] > 0 ? (
                  <span key={state} className={`seg ${state}`} style={{ width: `${(h[key] / h.total) * 100}%` }} />
                ) : null,
              )}
            </div>
            <div className="health-tags">
              {STATUS_ORDER.map(({ key, state, label }) =>
                h[key] > 0 ? (
                  <span className="tag" key={state}>
                    <span className="dot" data-state={state} /> {label} <span className="n">{h[key]}</span>
                  </span>
                ) : null,
              )}
            </div>
          </div>
        </motion.section>

        {/* Services */}
        <motion.section className="panel span-12" {...rise(panel++)}>
          <div className="panel-h">Services <span className="sub">{nodes.length}</span></div>
          <div className="panel-b panel-tbl">
            <div className="tbl-wrap">
              <table className="tbl svc-tbl">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Status</th>
                    <th>Group</th>
                    <th>Kind</th>
                    <th>Ports</th>
                    <th>Image</th>
                    <th aria-label="open" />
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((n) => (
                    <ServiceRow key={n.id} node={n} probed={n.url ? probed[n.url] : undefined} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </motion.section>

        {/* Routes */}
        {routers.length > 0 && (
          <motion.section className="panel span-12" {...rise(panel++)}>
            <div className="panel-h">Routes <span className="sub">{routers.length}</span></div>
            <div className="panel-b panel-tbl">
              <RoutesTab routers={routers} nodes={nodes} />
            </div>
          </motion.section>
        )}

        {/* Ports */}
        {ports.length > 0 && (
          <motion.section className="panel span-12" {...rise(panel++)}>
            <div className="panel-h">Ports <span className="sub">{ports.length}</span></div>
            <div className="panel-b panel-tbl">
              <PortsTab ports={ports} query="" />
            </div>
          </motion.section>
        )}
      </div>
    </div>
  );
}
