// Small Grafana-style visualisation primitives, built from the data the portal
// already has. No chart library — these are a handful of divs and one SVG
// polyline, which keeps the bundle flat and the rendering exact.
//
// Rules they all follow (see index.css): status colours are RESERVED for status
// and never used as chrome; accents (--a1..--a6) are chrome and never encode
// state.

import type { ReactNode } from 'react';
import './viz.css';

// ── segmented status bar ─────────────────────────────────────────────────────
// Part-to-whole for a set of services. Preferred over a donut: it reads at any
// width, stacks honestly, and puts the segments in a fixed order so two bars can
// be compared by eye.
export interface Seg {
  key: string;
  n: number;
  label: string;
}
export function StatusBar({ segs, height = 8 }: { segs: Seg[]; height?: number }) {
  const total = segs.reduce((a, s) => a + s.n, 0);
  const parts = segs.filter((s) => s.n > 0);
  return (
    <div
      className="vz-bar"
      style={{ height }}
      role="img"
      aria-label={
        total
          ? parts.map((s) => `${s.n} ${s.label}`).join(', ')
          : 'no services'
      }
    >
      {total === 0 ? (
        <span className="vz-bar-seg is-empty" style={{ flex: 1 }} />
      ) : (
        parts.map((s) => (
          <span key={s.key} className={`vz-bar-seg seg-${s.key}`} style={{ flex: s.n }} title={`${s.n} ${s.label}`} />
        ))
      )}
    </div>
  );
}

// ── horizontal bar gauge ─────────────────────────────────────────────────────
// Comparison against the largest row, which is what makes "which of these is
// big?" answerable at a glance — a plain list of numbers is not.
export interface GaugeRow {
  key: string;
  label: ReactNode;
  value: number;
  display: string;
  sub?: string;
  accent?: string; // css var name, chrome only
  muted?: boolean;
  href?: string;
}
export function BarGauge({
  rows,
  max,
  renderRow,
}: {
  rows: GaugeRow[];
  max?: number;
  renderRow?: (r: GaugeRow, bar: ReactNode) => ReactNode;
}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="vz-gauge">
      {rows.map((r) => {
        const pct = Math.max(1.5, (r.value / top) * 100);
        const bar = (
          <span className="vz-gauge-track" aria-hidden="true">
            <span className="vz-gauge-fill" style={{ width: `${pct}%` }} />
          </span>
        );
        // the `sub` cell is ALWAYS emitted (empty when unused) so every row has
        // the same number of grid children — otherwise rows with no sub shift a
        // column and rows with one wrap onto a second line
        const body = (
          <>
            <span className="vz-gauge-label">{r.label}</span>
            {bar}
            <span className="vz-gauge-sub">{r.sub ?? ''}</span>
            <span className="vz-gauge-val">{r.display}</span>
          </>
        );
        const style = { ['--acc' as string]: `var(${r.accent ?? '--primary'})` } as React.CSSProperties;
        const cls = `vz-gauge-row ${r.muted ? 'is-muted' : ''}`;
        return renderRow ? (
          <div key={r.key} className={cls} style={style}>{renderRow(r, body)}</div>
        ) : (
          <div key={r.key} className={cls} style={style}>{body}</div>
        );
      })}
    </div>
  );
}

// ── sparkline ────────────────────────────────────────────────────────────────
// The ONLY real time series this app has: a rolling window of "services up",
// sampled once per poll and held for the session. It is deliberately small and
// unlabelled — it answers "has this been steady?" and nothing more.
export function Sparkline({
  points,
  width = 108,
  height = 26,
  label,
}: {
  points: number[];
  width?: number;
  height?: number;
  label?: string;
}) {
  if (points.length < 2) {
    return <span className="vz-spark-empty" title="Collecting — one sample per refresh">collecting…</span>;
  }
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  // a flat line should sit in the middle, not on the floor
  const span = hi - lo || 1;
  const pad = 2;
  const stepX = (width - pad * 2) / (points.length - 1);
  const y = (v: number) => pad + (1 - (v - lo) / span) * (height - pad * 2);
  const d = points.map((v, i) => `${pad + i * stepX},${y(v)}`).join(' ');
  const area = `${pad},${height - pad} ${d} ${pad + (points.length - 1) * stepX},${height - pad}`;
  const steady = hi === lo;
  return (
    <svg
      className={`vz-spark ${steady ? 'is-steady' : ''}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label ?? `${points[points.length - 1]} of a rolling window, ${points.length} samples`}
    >
      <polygon className="vz-spark-area" points={area} />
      <polyline className="vz-spark-line" points={d} />
      <circle className="vz-spark-dot" cx={pad + (points.length - 1) * stepX} cy={y(points[points.length - 1])} r={2.2} />
    </svg>
  );
}
