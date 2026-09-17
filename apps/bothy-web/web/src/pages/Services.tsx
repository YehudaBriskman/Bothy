import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import { usePortal } from '../lib/data';
import { panelize } from '../lib/panels';
import {
  pruneCollapsed, readCollapsed, setAllCollapsed, toggleCollapsed, writeCollapsed,
} from '../lib/collapse';
import { accentVar } from '../lib/accents';
import type { PortalNode, Status } from '../lib/discover';
import { systemLink } from '../lib/links';
import { ServiceTable } from '../components/ServiceTable';
import { StatusIcon } from '../lib/icons';
import { EmptyState } from '../components/states';
import './Services.css';

// The card view and the density toggle are GONE. A ServiceCard measured the
// same area as ~3 table rows while carrying strictly FEWER dimensions than the
// row did - no image, no uptime, no ports column - so the table dominated it
// outright: same cost, less information. Two controls that only ever chose
// between "worse" and "better" are two controls nobody should have to operate.
// Rows are now one height, chosen to be the dense one.
type KindFilter = 'all' | 'routed' | 'no-container' | 'unrouted' | 'host';

const STATUSES: Status[] = ['up', 'starting', 'down', 'stopped', 'unknown'];
const STATUS_LABEL: Record<Status, string> = { up: 'Up', starting: 'Starting', down: 'Down', stopped: 'Stopped', unknown: 'Unknown' };
// These MUST partition the node set. 'Orphan' and 'Host process' used to select
// the same 7 nodes under two names, so the four counts summed to 34 of 27 and
// "Orphan (7)" implied 7 broken routes when they were ordinary host processes.
// A docker route with no container is the broken case; an @file route is not.
const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'routed', label: 'Routed' },
  { value: 'host', label: 'Host process' },
  { value: 'no-container', label: 'No container' },
  { value: 'unrouted', label: 'Unrouted' },
];

export function Services() {
  const { data } = usePortal();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const reduced = useReducedMotion() ?? false;

  const [statusFilter, setStatusFilter] = useState<Set<Status>>(new Set());
  const [project, setProject] = useState('all');
  const [kind, setKind] = useState<KindFilter>('all');
  // Which groups you collapsed, remembered per browser - lib/collapse.ts owns
  // the rules and says why localStorage is the right and only home for it.
  //
  // A LIST, not a Set, because that is what is stored and what the pure helpers
  // take. There are a dozen panels on the busiest box this runs on, so the
  // lookup cost is not a consideration and one shape end to end is.
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);

  const setQ = (v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set('q', v); else next.delete('q');
    setParams(next, { replace: true });
  };

  const projectOptions = useMemo(
    // [slug, display name]. The VALUE stays the compose slug - it is the filter
    // key, and `?project=` in the URL must keep working - but the LABEL reads
    // like every other surface. A dropdown offering `auth` next to a table
    // saying "Identity · Keycloak" is the same one-name-per-system failure in
    // miniature.
    () => {
      const seen = new Map<string, string>();
      for (const n of data.nodes) if (!n.hidden) seen.set(n.group, n.groupTitle || n.group);
      return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    },
    [data.nodes],
  );

  // Every dimension COMBINES; each control also reports how many services it
  // would match. A facet count is computed against the OTHER active filters
  // (not its own), so the numbers stay honest as you narrow down.
  const { filtered, statusCounts, projectCounts, kindCounts, projectAll, kindAll, totalVisible } = useMemo(() => {
    const vis = data.nodes.filter((n) => !n.hidden);
    const needle = q.trim().toLowerCase();
    const mText = (n: PortalNode) =>
      !needle || `${n.name} ${n.host ?? ''} ${n.group} ${n.groupTitle} ${n.container?.image ?? ''}`.toLowerCase().includes(needle);
    const mProject = (n: PortalNode) => project === 'all' || n.group === project;
    const mStatus = (n: PortalNode) => statusFilter.size === 0 || statusFilter.has(n.status);
    const isHost = (n: PortalNode) => n.route?.provider === 'file';
    const mKind = (n: PortalNode, k: KindFilter) =>
      k === 'all' ? true
      : k === 'host' ? isHost(n)
      : k === 'no-container' ? n.kind === 'orphan-route' && !isHost(n)
      : n.kind === k;

    const filtered = vis.filter((n) => mStatus(n) && mProject(n) && mKind(n, kind) && mText(n));

    const statusCounts: Record<Status, number> = { up: 0, starting: 0, down: 0, stopped: 0, unknown: 0 };
    for (const n of vis) if (mProject(n) && mKind(n, kind) && mText(n)) statusCounts[n.status]++;

    const projectCounts = new Map<string, number>();
    for (const n of vis) if (mStatus(n) && mKind(n, kind) && mText(n))
      projectCounts.set(n.group, (projectCounts.get(n.group) ?? 0) + 1);

    const kindCounts: Record<string, number> = {};
    for (const { value } of KIND_OPTIONS)
      kindCounts[value] = vis.filter((n) => mStatus(n) && mProject(n) && mText(n) && mKind(n, value)).length;

    // "All" must obey the OTHER filters like every sibling option does. It used
    // to print the unfiltered total, so with Kind=Host active the select read
    // "All (27)" above options summing to 7.
    const projectAll = vis.filter((n) => mStatus(n) && mKind(n, kind) && mText(n)).length;
    const kindAll = vis.filter((n) => mStatus(n) && mProject(n) && mText(n)).length;

    return { filtered, statusCounts, projectCounts, kindCounts, projectAll, kindAll, totalVisible: vis.length };
  }, [data.nodes, q, statusFilter, project, kind]);

  // membership from the filtered set, display names from the full set
  const panels = useMemo(() => panelize(filtered, data.nodes), [filtered, data.nodes]);

  // EVERY group the box has, filters ignored. This is what stale stored keys are
  // pruned against, and it must not be `panels`: a filtered-out group is not a
  // deleted one, and pruning against what is on screen would forget your layout
  // the moment you typed into the search box. pruneCollapsed() also refuses to
  // prune against an empty list, so a failed poll cannot erase it either.
  const liveKeys = useMemo(
    () => panelize(data.nodes).map((p) => p.storeKey),
    [data.nodes],
  );

  useEffect(() => {
    setCollapsed((prev) => {
      const next = pruneCollapsed(prev, liveKeys);
      // Same length means nothing was dropped. Returning `prev` unchanged keeps
      // this effect from writing localStorage on every ten-second poll.
      return next.length === prev.length ? prev : next;
    });
  }, [liveKeys]);

  useEffect(() => { writeCollapsed(collapsed); }, [collapsed]);

  const toggleStatus = (s: Status) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  };
  const toggleCollapse = (key: string) => setCollapsed((prev) => toggleCollapsed(prev, key));

  const allCollapsed = panels.length > 0 && panels.every((p) => collapsed.includes(p.storeKey));
  // Acts on the VISIBLE panels only. "Collapse all" under an active filter means
  // the groups you are looking at; reaching past the filter to close groups that
  // are not on screen is a change you cannot see happen and cannot undo with the
  // same button.
  const toggleAll = () =>
    setCollapsed((prev) => setAllCollapsed(prev, panels.map((p) => p.storeKey), !allCollapsed));

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
        </div>
      </div>

      {/* Persistent filter bar - every control combines and reports its count. */}
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
            <option value="all">All ({projectAll})</option>
            {projectOptions.map(([slug, label]) => <option key={slug} value={slug}>{label} ({projectCounts.get(slug) ?? 0})</option>)}
          </select>
        </label>
        <label className="filter-select">
          <span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as KindFilter)}>
            <option value="all">All ({kindAll})</option>
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
        // Only offer "Clear filter" when there IS one - otherwise the empty
        // state invites you to clear nothing.
        <EmptyState
          message={activeFilters ? 'No services match these filters' : 'No services discovered'}
          onClear={activeFilters ? clearAll : undefined}
        />
      ) : (
        <div className="svc-groups">
            {panels.map((p, gi) => {
              const isCollapsed = collapsed.includes(p.storeKey);
              // Ties the header button to the region it opens, so a screen
              // reader reading "collapsed" has somewhere to go for what is
              // inside it. The id is built from the STABLE key for the same
              // reason the state is stored under it.
              const bodyId = `svc-group-body-${p.storeKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
              return (
                <section
                  className="svc-group"
                  key={p.key}
                  // Hashed from the STABLE key, not the display key. It was
                  // `p.key`, which meant setting `dev.portal.group` repainted
                  // this page's spines while the Overview - which already hashes
                  // from primaryIdentity() - kept the old colours, so one system
                  // was two different colours on two pages. Identical on a box
                  // with no such label, which is every box today.
                  style={{ ['--acc' as string]: `var(${accentVar(p.storeKey)})` } as React.CSSProperties}
                >
                  <div className="svc-group-head-row">
                    <button
                      className="svc-group-head"
                      onClick={() => toggleCollapse(p.storeKey)}
                      aria-expanded={!isCollapsed}
                      aria-controls={bodyId}
                    >
                      <ChevronDown size={16} className={`chev ${isCollapsed ? 'closed' : ''}`} />
                      <span className="svc-group-idx">{String(gi + 1).padStart(2, '0')}</span>
                      <span className="svc-group-title">{p.title}</span>
                      <span className="svc-group-sub">{p.sub}</span>
                      <span className="tail" />
                      <span className="cnt">{p.nodes.length}</span>
                    </button>
                    {/* the only path from Services to a system page - the head
                        itself is a collapse toggle, so the link sits beside it */}
                    {p.group && (
                      <Link
                        className="svc-group-open"
                        to={systemLink(p.group)}
                        title={`Open the ${p.title} system page`}
                      >
                        <ArrowRight size={15} />
                      </Link>
                    )}
                  </div>

                  {/* The id lives on a wrapper that is ALWAYS in the DOM, not on
                      the animated body. The body unmounts when the group is
                      collapsed, so putting it there leaves `aria-controls`
                      pointing at nothing in exactly the state where a screen
                      reader most needs the association to resolve. */}
                  <div id={bodyId}>
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
                          <ServiceTable nodes={p.nodes} compact label={`${p.title} services`} />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </section>
              );
            })}
        </div>
      )}
    </div>
  );
}
