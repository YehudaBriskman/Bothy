// Per-service log view, backed by Loki (see lib/logs.ts for why Loki and not
// `docker logs`).
//
// Deliberately not a live tail. The portal already runs one 10s poll for the
// whole app; a second, per-page streaming connection would be the first thing on
// this box to hold an open socket, and "logs from the last N minutes, refresh
// when I ask" answers the actual question - what did this service just do -
// without that. Refresh is one click, and the range selector goes back a week.

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Search, AlertTriangle, ScrollText } from 'lucide-react';
import { fetchLogs, LOG_RANGES, LOG_LIMIT, type LogSource, type LogLine, type LogRangeKey } from '../lib/logs';
import './LogPanel.css';

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function LogPanel({ source, title }: { source: LogSource; title?: string }) {
  const [rangeKey, setRangeKey] = useState<LogRangeKey>('1h');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [lines, setLines] = useState<LogLine[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  const rangeSeconds = LOG_RANGES.find((r) => r.key === rangeKey)?.seconds ?? 3600;

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchLogs(source, { rangeSeconds, search: applied, signal: ac.signal })
      .then((res) => {
        if (ac.signal.aborted) return;
        setLines(res.lines);
        setTruncated(res.truncated);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        // A 404 here means the Loki route isn't deployed, which is a different
        // problem from "this service has no logs" - say which.
        setError(String(e).includes('404') ? 'log API not reachable' : 'could not read logs');
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [source.selector, source.filter, rangeSeconds, applied, nonce]);

  // Newest lines are at the bottom, so land the viewport there - scrolled to the
  // top, a log view shows the oldest thing that happened, which is never what
  // you opened it for.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && !loading) el.scrollTop = el.scrollHeight;
  }, [lines, loading]);

  const submit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    setApplied(search);
  }, [search]);

  return (
    <div className="logp">
      <div className="logp-bar">
        <span className="logp-src" title={source.selector}>
          <ScrollText size={14} aria-hidden="true" />
          {title || (source.kind === 'container' ? 'container logs' : 'process logs')}
        </span>

        <form className="logp-search" onSubmit={submit} role="search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={search}
            placeholder="contains…"
            aria-label="Filter log lines"
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>

        <label className="logp-range">
          <span className="sr-only">Time range</span>
          <select value={rangeKey} onChange={(e) => setRangeKey(e.target.value as LogRangeKey)}>
            {LOG_RANGES.map((r) => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
          </select>
        </label>

        <button type="button" className="logp-refresh" onClick={() => setNonce((n) => n + 1)} title="Refresh">
          <RefreshCw size={14} className={loading ? 'spin' : undefined} aria-hidden="true" />
          <span className="sr-only">Refresh logs</span>
        </button>
      </div>

      {truncated && (
        <div className="logp-note">
          <AlertTriangle size={13} aria-hidden="true" />
          Showing the newest {LOG_LIMIT} lines - narrow the range or filter to see the rest.
        </div>
      )}

      <div className="logp-body scroll-shade" ref={bodyRef} tabIndex={0} role="log" aria-label="Log output">
        {error ? (
          <div className="logp-empty">{error}</div>
        ) : loading && !lines.length ? (
          <div className="logp-empty">reading…</div>
        ) : !lines.length ? (
          <div className="logp-empty">
            Nothing logged in this window.
            {source.kind === 'host' && ' Host processes only appear here while something writes to the log file.'}
          </div>
        ) : (
          lines.map((l, i) => (
            <div className={`logp-line ${l.stream === 'stderr' ? 'is-err' : ''}`} key={`${l.ts}-${i}`}>
              <time dateTime={new Date(l.ts).toISOString()}>{fmtTime(l.ts)}</time>
              <span className="logp-text">{l.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
