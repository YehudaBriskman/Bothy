// Small Grafana-style visualisation primitives, built from the data the portal
// already has. No chart library - these are a handful of divs and one SVG
// polyline, which keeps the bundle flat and the rendering exact.
//
// Rules they all follow (see index.css): status colours are RESERVED for status
// and never used as chrome; accents (--a1..--a5) are chrome and never encode
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

// `segs` are THE WHOLE - the denominator the bar is a part of. `aside` is for
// counts that exist but are outside that whole, drawn detached after a gap.
//
// This split fixes a real disagreement: the hero prints "15 / 22 services up",
// whose denominator excludes stopped services (expectedUp), while the bar
// underneath it was fed all five statuses including stopped. The two graphics
// sat 6px apart and claimed different totals - so a box with two idle projects
// showed a bar that looked two-thirds full beside a number that said 100%.
// Stopped services are still shown, but as what they are: not part of the
// measurement.
export function StatusBar({
  segs, aside = [], height = 8,
}: { segs: Seg[]; aside?: Seg[]; height?: number }) {
  const total = segs.reduce((a, s) => a + s.n, 0);
  const parts = segs.filter((s) => s.n > 0);
  const off = aside.filter((s) => s.n > 0);
  const label = [
    total ? parts.map((s) => `${s.n} ${s.label}`).join(', ') : 'no services',
    ...off.map((s) => `${s.n} ${s.label} (not counted)`),
  ].join(', ');

  return (
    <div className="vz-bar" style={{ height }} role="img" aria-label={label}>
      {total === 0 && off.length === 0 ? (
        <span className="vz-bar-seg is-empty" style={{ flex: 1 }} />
      ) : (
        parts.map((s) => (
          <span key={s.key} className={`vz-bar-seg seg-${s.key}`} style={{ flex: s.n }} title={`${s.n} ${s.label}`} />
        ))
      )}
      {off.map((s) => (
        <span
          key={s.key}
          className={`vz-bar-seg seg-${s.key} is-aside`}
          style={{ flex: s.n }}
          title={`${s.n} ${s.label} - switched off, not counted`}
        />
      ))}
    </div>
  );
}

// ── horizontal bar gauge ─────────────────────────────────────────────────────
// Comparison against the largest row, which is what makes "which of these is
// big?" answerable at a glance - a plain list of numbers is not.
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
        // the same number of grid children - otherwise rows with no sub shift a
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

// The sparkline is GONE (2026-08-10). It plotted `data.history`, a ring buffer
// of "services up" appended once per poll and held only for the session - so it
// read "collecting…" on every fresh load and could never answer "was the box
// busy an hour ago", because an hour ago the tab was not open. Real history
// arrived with the Prometheus route, and components/TimeChart.tsx supersedes it.
// The buffer that fed it was removed from lib/api.ts at the same time.
