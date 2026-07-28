import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { PortalNode, Router } from '../lib/discover';
import { ErrState } from './states';
import './Tables.css';

// The Routes tab is the escape hatch: it shows EVERY Traefik router, including
// the ones that never became a service card (portal-fallback, host processes,
// orphaned routes). A dangling route is exactly what the portal should shout
// about, so nothing is hidden here.

interface Row {
  router: Router;
  node?: PortalNode;
  provider: string;
  target: string;
  state: 'ok' | 'host' | 'no-container' | 'disabled';
}

export function RoutesTab({ routers, nodes }: { routers: Router[]; nodes: PortalNode[] }) {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<string>('all');

  const byRouter = useMemo(() => {
    const m = new Map<string, PortalNode>();
    for (const n of nodes) if (n.route) m.set(n.route.router, n);
    return m;
  }, [nodes]);

  const allRows = useMemo<Row[]>(() => {
    return [...routers]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => {
        const node = byRouter.get(r.name);
        const target = node?.route?.serverUrls?.join(', ') || node?.container?.name || '—';
        let state: Row['state'] = 'ok';
        if (node?.kind === 'orphan-route' && r.provider === 'file') state = 'host';
        else if (node?.kind === 'orphan-route') state = 'no-container';
        else if (r.status !== 'enabled') state = 'disabled';
        return { router: r, node, provider: r.provider || '—', target, state };
      });
  }, [routers, byRouter]);

  const providers = useMemo(() => {
    const s = new Set<string>();
    for (const r of routers) if (r.provider) s.add(r.provider);
    return ['all', ...[...s].sort()];
  }, [routers]);

  const rows = useMemo(() => {
    const q = query.toLowerCase().trim();
    return allRows.filter((row) => {
      if (provider !== 'all' && row.provider !== provider) return false;
      if (!q) return true;
      const r = row.router;
      return `${r.name} ${r.rule} ${r.provider} ${r.service} ${row.target}`.toLowerCase().includes(q);
    });
  }, [allRows, query, provider]);

  if (!routers.length) {
    return (
      <ErrState
        title="Traefik API unreachable"
        body="Check edge/dynamic/portal-api.yml is loaded: docker logs traefik"
        onRetry={() => {}}
      />
    );
  }

  const stateTag = (s: Row['state'], raw?: string) => {
    if (s === 'host') return <span className="tag warn">host process</span>;
    if (s === 'no-container') return <span className="tag bad">no container</span>;
    if (s === 'disabled') return <span className="tag bad">{raw || '?'}</span>;
    return <span className="tag ok">ok</span>;
  };

  return (
    <div className="routes">
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
              <button key={p} className={provider === p ? 'on' : ''} onClick={() => setProvider(p)}>
                {p === 'all' ? 'All' : p}
              </button>
            ))}
          </div>
        )}
        <span className="cnt">{rows.length} of {routers.length}</span>
      </div>

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Router</th>
              <th>Rule</th>
              <th>Provider</th>
              <th>Service</th>
              <th>Target</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="tbl-empty">No routers match “{query}”.</td></tr>
            ) : rows.map(({ router: r, target, state }) => (
              <tr key={r.name}>
                <td className="mono">{r.name.split('@')[0]}</td>
                <td className="mono rule" title={r.rule}>{r.rule}</td>
                <td className="mono">{r.provider || '—'}</td>
                <td className="mono">{r.service || '—'}</td>
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
