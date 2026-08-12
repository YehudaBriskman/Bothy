// Per-service logs, read from Loki.
//
// WHY LOKI AND NOT `docker logs`: the /-/api/docker surface is exact-Path() on
// purpose (see edge/dynamic/portal-api.yml) because the socket-proxy gates by
// endpoint FAMILY — any pattern loose enough to match /containers/{id}/logs also
// matches /containers/{id}/json, which carries every container's Env. Loki takes
// the container name as a query PARAMETER, so it needs no path pattern and the
// boundary stays intact. It also keeps logs after a container has stopped, which
// is the case you most want them in.
//
// Host processes are covered by the same store: promtail's host-processes job
// scrapes ~/.local/state/devbox-logs/*.log and labels each file host_service=…,
// so a `just dev` harness queries identically to a container.

export interface LogSource {
  kind: 'container' | 'host';
  selector: string; // a LogQL stream selector, e.g. {container="grafana"}
  filter?: string | null; // narrows one shared stream to one service's lines
}

export interface LogLine {
  ts: number; // epoch ms
  text: string;
  stream?: string; // stdout | stderr, when the source records it
}

export interface LogQueryResult {
  lines: LogLine[];
  truncated: boolean;
}

export const LOG_RANGES = [
  { key: '15m', label: '15 min', seconds: 900 },
  { key: '1h', label: '1 hour', seconds: 3600 },
  { key: '6h', label: '6 hours', seconds: 21600 },
  { key: '24h', label: '24 hours', seconds: 86400 },
  { key: '7d', label: '7 days', seconds: 604800 },
] as const;

export type LogRangeKey = (typeof LOG_RANGES)[number]['key'];

// Loki's own ceiling is high, but the browser has to render every line — and a
// service that logs per-request will happily return 100k of them.
export const LOG_LIMIT = 2000;

// LogQL line filters are matched literally with |=, so the only thing that has
// to be escaped is the quoting of the string itself.
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function buildQuery(source: LogSource, search?: string): string {
  let q = source.selector;
  if (source.filter) q += ` |= ${quote(source.filter)}`;
  if (search?.trim()) q += ` |= ${quote(search.trim())}`;
  return q;
}

interface LokiStream {
  stream?: Record<string, string>;
  values?: [string, string][]; // [ns timestamp, line]
}

export async function fetchLogs(
  source: LogSource,
  opts: { rangeSeconds: number; search?: string; signal?: AbortSignal },
): Promise<LogQueryResult> {
  const end = Date.now() * 1e6; // Loki wants nanoseconds
  const start = end - opts.rangeSeconds * 1e9;

  const params = new URLSearchParams({
    query: buildQuery(source, opts.search),
    start: String(start),
    end: String(end),
    limit: String(LOG_LIMIT),
    direction: 'backward', // newest first, so a limit truncates the OLDEST
  });

  const r = await fetch(`/-/api/loki/query_range?${params}`, {
    signal: opts.signal,
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`loki ${r.status}`);
  const body = (await r.json()) as { data?: { result?: LokiStream[] } };

  const lines: LogLine[] = [];
  for (const s of body.data?.result ?? []) {
    for (const [ns, text] of s.values ?? []) {
      lines.push({ ts: Number(ns) / 1e6, text, stream: s.stream?.stream });
    }
  }
  // Loki returns one array per stream (stdout and stderr are separate streams),
  // so they have to be merged back into one chronological view — otherwise an
  // error and the line that caused it appear in different places.
  lines.sort((a, b) => a.ts - b.ts);

  return { lines, truncated: lines.length >= LOG_LIMIT };
}
