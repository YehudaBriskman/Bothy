import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { ChevronDown, LayoutGrid, Rows3, SlidersHorizontal, X } from 'lucide-react';
import { usePortal } from '../lib/data';
import { panelize } from '../lib/panels';
import { accentVar } from '../lib/accents';
import { useProbe } from '../lib/useProbe';
import type { PortalNode, Status } from '../lib/discover';
import { ServiceCard } from '../components/ServiceCard';
import { ServiceRow } from '../components/ServiceRow';
import { StatusIcon } from '../lib/icons';
import { EmptyState } from '../components/states';
import './Services.css';

type View = 'cards' | 'table';
type Density = 'comfortable' | 'compact';
type KindFilter = 'all' | 'routed' | 'orphan-route' | 'unrouted' | 'host';

const STATUSES: Status[] = ['up', 'starting', 'down', 'unknown'];
const STATUS_LABEL: Record<Status, string> = { up: 'Up', starting: 'Starting', down: 'Down', unknown: 'Unknown' };
const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'routed', label: 'Routed' },
  { value: 'orphan-route', label: 'Orphan' },
  { value: 'unrouted', label: 'Unrouted' },
  { value: 'host', label: 'Host process' },
];

function useLocalState<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { return (localStorage.getItem(key) as T) || initial; } catch { return initial; }
  });
  const set = (nv: T) => { try { localStorage.setItem(key, nv); } catch { /* ignore */ } setV(nv); };
  return [v, set];
}

export function Services() {
  const { data } = usePortal();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const reduced = useReducedMotion() ?? false;

  const [view, setView] = useLocalState<View>('svc-view', 'cards');
  const [density, setDensity] = useLocalState<Density>('svc-density', 'comfortable');
  const [statusFilter, setStatusFilter] = useState<Set<Status>>(new Set());
  const [project, setProject] = useState('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const compact = density === 'compact';

  const setQ = (v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set('q', v); else next.delete('q');
    setParams(next, { replace: true });
  };

  const projectOptions = useMemo(
    () => [...new Set(data.nodes.filter((n) => !n.hidden).map((n) => n.group))].sort(),
    [data.nodes],
  );

  // Every dimension COMBINES; each control also reports how many services it
  // would match. A facet count is computed against the OTHER active filters
  // (not its own), so the numbers stay honest as you narrow down.
  const { filtered, statusCounts, projectCounts, kindCounts, totalVisible } = useMemo(() => {
    const vis = data.nodes.filter((n) => !n.hidden);
    const needle = q.trim().toLowerCase();
    const mText = (n: PortalNode) =>
      !needle || `${n.name} ${n.host ?? ''} ${n.group} ${n.container?.image ?? ''}`.toLowerCase().includes(needle);
    const mProject = (n: PortalNode) => project === 'all' || n.group === project;
    const mStatus = (n: PortalNode) => statusFilter.size === 0 || statusFilter.has(n.status);
    const mKind = (n: PortalNode, k: KindFilter) =>
      k === 'all' ? true : k === 'host' ? n.route?.provider === 'file' : n.kind === k;

    const filtered = vis.filter((n) => mStatus(n) && mProject(n) && mKind(n, kind) && mText(n));

    const statusCounts: Record<Status, number> = { up: 0, starting: 0, down: 0, unknown: 0 };
    for (const n of vis) if (mProject(n) && mKind(n, kind) && mText(n)) statusCounts[n.status]++;

    const projectCounts = new Map<string, number>();
    for (const n of vis) if (mStatus(n) && mKind(n, kind) && mText(n))
      projectCounts.set(n.group, (projectCounts.get(n.group) ?? 0) + 1);

    const kindCounts: Record<string, number> = {};
    for (const { value } of KIND_OPTIONS)
      kindCounts[value] = vis.filter((n) => mStatus(n) && mProject(n) && mText(n) && mKind(n, value)).length;

    return { filtered, statusCounts, projectCounts, kindCounts, totalVisible: vis.length };
  }, [data.nodes, q, statusFilter, project, kind]);

  const panels = useMemo(() => panelize(filtered), [filtered]);

  const orphanUrls = useMemo(
    () => filtered.filter((n) => n.kind === 'orphan-route' && n.url).map((n) => n.url as string),
    [filtered],
  );
  const probed = useProbe(orphanUrls);

  const toggleStatus = (s: Status) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  };
  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const allCollapsed = panels.length > 0 && panels.every((p) => collapsed.has(p.key));
  const toggleAll = () =>
    setCollapsed(allCollapsed ? new Set() : new Set(panels.map((p) => p.key)));

  const activeFilters = statusFilter.size > 0 || project !== 'all' || kind !== 'all' || !!q;
  const clearAll = () => { setStatusFilter(new Set()); setProject('all'); setKind('all'); setQ(''); };

  return (
    <div className="page services-page">
      <div className="page-head">
        <div>
          <h1>Services</h1>
          <p className="page-sub">
            <b className="tnum">{filtered.length}</b> of {totalVisible} · grouped by project
          </p>
        </div>
        <div className="view-controls">
          {panels.length > 0 && (
            <button className="btn ghost sm" onClick={toggleAll}>
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          )}
          <div className="seg-toggle" role="group" aria-label="View">
            <button className={view === 'cards' ? 'on' : ''} onClick={() => setView('cards')} title="Cards" aria-pressed={view === 'cards'}><LayoutGrid size={16} /></button>
            <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')} title="Table" aria-pressed={view === 'table'}><Rows3 size={16} /></button>
          </div>
          <div className="seg-toggle" role="group" aria-label="Density">
            <button className={density === 'comfortable' ? 'on' : ''} onClick={() => setDensity('comfortable')} aria-pressed={density === 'comfortable'}>Comfortable</button>
            <button className={density === 'compact' ? 'on' : ''} onClick={() => setDensity('compact')} aria-pressed={density === 'compact'}>Compact</button>
          </div>
        </div>
      </div>

      {/* Persistent filter bar — every control combines and reports its count. */}
      <div className="filter-bar">
        <SlidersHorizontal size={15} className="filters-ico" aria-hidden="true" />
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
        <label className="filter-select">
          <span>Project</span>
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="all">All ({totalVisible})</option>
            {projectOptions.map((p) => <option key={p} value={p}>{p} ({projectCounts.get(p) ?? 0})</option>)}
          </select>
        </label>
        <label className="filter-select">
          <span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as KindFilter)}>
            <option value="all">All</option>
            {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label} ({kindCounts[k.value] ?? 0})</option>)}
          </select>
        </label>
        <input
          className="filter-search"
          type="search"
          placeholder="Filter by name, host, image…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Filter services"
        />
        {activeFilters && (
          <button className="chip clear" onClick={clearAll}><X size={13} /> Clear</button>
        )}
      </div>

      {!panels.length ? (
        <EmptyState
          message={activeFilters ? 'No services match these filters' : 'No services discovered'}
          onClear={clearAll}
        />
      ) : (
        <LayoutGroup>
          <div className="svc-groups">
            {panels.map((p, gi) => {
              const isCollapsed = collapsed.has(p.key);
              return (
                <section
                  className="svc-group"
                  key={p.key}
                  style={{ ['--acc' as string]: `var(${accentVar(p.key)})` } as React.CSSProperties}
                >
                  <button className="svc-group-head" onClick={() => toggleCollapse(p.key)} aria-expanded={!isCollapsed}>
                    <ChevronDown size={16} className={`chev ${isCollapsed ? 'closed' : ''}`} />
                    <span className="svc-group-idx">{String(gi + 1).padStart(2, '0')}</span>
                    <span className="svc-group-title">{p.title}</span>
                    <span className="svc-group-sub">{p.sub}</span>
                    <span className="tail" />
                    <span className="cnt">{p.nodes.length}</span>
                  </button>

                  <AnimatePresence initial={false}>
                    {!isCollapsed && (
                      <motion.div
                        className="svc-group-body"
                        key="body"
                        initial={reduced ? false : { height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                        transition={{ duration: 0.24, ease: [0.2, 0.7, 0.2, 1] }}
                        style={{ overflow: 'hidden' }}
                      >
                        {view === 'cards' ? (
                          <motion.div className={`svc-grid ${compact ? 'compact' : ''}`} layout={!reduced}>
                            <AnimatePresence mode="popLayout">
                              {p.nodes.map((n) => (
                                <ServiceCard
                                  key={n.id}
                                  node={n}
                                  compact={compact}
                                  reduced={reduced}
                                  probed={n.url ? probed[n.url] : undefined}
                                />
                              ))}
                            </AnimatePresence>
                          </motion.div>
                        ) : (
                          <div className="tbl-wrap">
                            <table className={`tbl svc-tbl ${compact ? 'compact' : ''}`}>
                              <thead>
                                <tr>
                                  <th>Service</th><th>Status</th><th>Group</th><th>Kind</th><th>Ports</th><th>Image</th><th aria-label="Open" />
                                </tr>
                              </thead>
                              <tbody>
                                {p.nodes.map((n) => (
                                  <ServiceRow key={n.id} node={n} probed={n.url ? probed[n.url] : undefined} />
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </section>
              );
            })}
          </div>
        </LayoutGroup>
      )}
    </div>
  );
}
