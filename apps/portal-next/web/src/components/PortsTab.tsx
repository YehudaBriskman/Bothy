import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { PortRow } from '../lib/discover';
import { ErrState } from './states';
import './Tables.css';

type Filter = 'all' | 'public' | 'loopback';
type SortKey = 'hostPort' | 'containerPort' | 'container' | 'group' | 'proto' | 'scope';

const COLS: [SortKey, string][] = [
  ['hostPort', 'Host'],
  ['containerPort', '→ Container'],
  ['container', 'Container'],
  ['group', 'Group'],
  ['proto', 'Proto'],
  ['scope', 'Scope'],
];

const SCOPES: [Filter, string][] = [
  ['all', 'All'],
  ['public', 'Exposed'],
  ['loopback', 'Loopback'],
];

// `query` is an optional external filter applied on top of the tab's own search
// (used by the embedded project-detail view). Omit it for the standalone page.
export function PortsTab({ ports, query: external = '' }: { ports: PortRow[]; query?: string }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'hostPort', dir: 1 });

  const counts = useMemo(() => ({
    all: ports.length,
    public: ports.filter((p) => p.scope === 'public').length,
    loopback: ports.filter((p) => p.scope === 'loopback').length,
  }), [ports]);

  const rows = useMemo(() => {
    const terms = [query, external].map((s) => s.toLowerCase().trim()).filter(Boolean);
    let r = ports.slice();
    if (filter !== 'all') r = r.filter((p) => p.scope === filter);
    for (const q of terms)
      r = r.filter((p) =>
        `${p.hostPort} ${p.containerPort} ${p.container} ${p.group} ${p.image} ${p.scope}`
          .toLowerCase()
          .includes(q),
      );
    const { key, dir } = sort;
    r.sort((a, b) => {
      const av = a[key] as string | number | undefined;
      const bv = b[key] as string | number | undefined;
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      return cmp * dir || a.hostPort - b.hostPort;
    });
    return r;
  }, [ports, query, external, filter, sort]);

  if (!ports.length) {
    return (
      <ErrState
        title="Container data unavailable"
        body="Ports come from Docker — Traefik doesn't know about them. The socket-proxy looks unreachable. Everything else on this page still works."
        onRetry={() => {}}
      />
    );
  }

  const setKey = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }));

  return (
    <div className="ports">
      <div className="tbl-filter">
        <div className="tbl-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            placeholder="Filter ports, containers, groups…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter ports"
          />
        </div>
        <div className="chips" role="group" aria-label="Scope">
          {SCOPES.map(([f, label]) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {label} <span className="n">{counts[f]}</span>
            </button>
          ))}
        </div>
        <span className="cnt">{rows.length} of {ports.length}</span>
      </div>

      <div className="tbl-wrap">
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
              <tr><td colSpan={COLS.length} className="tbl-empty">No ports match “{query}”.</td></tr>
            ) : rows.map((r, i) => {
              const shown = r.hostIp === '0.0.0.0' ? location.hostname : r.hostIp;
              return (
                <tr key={`${r.hostIp}:${r.hostPort}/${r.proto}-${i}`}>
                  <td className="mono">
                    {r.scope === 'public' ? (
                      <a href={`http://${shown}:${r.hostPort}`} target="_blank" rel="noopener noreferrer" title={`bound on ${r.hostIp}`}>
                        {shown}:{r.hostPort}
                      </a>
                    ) : (
                      <span title={`bound on ${r.hostIp}`}>
                        {shown}:{r.hostPort}
                      </span>
                    )}
                  </td>
                  <td className="mono">{r.containerPort}</td>
                  <td>{r.container}</td>
                  <td className="mono">{r.group}</td>
                  <td className="mono">{r.proto}</td>
                  <td>
                    <span className={`tag ${r.scope}`}>{r.scope === 'public' ? 'exposed' : 'loopback'}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
