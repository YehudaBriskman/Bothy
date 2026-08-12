// A time-series chart, in SVG, with no chart library.
//
// The existing viz.tsx primitives were built on the same principle and it still
// holds: a line chart is a polyline and some text, and a charting library is
// ~40 KB of abstraction over that. What this adds over Sparkline is the parts
// that make a graph READABLE rather than decorative - a y-scale with labels, a
// time axis, a hover crosshair with a value readout, and direct end-labels.
//
// Rules it follows (see the design notes in index.css and the --chart-N block):
//   · ONE y-axis, always. Two measures of different scale get two charts. A
//     dual-axis chart lets the author choose where the lines cross, which means
//     the reader is looking at a decision, not at the data.
//   · Series take colour slots in array order and never cycle. Colour follows
//     the SERIES, so filtering one out never repaints the others.
//   · Every multi-series chart carries a legend AND direct end-labels: the
//     teal/amber pair in the validated palette sits inside the CVD floor band,
//     which is only legal with a second, non-colour encoding.
//   · Grid and axes recede; the data is the only thing at full contrast.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Sample, Series } from '../lib/metrics';
import { fmtClock } from '../lib/metrics';
import './TimeChart.css';

export interface ChartSeries extends Series {
  /** 1–5 → var(--chart-N). Assigned by the caller, in a stable order. */
  slot: number;
}

interface Props {
  series: ChartSeries[];
  /** Formats a y value everywhere it is printed: axis, readout, end-label. */
  format: (v: number) => string;
  height?: number;
  /** Pin the top of the scale - e.g. 100 for a percentage. */
  yMax?: number;
  /** Filled area under the line. Only honest for a single series. */
  area?: boolean;
  /** Accessible description; the chart is role="img" when not hovered. */
  label: string;
}

const PAD = { top: 10, right: 8, bottom: 18, left: 40 };

export function TimeChart({ series, format, height = 132, yMax, area, label }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const gradId = useId();

  // Width comes from the element, not from a media query: these sit in a grid
  // whose column count changes with the container, so a breakpoint would be
  // guessing at the width the chart actually got.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const next = Math.max(220, Math.floor(entry.contentRect.width));
      setW((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geom = useMemo(() => {
    const pts = series.flatMap((s) => s.points);
    if (!pts.length) return null;

    const t0 = Math.min(...pts.map((p) => p.t));
    const t1 = Math.max(...pts.map((p) => p.t));
    const vMaxData = Math.max(...pts.map((p) => p.v));
    // Never a zero-height scale, and always a little headroom so the peak is not
    // painted onto the top border.
    const top = yMax ?? (vMaxData <= 0 ? 1 : niceCeil(vMaxData * 1.12));
    const spanT = t1 - t0 || 1;

    const iw = Math.max(1, w - PAD.left - PAD.right);
    const ih = Math.max(1, height - PAD.top - PAD.bottom);
    const x = (t: number) => PAD.left + ((t - t0) / spanT) * iw;
    const y = (v: number) => PAD.top + (1 - Math.min(v, top) / top) * ih;

    return { t0, t1, top, x, y, iw, ih };
  }, [series, w, height, yMax]);

  if (!geom) {
    return (
      <div className="tc" ref={wrapRef}>
        <p className="tc-empty">No samples in this window.</p>
      </div>
    );
  }

  const { t0, t1, top, x, y, ih } = geom;
  const ticks = [0, top / 2, top];

  // The sample nearest the pointer, per series - one crosshair, N readouts.
  const hovered =
    hoverX == null
      ? null
      : (() => {
          const tAt = t0 + ((hoverX - PAD.left) / geom.iw) * (t1 - t0);
          const rows = series
            .map((s) => ({ s, p: nearest(s.points, tAt) }))
            .filter((r): r is { s: ChartSeries; p: Sample } => r.p != null);
          return rows.length ? { t: rows[0].p.t, rows } : null;
        })();

  return (
    <div className="tc" ref={wrapRef}>
      <svg
        className="tc-svg"
        width={w}
        height={height}
        viewBox={`0 0 ${w} ${height}`}
        role="img"
        aria-label={label}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - box.left;
          setHoverX(px >= PAD.left && px <= w - PAD.right ? px : null);
        }}
        onPointerLeave={() => setHoverX(null)}
      >
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`${gradId}-${s.slot}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={`var(--chart-${s.slot})`} stopOpacity="0.26" />
              <stop offset="100%" stopColor={`var(--chart-${s.slot})`} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {/* grid + y labels - recessive on purpose */}
        {ticks.map((v) => (
          <g key={v}>
            <line className="tc-grid" x1={PAD.left} x2={w - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="tc-ytick" x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end">
              {format(v)}
            </text>
          </g>
        ))}

        {/* x axis: the window's ends. Intermediate ticks would need collision
            handling for a 220px-wide chart and answer nothing extra. */}
        <text className="tc-xtick" x={PAD.left} y={height - 4}>{fmtClock(t0)}</text>
        <text className="tc-xtick" x={w - PAD.right} y={height - 4} textAnchor="end">{fmtClock(t1)}</text>

        {series.map((s) => {
          if (s.points.length < 2) return null;
          const d = s.points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
          const last = s.points[s.points.length - 1];
          return (
            <g key={s.key} style={{ ['--c' as string]: `var(--chart-${s.slot})` }}>
              {area && (
                <polygon
                  className="tc-area"
                  fill={`url(#${gradId}-${s.slot})`}
                  points={`${x(s.points[0].t).toFixed(1)},${PAD.top + ih} ${d} ${x(last.t).toFixed(1)},${PAD.top + ih}`}
                />
              )}
              <polyline className="tc-line" points={d} />
              {/* The direct end-label. This is the secondary encoding that lets
                  the palette's closest adjacent pair ship at all. */}
              <circle className="tc-dot" cx={x(last.t)} cy={y(last.v)} r="3" />
            </g>
          );
        })}

        {hovered && (
          <line
            className="tc-cross"
            x1={x(hovered.t)}
            x2={x(hovered.t)}
            y1={PAD.top}
            y2={PAD.top + ih}
          />
        )}
      </svg>

      {/* The readout is HTML, not SVG text: it wraps, it inherits the type
          scale, and it can be positioned without measuring glyphs. */}
      {hovered && (
        <div
          className="tc-readout"
          style={{ left: `${Math.min(Math.max(x(hovered.t), 60), w - 60)}px` }}
        >
          <span className="tc-readout-t">{fmtClock(hovered.t)}</span>
          {hovered.rows.map(({ s, p }) => (
            <span className="tc-readout-row" key={s.key}>
              <i className="tc-swatch" style={{ background: `var(--chart-${s.slot})` }} />
              {s.label}
              <b>{format(p.v)}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Legend. Always rendered for ≥2 series; a single series is named by its title. */
export function ChartLegend({ series, format }: { series: ChartSeries[]; format?: (v: number) => string }) {
  if (series.length < 2) return null;
  return (
    <div className="tc-legend">
      {series.map((s) => {
        const last = s.points[s.points.length - 1];
        return (
          <span className="tc-leg" key={s.key}>
            <i className="tc-swatch" style={{ background: `var(--chart-${s.slot})` }} />
            {s.label}
            {last && format && <b>{format(last.v)}</b>}
          </span>
        );
      })}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Round a scale top up to something a human would have chosen. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

/** Binary search would be overkill: these arrays are ≤ 240 points. */
function nearest(points: Sample[], t: number): Sample | null {
  let best: Sample | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = Math.abs(p.t - t);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}
