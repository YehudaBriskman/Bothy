import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { PortalNode, Router } from '../lib/discover';
import { usePortal } from '../lib/data';
import { ErrState } from './states';
import './Tables.css';

// The Routes tab is the escape hatch: it shows EVERY Traefik router, including
// the ones that never became a service card (portal-fallback, host processes,
// orphaned routes). A dangling route is exactly what the portal should shout
// about, so nothing is hidden here.

type SortKey = 'name' | 'rule' | 'provider' | 'service' | 'target' | 'state';

interface Row {
  router: Router;
  node?: PortalNode;
  name: string; // the DISPLAYED name (no @provider suffix)
  provider: string;
  service: string;
  target: string;
  state: 'ok' | 'unknown' | 'no-container' | 'disabled';
}

const COLS: [SortKey, string][] = [
  ['name', 'Router'],
  ['rule', 'Rule'],
  ['provider', 'Provider'],
  ['service', 'Service'],
  ['target', 'Target'],
  ['state', 'State'],
];

export function RoutesTab({
  routers,
  nodes,
  compact = false,
}: {
  routers: Router[];
  nodes: PortalNode[];
  compact?: boolean;
}) {
  const { refresh } = usePortal();
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<string>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });

  const byRouter = useMemo(() => {
    const m = new Map<string, PortalNode>();
    for (const n of nodes) if (n.route) m.set(n.route.router, n);
    return m;
  }, [nodes]);

  const allRows = useMemo<Row[]>(
    () =>
      routers.map((r) => {
        const node = byRouter.get(r.name);
        const target = node?.route?.serverUrls?.join(', ') || node?.container?.name || '—';
        // State is a STATE. "host process" is a kind, and putting it in this
        // column meant a dead Tals route could never read as anything but a
        // neutral badge. An @file route has no container to ask, so the honest
        // state is 'unknown'.
        let state: Row['state'] = 'ok';
        if (r.status && r.status !== 'enabled') state = 'disabled';
        else if (node?.kind === 'orphan-route' && r.provider === 'file') state = 'unknown';
        else if (node?.kind === 'orphan-route') state = 'no-container';
        return {
          router: r,
          node,
          name: String(r.name).split('@')[0],
          provider: r.provider || '—',
          service: r.service || '—',
          target,
          state,
        };
      }),
    [routers, byRouter],
  );

  // Provider chips report their counts, like every other facet in the app.
  const providers = useMemo(() => {
    const counts = new Map<string, number>();
    const q = query.toLowerCase().trim();
    for (const row of allRows) {
      if (q && !`${row.name} ${row.router.rule} ${row.provider} ${row.service} ${row.target}`.toLowerCase().includes(q)) continue;
      counts.set(row.provider, (counts.get(row.provider) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    return [
      { key: 'all', label: 'All', n: total },
      ...[...counts.keys()].sort().map((p) => ({ key: p, label: p, n: counts.get(p) ?? 0 })),
    ];
  }, [allRows, query]);

  const rows = useMemo(() => {
    const q = query.toLowerCase().trim();
    const filtered = allRows.filter((row) => {
      if (provider !== 'all' && row.provider !== provider) return false;
      if (!q) return true;
      return `${row.name} ${row.router.rule} ${row.provider} ${row.service} ${row.target}`
        .toLowerCase()
        .includes(q);
    });
    // Sort on what is RENDERED. Sorting on router.name (which carries the
    // @docker/@file suffix) while the cell shows the bare name produced a
    // visibly wrong order: cvops-s3, cvops-tilt, cvops.
    const { key, dir } = sort;
    const val = (r: Row) => (key === 'rule' ? r.router.rule || '' : String(r[key as keyof Row] ?? ''));
    return filtered.sort(
      (a, b) => val(a).localeCompare(val(b)) * dir || a.name.localeCompare(b.name),
    );
  }, [allRows, query, provider, sort]);

  if (!routers.length) {
    return (
      <ErrState
        title="Traefik API unreachable"
        body="Check edge/dynamic/portal-api.yml is loaded: docker logs traefik"
        onRetry={refresh}
      />
    );
  }

  const setKey = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }));

  const stateTag = (s: Row['state'], raw?: string) => {
    if (s === 'unknown')
      return <span className="tag" title="Host process — no container to ask. Open it to see whether it is running.">unknown</span>;
    if (s === 'no-container') return <span className="tag bad">no container</span>;
    if (s === 'disabled') return <span className="tag bad">{raw || '?'}</span>;
    return <span className="tag ok">ok</span>;
  };

  const activeFilter = provider !== 'all' || !!query.trim();
  const clear = () => { setProvider('all'); setQuery(''); };

  return (
    <div className="routes">
      {!compact && (
        <div className="tbl-filter">
          <div className="tbl-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              placeholder="Filter routers, rules, targets…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter routes"
            />
          </div>
          {providers.length > 2 && (
            <div className="chips" role="group" aria-label="Provider">
              {providers.map((p) => (
                <button
                  key={p.key}
                  className={provider === p.key ? 'on' : ''}
                  onClick={() => setProvider(p.key)}
                  aria-pressed={provider === p.key}
                >
                  {p.label} <span className="n">{p.n}</span>
                </button>
              ))}
            </div>
          )}
          <span className="cnt">{rows.length} of {routers.length}</span>
        </div>
      )}

      <div className="tbl-wrap" tabIndex={0} role="region" aria-label="Traefik routers">
        <table className="tbl">
          <thead>
            <tr>
              {COLS.map(([k, label]) => (
                <th
                  key={k}
                  onClick={() => setKey(k)}
                  aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
                  className={`sortable ${sort.key === k ? 'sorted' : ''}`}
                >
                  {label}
                  <span className="sort-caret">{sort.key === k ? (sort.dir === 1 ? '↑' : '↓') : ''}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={COLS.length} className="tbl-empty">
                  No routers match {[provider !== 'all' ? `provider “${provider}”` : '', query.trim() ? `“${query.trim()}”` : ''].filter(Boolean).join(' + ') || 'these filters'}.
                  {activeFilter && <button type="button" className="btn ghost sm tbl-empty-clear" onClick={clear}>Clear filters</button>}
                </td>
              </tr>
            ) : rows.map(({ router: r, name, provider: prov, service, target, state }) => (
              <tr key={r.name}>
                <td className="mono">{name}</td>
                <td className="mono rule" title={r.rule}>{r.rule}</td>
                <td className="mono">{prov}</td>
                <td className="mono">{service}</td>
                <td className="mono">{target}</td>
                <td>{stateTag(state, r.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
