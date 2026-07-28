import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronRight, HardDrive, SlidersHorizontal, X } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { usePortal, healthOf } from '../lib/data';
import { groupByType, systemsOf, volumeSize, systemDiskBytes, fmtBytes } from '../lib/systems';
import { TypeIcon, StatusIcon } from '../lib/icons';
import { ServiceRow } from '../components/ServiceRow';
import { PortsTab } from '../components/PortsTab';
import { RoutesTab } from '../components/RoutesTab';
import { useProbe } from '../lib/useProbe';
import { TYPE_META } from '../lib/discover';
import type { Status, ServiceType } from '../lib/discover';
import './Detail.css';

const TYPE_LABEL = Object.fromEntries(
  (Object.keys(TYPE_META) as ServiceType[]).map((t) => [t, TYPE_META[t].label]),
) as Record<ServiceType, string>;

const STATUS_ORDER: { key: Exclude<keyof ReturnType<typeof healthOf>, 'total'>; state: Status; label: string }[] = [
  { key: 'up', state: 'up', label: 'up' },
  { key: 'starting', state: 'starting', label: 'starting' },
  { key: 'down', state: 'down', label: 'down' },
  { key: 'unknown', state: 'unknown', label: 'unknown' },
];

const STATUSES: Status[] = ['up', 'starting', 'down', 'unknown'];
const STATUS_LABEL: Record<Status, string> = { up: 'Up', starting: 'Starting', down: 'Down', unknown: 'Unknown' };
const KIND_LABEL: Record<'project' | 'stack' | 'infra', string> = {
  project: 'Project',
  stack: 'Stack service',
  infra: 'Infra',
};

export function ProjectDetail() {
  const { name = '' } = useParams();
  const { data } = usePortal();
  const reduce = useReducedMotion();

  const [statusFilter, setStatusFilter] = useState<Set<Status>>(new Set());
  const [typeFilter, setTypeFilter] = useState<Set<ServiceType>>(new Set());

  // The system rollup owns title, kind, accent and volumes — derive it once so
  // the header, chips and data card all agree.
  const system = useMemo(
    () => systemsOf(data.nodes).find((s) => s.key === name) ?? null,
    [data.nodes, name],
  );
  const nodes = system?.nodes ?? [];

  const routerNames = new Set(nodes.filter((n) => n.route).map((n) => n.route!.router));
  const routers = data.routers.filter((r) => routerNames.has(r.name));
  const ports = data.ports.filter((p) => p.group === name);
  const h = healthOf(nodes);

  // Stable set of type chips: every type present in this system, type-ordered.
  const presentTypes = useMemo(() => groupByType(nodes).map((s) => s.type), [nodes]);

  // Type + status combine; each chip reports its count against the OTHER active
  // filter (same honest-facet behaviour as the Services filter bar).
  const { sections, typeCounts, statusCounts } = useMemo(() => {
    const mStatus = (s: Status) => statusFilter.size === 0 || statusFilter.has(s);
    const mType = (t: ServiceType) => typeFilter.size === 0 || typeFilter.has(t);
    const filtered = nodes.filter((n) => mStatus(n.status) && mType(n.serviceType));
    const sections = groupByType(filtered);

    const typeCounts = new Map<ServiceType, number>();
    for (const n of nodes) if (mStatus(n.status)) typeCounts.set(n.serviceType, (typeCounts.get(n.serviceType) ?? 0) + 1);

    const statusCounts: Record<Status, number> = { up: 0, starting: 0, down: 0, unknown: 0 };
    for (const n of nodes) if (mType(n.serviceType)) statusCounts[n.status]++;

    return { sections, typeCounts, statusCounts };
  }, [nodes, statusFilter, typeFilter]);

  const orphanUrls = useMemo(
    () => sections.flatMap((s) => s.nodes).filter((n) => n.kind === 'orphan-route' && n.url).map((n) => n.url as string),
    [sections],
  );
  const probed = useProbe(orphanUrls);

  const toggleStatus = (s: Status) =>
    setStatusFilter((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  const toggleType = (t: ServiceType) =>
    setTypeFilter((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });
  const activeFilters = statusFilter.size > 0 || typeFilter.size > 0;
  const clearAll = () => { setStatusFilter(new Set()); setTypeFilter(new Set()); };

  const rise = (i: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.34, delay: 0.05 + i * 0.05, ease: [0.2, 0.7, 0.2, 1] as const },
        };

  if (!system) {
    return (
      <div className="page detail">
        <Link to="/" className="back-link"><ChevronRight size={15} style={{ transform: 'rotate(180deg)' }} /> Systems</Link>
        <div className="state"><h4>No such system</h4><p>Nothing is grouped under “{name}”. It may have been stopped, or the name is misspelled.</p></div>
      </div>
    );
  }

  const accStyle = { ['--acc' as string]: `var(${system.accent})` } as React.CSSProperties;
  const df = data.df;
  const totalBytes = systemDiskBytes(df, system);
  let panel = 0;

  return (
    <div className="page detail" style={accStyle}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/">Systems</Link>
        <ChevronRight size={13} className="sep" aria-hidden="true" />
        <span className="here">{system.title}</span>
      </nav>

      <motion.header className="detail-head" {...(reduce ? {} : { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.3 } })}>
        <div className="detail-head-meta">
          <h1>
            <span className="acc-bar" />
            {system.title}
            <span className={`kind-badge kind-${system.kind}`}>{KIND_LABEL[system.kind]}</span>
          </h1>
          <div className="detail-head-row">
            <span className="dim" style={{ fontSize: 13.5 }}>
              {h.up}/{h.total} up · {ports.length} {ports.length === 1 ? 'port' : 'ports'} · {routers.length} {routers.length === 1 ? 'route' : 'routes'} · {system.volumes.length} {system.volumes.length === 1 ? 'volume' : 'volumes'}
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

        {/* Services — split by type, with a combining type + status filter bar */}
        <motion.section className="panel span-12" {...rise(panel++)}>
          <div className="panel-h">Services <span className="sub">{h.total}</span></div>
          <div className="panel-b">
            <div className="filter-bar svc-filter">
              <SlidersHorizontal size={15} className="filters-ico" aria-hidden="true" />
              <div className="filter-chips">
                {presentTypes.map((t) => {
                  const on = typeFilter.has(t);
                  const n = typeCounts.get(t) ?? 0;
                  return (
                    <button
                      key={t}
                      className={`chip ${on ? 'on' : ''} ${n === 0 && !on ? 'is-zero' : ''}`}
                      onClick={() => toggleType(t)}
                      aria-pressed={on}
                    >
                      <TypeIcon type={t} size={13} />
                      <span className="chip-l">{TYPE_LABEL[t]}</span>
                      <span className="n">{n}</span>
                    </button>
                  );
                })}
              </div>
              <span className="filter-div" aria-hidden="true" />
              <div className="filter-chips">
                {STATUSES.map((s) => {
                  const on = statusFilter.has(s);
                  const n = statusCounts[s];
                  return (
                    <button
                      key={s}
                      className={`chip ${on ? 'on' : ''} ${n === 0 && !on ? 'is-zero' : ''}`}
                      onClick={() => toggleStatus(s)}
                      aria-pressed={on}
                    >
                      <StatusIcon status={s} size={13} />
                      <span className="chip-l">{STATUS_LABEL[s]}</span>
                      <span className="n">{n}</span>
                    </button>
                  );
                })}
              </div>
              {activeFilters && (
                <button className="chip clear" onClick={clearAll}><X size={13} /> Clear</button>
              )}
            </div>

            {sections.length === 0 ? (
              <div className="svc-empty">
                <p>No services match these filters.</p>
                <button className="btn ghost sm" onClick={clearAll}>Clear filters</button>
              </div>
            ) : (
              <div className="type-sections">
                {sections.map((sec) => (
                  <section className="type-section" key={sec.type}>
                    <div className="type-head">
                      <span className="ico sm"><TypeIcon type={sec.type} size={15} /></span>
                      <span className="type-label">{sec.label}</span>
                      <span className="type-cnt">{sec.nodes.length}</span>
                    </div>
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
                          {sec.nodes.map((n) => (
                            <ServiceRow key={n.id} node={n} probed={n.url ? probed[n.url] : undefined} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </motion.section>

        {/* Data — this system's volumes and their sizes */}
        {system.volumes.length > 0 && (
          <motion.section className="panel span-12" {...rise(panel++)}>
            <div className="panel-h">
              Data <span className="sub">{fmtBytes(totalBytes)}{df ? '' : ' · sizes unavailable'}</span>
            </div>
            <div className="panel-b panel-tbl">
              <div className="tbl-wrap">
                <table className="tbl vol-tbl">
                  <thead>
                    <tr>
                      <th>Volume</th>
                      <th>Mounted at</th>
                      <th className="num">Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {system.volumes.map((v) => {
                      const size = volumeSize(df, v.name);
                      return (
                        <tr key={v.name}>
                          <td className="vol-name"><span className="ico sm"><HardDrive size={15} /></span><span className="mono">{v.name}</span></td>
                          <td className="mono dim">{v.destination || '—'}</td>
                          <td className="mono num">{df ? fmtBytes(size) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </motion.section>
        )}

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
