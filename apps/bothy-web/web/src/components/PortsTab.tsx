import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { PortRow } from '../lib/discover';
import { usePortal } from '../lib/data';
import { ErrState, EmptyState } from './states';
import './Tables.css';

type Filter = 'all' | 'public' | 'loopback';
type SortKey = 'hostPort' | 'containerPort' | 'container' | 'group' | 'proto' | 'scope';

// Column names say what the value IS. "Host" read as a hostname when it is a
// bind address; "Container" appeared twice meaning two different things.
const COLS: [SortKey, string][] = [
  ['hostPort', 'Bind'],
  ['containerPort', 'Container port'],
  ['container', 'Container name'],
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
// `compact` drops the filter bar and the Group column for embedded panels, whose
// own header already scopes and counts the rows.
export function PortsTab({
  ports,
  query: external = '',
  compact = false,
}: {
  ports: PortRow[];
  query?: string;
  compact?: boolean;
}) {
  const { data, refresh } = usePortal();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'hostPort', dir: 1 });

  const cols = useMemo(() => COLS.filter(([k]) => !(compact && k === 'group')), [compact]);

  // Scope counts honour the text query, like every other facet in the app.
  // Static counts told you "Exposed 9" while the table showed 5 filtered rows.
  const counts = useMemo(() => {
    const terms = [query, external].map((s) => s.toLowerCase().trim()).filter(Boolean);
    const matchText = (p: PortRow) =>
      terms.every((q) =>
        `${p.hostPort} ${p.containerPort} ${p.container} ${p.group} ${p.groupTitle} ${p.image} ${p.scope}`
          .toLowerCase()
          .includes(q),
      );
    const base = ports.filter(matchText);
    return {
      all: base.length,
      public: base.filter((p) => p.scope === 'public').length,
      loopback: base.filter((p) => p.scope === 'loopback').length,
    };
  }, [ports, query, external]);

  const rows = useMemo(() => {
    const terms = [query, external].map((s) => s.toLowerCase().trim()).filter(Boolean);
    let r = ports.slice();
    if (filter !== 'all') r = r.filter((p) => p.scope === filter);
    for (const q of terms)
      r = r.filter((p) =>
        `${p.hostPort} ${p.containerPort} ${p.container} ${p.group} ${p.groupTitle} ${p.image} ${p.scope}`
          .toLowerCase()
          .includes(q),
      );
    const { key, dir } = sort;
    r.sort((a, b) => {
      // Sort the Group column by what it DISPLAYS. Ordering by the hidden
      // compose slug puts `auth` before `edge` while the screen reads
      // "Identity · Keycloak" after "Edge · Traefik" - a sort that looks broken
      // because the user cannot see the key it used.
      const k = key === 'group' ? 'groupTitle' : key;
      const av = a[k] as string | number | undefined;
      const bv = b[k] as string | number | undefined;
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      return cmp * dir || a.hostPort - b.hostPort;
    });
    return r;
  }, [ports, query, external, filter, sort]);

  // Zero ports is the DESIRED state on this box - the house rule is "give it a
  // name, not a port". Only Docker actually being unreachable is an error, and
  // the loader already records that.
  const dockerDown = data.errors.some((e) => e.src.startsWith('docker'));
  if (!ports.length) {
    return dockerDown ? (
      <ErrState
        title="Container data unavailable"
        body="Ports come from Docker - Traefik doesn't know about them. The socket-proxy looks unreachable. Everything else on this page still works."
        onRetry={refresh}
      />
    ) : (
      <EmptyState
        message="No published ports"
        hint="Nothing here binds a host port - services are reached by name through the edge."
      />
    );
  }

  const setKey = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }));
  const activeFilter = filter !== 'all' || !!query.trim();
  const clear = () => { setFilter('all'); setQuery(''); };

  return (
    <div className="ports">
      {!compact && (
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
              <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)} aria-pressed={filter === f}>
                {label} <span className="n">{counts[f]}</span>
              </button>
            ))}
          </div>
          <span className="cnt">{rows.length} of {ports.length}</span>
        </div>
      )}

      <div className="tbl-wrap scroll-shade" tabIndex={0} role="region" aria-label="Published ports">
        <table className="tbl">
          <thead>
            <tr>
              {cols.map(([k, label]) => (
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
                <td colSpan={cols.length} className="tbl-empty">
                  {/* name every active filter, not just the text one */}
                  No ports match {[filter !== 'all' ? `scope “${filter === 'public' ? 'exposed' : 'loopback'}”` : '', query.trim() ? `“${query.trim()}”` : ''].filter(Boolean).join(' + ') || 'these filters'}.
                  {activeFilter && <button type="button" className="btn ghost sm tbl-empty-clear" onClick={clear}>Clear filters</button>}
                </td>
              </tr>
            ) : rows.map((r, i) => {
              // A 0.0.0.0 bind is reachable at whatever name you opened the
              // portal on, which is the address you'd actually paste. The real
              // bind stays in the title, and the Scope tag says "exposed".
              const shown = r.hostIp === '0.0.0.0' ? location.hostname : r.hostIp;
              return (
                <tr key={`${r.hostIp}:${r.hostPort}/${r.proto}-${i}`}>
                  <td className="mono">
                    {r.scope === 'public' ? (
                      <a href={`http://${shown}:${r.hostPort}`} target="_blank" rel="noopener noreferrer" title={`bound on ${r.hostIp} (all interfaces)`}>
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
                  {!compact && <td>{r.groupTitle}</td>}
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
