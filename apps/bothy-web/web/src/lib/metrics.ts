// Time series, from Prometheus.
//
// This is the portal's FIRST real time series. Everything before it
// (`data.history`, the hero sparkline) was a ring buffer built in the tab and
// lost on reload - honest, but it could never answer "was the box busy an hour
// ago", because an hour ago the tab wasn't open.
//
// The route is same-origin under /-/api/prom/*, exactly like /-/api/loki/*, and
// it is GENERATED, not committed: Prometheus grew basic auth when the SSO was
// parked, so the edge injects the credential and the browser never holds one.
// See scripts/gen-bothy-prom-route.sh and edge/dynamic/bothy-prom.example.yml.
//
// ── THE TRAP THIS FILE EXISTS TO HANDLE ─────────────────────────────────────
// The portal owns a catch-all route (PathPrefix(`/`) at priority 1). So on a box
// where nobody has run `just bothy-prom-route`, /-/api/prom/query_range does
// NOT 404 - it falls through to nginx and returns **200 with the SPA's
// index.html**. A naive `if (!r.ok) throw` therefore sees success and hands
// `<!doctype html>` to JSON.parse. Every response is checked for a JSON
// content-type AND for Prometheus's own `status: "success"` envelope before it
// is believed; anything else is reported as "not configured", which is a
// supported state (the graphs say so and the rest of the page is unaffected).

import { useEffect, useRef, useState } from 'react';

export interface Sample {
  t: number; // epoch seconds
  v: number;
}

export interface Series {
  key: string;
  label: string;
  points: Sample[];
}

/** Why a range query returned nothing useful. `off` is not an error. */
export type MetricsState = 'loading' | 'ok' | 'off' | 'error';

export const RANGES = [
  { key: '15m', label: '15m', seconds: 900, step: 15 },
  { key: '1h', label: '1h', seconds: 3600, step: 30 },
  { key: '6h', label: '6h', seconds: 21600, step: 120 },
  { key: '24h', label: '24h', seconds: 86400, step: 600 },
] as const;

export type RangeKey = (typeof RANGES)[number]['key'];
export const rangeOf = (k: RangeKey) => RANGES.find((r) => r.key === k) ?? RANGES[1];

// Prometheus caps a range query at 11,000 points per series. 24h/600s is 144, so
// these presets are nowhere near it - but the guard stays because a future
// preset with a small step is exactly the kind of change that looks harmless.
const MAX_POINTS = 11_000;

class NotConfigured extends Error {}

interface PromMatrix {
  status?: string;
  data?: { result?: { metric?: Record<string, string>; values?: [number, string][] }[] };
  error?: string;
}

/**
 * One range query → one Series per returned label set.
 *
 * `label` picks the display name out of the metric's labels; the first label
 * that exists wins, falling back to the query itself so a series is never
 * nameless.
 */
export async function queryRange(
  query: string,
  opts: { seconds: number; step: number; labelKeys?: string[]; signal?: AbortSignal },
): Promise<Series[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - opts.seconds;
  const step = Math.max(opts.step, Math.ceil(opts.seconds / MAX_POINTS));

  const params = new URLSearchParams({
    query,
    start: String(start),
    end: String(end),
    step: String(step),
  });

  const r = await fetch(`/-/api/prom/query_range?${params}`, {
    signal: opts.signal,
    cache: 'no-store',
  });

  // See the header: a MISSING route reaches nginx and 200s with the SPA shell,
  // so the content-type is the only thing that distinguishes "no metrics route
  // on this box" from "here are your metrics".
  const ct = r.headers.get('content-type') ?? '';
  if (!ct.includes('json')) throw new NotConfigured('no metrics route');
  if (!r.ok) throw new Error(`prometheus ${r.status}`);

  const body = (await r.json()) as PromMatrix;
  if (body.status !== 'success') throw new Error(body.error ?? 'prometheus rejected the query');

  return (body.data?.result ?? []).map((s, i) => {
    const m = s.metric ?? {};
    const label = opts.labelKeys?.map((k) => m[k]).find(Boolean) ?? m.name ?? m.device ?? `series ${i + 1}`;
    return {
      key: `${label}-${i}`,
      label,
      // Prometheus sends values as strings; NaN shows up as the literal "NaN"
      // for a gap in the data, and plotting it as 0 draws a cliff that never
      // happened. Gaps are dropped, so the line simply has fewer points.
      points: (s.values ?? [])
        .map(([t, v]) => ({ t, v: Number(v) }))
        .filter((p) => Number.isFinite(p.v)),
    };
  });
}

export interface MetricSpec {
  /** Stable id - also the chart-N colour slot, assigned in array order. */
  key: string;
  query: string;
  /** Which metric labels to read a series name from, in preference order. */
  labelKeys?: string[];
  /** Display name when the query returns exactly one series. */
  label?: string;
}

export interface MetricsResult {
  series: Series[];
  state: MetricsState;
  /** Human-readable reason when state is 'error'. */
  reason: string | null;
}

/**
 * Poll one or more range queries. Re-queries on range change and every
 * `refreshMs`, pauses while the tab is hidden (this page lives in a background
 * tab for days), and - like usePortalData - NEVER clears the last good series on
 * a failure, because a stale graph beats an empty one.
 */
export function useMetrics(
  specs: MetricSpec[],
  rangeKey: RangeKey,
  refreshMs = 30_000,
): MetricsResult {
  const [result, setResult] = useState<MetricsResult>({ series: [], state: 'loading', reason: null });
  // The spec array is rebuilt on every render by every caller that writes it
  // inline, so depending on it directly would re-fetch on every render. The
  // queries are what actually matter.
  const sig = specs.map((s) => `${s.key}\0${s.query}`).join('');
  const specsRef = useRef(specs);
  specsRef.current = specs;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const ac = new AbortController();
    const { seconds, step } = rangeOf(rangeKey);

    const run = async () => {
      try {
        const batches = await Promise.all(
          specsRef.current.map((s) =>
            queryRange(s.query, { seconds, step, labelKeys: s.labelKeys, signal: ac.signal }).then(
              (out) =>
                // A single-series query gets the spec's own label; a multi-series
                // one (topk by container) keeps the per-series label.
                out.length === 1 && s.label
                  ? [{ ...out[0], key: s.key, label: s.label }]
                  : out.map((o) => ({ ...o, key: `${s.key}:${o.key}` })),
            ),
          ),
        );
        if (cancelled) return;
        setResult({ series: batches.flat(), state: 'ok', reason: null });
      } catch (e) {
        if (cancelled || (e instanceof DOMException && e.name === 'AbortError')) return;
        setResult((prev) => ({
          series: prev.series,
          state: e instanceof NotConfigured ? 'off' : 'error',
          reason: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        if (!cancelled) {
          clearTimeout(timer);
          if (!document.hidden) timer = setTimeout(run, refreshMs);
        }
      }
    };

    const onVisible = () => { if (!document.hidden) run(); };
    document.addEventListener('visibilitychange', onVisible);
    run();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      ac.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sig, rangeKey, refreshMs]);

  return result;
}

// ── the queries ──────────────────────────────────────────────────────────────
// Kept here rather than inline in the page so they can be read, corrected and
// tested as a set. Every one of them was run against this box's Prometheus
// before it was written down.
//
// The rate window is 2m, not the step: a 15s step with a 15s window has at most
// one sample per window and produces a sawtooth. 2m is ~4 scrape intervals.

/** Host CPU that is NOT idle, as a percentage of all cores. */
export const Q_CPU = '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[2m])) * 100)';

/** Host memory in use, as a percentage - MemAvailable, not "free". */
export const Q_MEM =
  '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)';

// Ethernet throughput, bytes/sec. `device` is filtered down to real NICs: on
// this box that is eth0, and without the filter the sum double-counts every
// docker bridge and veth pair, which on a 23-container box roughly triples it.
const REAL_NIC = 'device!~"lo|veth.*|docker[0-9]*|br-.*|tailscale.*|virbr.*"';
export const Q_NET_RX = `sum(rate(node_network_receive_bytes_total{${REAL_NIC}}[2m]))`;
export const Q_NET_TX = `sum(rate(node_network_transmit_bytes_total{${REAL_NIC}}[2m]))`;

/** Load average, 1 minute. */
export const Q_LOAD = 'node_load1';

// Host filesystem, not docker volumes. The Data & disk panel answers "what is
// using space"; this answers "is the box about to run out", which is the
// question a glance is actually asking and which volume totals cannot answer -
// 2.9 GB of volumes says nothing about whether the disk is full.
const ROOT_FS = 'mountpoint="/",fstype!~"tmpfs|overlay|squashfs"';
export const Q_DISK_PCT =
  `100 * (1 - node_filesystem_avail_bytes{${ROOT_FS}} / node_filesystem_size_bytes{${ROOT_FS}})`;
export const Q_DISK_FREE = `node_filesystem_avail_bytes{${ROOT_FS}}`;

/** Seconds since boot. */
export const Q_UPTIME = 'time() - node_boot_time_seconds';

// EVERY container, not topk. Ranking happens in the client, for two reasons:
//
//   1. `topk` in a RANGE query is evaluated at every timestamp, so a container
//      that was briefly in the top N appears in the result. topk(6) returned 7
//      distinct series over a 15m window, which made a "top 6" label false.
//   2. A row shows the metric it is ranked by AND its companion. With topk on
//      both queries, a container in the memory top 6 but not the CPU top 6 has
//      no CPU value to show, and the cell renders blank.
//
// The cost is small and bounded: one series per running container, and these are
// read at a coarse step because only the latest point is rendered.
export const qAllContainerCpu =
  'sum by (name) (rate(container_cpu_usage_seconds_total{name!=""}[2m]))';

export const qAllContainerMem =
  'sum by (name) (container_memory_working_set_bytes{name!=""})';

/** One named container's CPU, in cores. */

/** One named container's memory working set, in bytes. */

// Container names come from the Docker API, so they are [a-zA-Z0-9_.-] in
// practice - but they reach here as data, and a label matcher is a quoted
// string, so the quoting is done properly rather than assumed.
export function promQuote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ── formatting ───────────────────────────────────────────────────────────────

export function fmtPercent(v: number): string {
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}

/** Bytes per second, in the unit a network graph is actually read in. */
export function fmtRate(v: number): string {
  if (!Number.isFinite(v)) return '-';
  const u = ['B/s', 'kB/s', 'MB/s', 'GB/s'];
  let i = 0;
  let n = v;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i += 1; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function fmtCores(v: number): string {
  return v >= 0.1 ? `${v.toFixed(2)} cores` : `${(v * 1000).toFixed(0)} m`;
}

/** Bytes at rest - sizes, not rates. */
export function fmtSize(v: number): string {
  if (!Number.isFinite(v)) return '-';
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = v;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i += 1; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

/** A duration a human reads at a glance: "7.7d", "18h", "42m". */
export function fmtUptimeShort(seconds: number): string {
  if (!Number.isFinite(seconds)) return '-';
  const d = seconds / 86400;
  if (d >= 1) return `${d < 10 ? d.toFixed(1) : Math.round(d)}d`;
  const h = seconds / 3600;
  if (h >= 1) return `${Math.round(h)}h`;
  return `${Math.round(seconds / 60)}m`;
}

/** Clock time for an axis tick - the only thing the x-axis ever shows. */
export function fmtClock(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}
