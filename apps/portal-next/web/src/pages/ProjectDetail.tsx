import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronRight, HardDrive } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { usePortal, healthOf } from '../lib/data';
import { groupByType, systemsOf, volumeSize, systemDiskBytes, fmtBytes } from '../lib/systems';
import { TypeIcon } from '../lib/icons';
import { ServiceTable } from '../components/ServiceTable';
import { PortsTab } from '../components/PortsTab';
import { RoutesTab } from '../components/RoutesTab';
import { Tabs, TabPanel } from '../components/Tabs';
import './Detail.css';

const KIND_LABEL: Record<'project' | 'stack' | 'infra', string> = {
  project: 'Project',
  stack: 'Stack service',
  infra: 'Infra',
};

export function ProjectDetail() {
  const { name = '' } = useParams();
  const { data } = usePortal();
  const reduce = useReducedMotion();

  // Which half of the Reachability panel is showing. Not persisted: it is a
  // view of one page, not a fact about the box.
  const [reach, setReach] = useState<'routes' | 'ports'>('routes');

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

  const sections = useMemo(() => groupByType(nodes), [nodes]);

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
        {/* The Health panel is DELETED. It restated, in a 156px panel, the
            "N/M up · N ports · N routes · N volumes" line already printed 60px
            above it in the header — the same numbers, one bar and a row of
            tags. A rollup that duplicates its own page subtitle is not a
            rollup, it is an echo. The header line IS the rollup. */}

        {/* Services — split into sections by type. */}
        <motion.section className="panel span-12" {...rise(panel++)}>
          <div className="panel-h">Services <span className="sub">{h.total}</span></div>
          <div className="panel-b">
            {/* The type + status filter bar is DELETED. It offered up to ten
                chips to filter a table whose median length on this box is 2
                rows and whose longest is 6 — the controls were bigger than the
                data they controlled, and every chip carried a count that was
                already visible as a row. Type is a SECTION heading below and
                status is a column; both are readable without filtering. The
                Services page keeps its filter bar, where 27 rows justify it. */}
            {sections.length === 0 ? (
              // With no filters left, empty means the system really has nothing
              // in it — so there is no "clear filters" escape hatch to offer.
              <div className="svc-empty">
                <p>No services discovered in this system.</p>
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
                    {/* showGroup=false: every row on a system page would repeat
                        the same group the page is already titled with */}
                    <ServiceTable nodes={sec.nodes} showGroup={false} label={`${sec.label} services`} />
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
              <div className="tbl-wrap scroll-shade">
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

        {/* Reachability — routes and ports in ONE panel.
            They answer the same question ("how is this reached?") and were two
            stacked panels of identical shape, so the page asked you to scroll
            past one to discover whether the other existed. Same merge as the
            top-level Access page, same reasoning. */}
        {(routers.length > 0 || ports.length > 0) && (
          <motion.section className="panel span-12" {...rise(panel++)}>
            <div className="panel-h">
              Reachability <span className="sub">{routers.length + ports.length}</span>
            </div>
            <div className="panel-b panel-tbl">
              <Tabs
                label="How this system is reached"
                value={reach}
                onChange={(k) => setReach(k as 'routes' | 'ports')}
                tabs={[
                  ...(routers.length ? [{ key: 'routes', label: 'Routes', count: routers.length }] : []),
                  ...(ports.length ? [{ key: 'ports', label: 'Ports', count: ports.length }] : []),
                ]}
              />
              {/* compact: the panel header already scopes and counts these, so
                  the embedded tables drop their own search box and chips */}
              <TabPanel tabKey="routes" active={reach === 'routes' && routers.length > 0}>
                <RoutesTab routers={routers} nodes={nodes} compact />
              </TabPanel>
              <TabPanel tabKey="ports" active={reach === 'ports' && ports.length > 0}>
                <PortsTab ports={ports} query="" compact />
              </TabPanel>
            </div>
          </motion.section>
        )}
      </div>
    </div>
  );
}
